// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package gateway

import (
	"context"
	"io"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	gw "github.com/Exagone313/dsh-podman/internal/genproto/dshgateway/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

const testContainer = "dsh-podman-11111111-1111-1111-1111-111111111111-dev"

// fakeLease drives the Lease stream without a transport.
type fakeLease struct {
	grpc.ServerStream
	requests chan *gw.LeaseRequest
}

func (f *fakeLease) Send(*gw.LeaseResponse) error { return nil }
func (f *fakeLease) Recv() (*gw.LeaseRequest, error) {
	if _, ok := <-f.requests; !ok {
		return nil, io.EOF
	}
	return &gw.LeaseRequest{}, nil
}

// openLease starts a lease and returns a function that ends it.
func openLease(t *testing.T, s *Server) func() {
	t.Helper()
	lease := &fakeLease{requests: make(chan *gw.LeaseRequest)}
	done := make(chan struct{})
	go func() {
		defer close(done)
		_ = s.Lease(lease)
	}()
	var once sync.Once
	closeLease := func() {
		once.Do(func() {
			close(lease.requests)
			<-done
		})
	}
	t.Cleanup(closeLease)
	waitFor(t, func() bool {
		s.mu.Lock()
		defer s.mu.Unlock()
		return s.leases == 1
	})
	return closeLease
}

func waitFor(t *testing.T, done func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if done() {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("condition not reached in time")
}

func newTestServer(t *testing.T) (*Server, string) {
	t.Helper()
	// A short root: the container directory plus the socket name must stay
	// inside the Unix path limit.
	root, err := os.MkdirTemp("", "gw")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(root) })
	return &Server{SocketsRoot: root, Logger: slog.New(slog.NewTextHandler(io.Discard, nil))}, root
}

// publishEcho creates the Unix socket a guest agent would publish, answering
// with what it receives.
func publishEcho(t *testing.T, root, socketName string) {
	t.Helper()
	dir := filepath.Join(root, testContainer)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("unix", filepath.Join(dir, socketName))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	go func() {
		for {
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			go func() {
				defer conn.Close()
				_, _ = io.Copy(conn, conn)
			}()
		}
	}()
}

func bindRequest(socketName string, protocol gw.Protocol, suggested uint32) *gw.BindRequest {
	return &gw.BindRequest{PodmanName: testContainer, SocketName: socketName, Protocol: protocol, SuggestedHostPort: suggested}
}

func TestBindRequiresALease(t *testing.T) {
	server, _ := newTestServer(t)
	if _, err := server.Bind(context.Background(), bindRequest("t8080", gw.Protocol_PROTOCOL_TCP, 0)); status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("expected FailedPrecondition without a lease, got %v", err)
	}
}

func TestBindIsIdempotentAndLoopbackOnly(t *testing.T) {
	server, root := newTestServer(t)
	publishEcho(t, root, "t8080")
	openLease(t, server)
	first, err := server.Bind(context.Background(), bindRequest("t8080", gw.Protocol_PROTOCOL_TCP, 0))
	if err != nil {
		t.Fatal(err)
	}
	if first.GetAddress() != "127.0.0.1" {
		t.Fatalf("address = %q, want loopback only", first.GetAddress())
	}
	second, err := server.Bind(context.Background(), bindRequest("t8080", gw.Protocol_PROTOCOL_TCP, 0))
	if err != nil {
		t.Fatal(err)
	}
	if second.GetPort() != first.GetPort() {
		t.Fatalf("rebind moved the port: %d then %d", first.GetPort(), second.GetPort())
	}
}

func TestBindHonoursASuggestedPort(t *testing.T) {
	server, root := newTestServer(t)
	publishEcho(t, root, "t8080")
	publishEcho(t, root, "t8081")
	openLease(t, server)
	first, err := server.Bind(context.Background(), bindRequest("t8080", gw.Protocol_PROTOCOL_TCP, 0))
	if err != nil {
		t.Fatal(err)
	}
	if first.GetPort() < minHostPort {
		t.Fatalf("port = %d, want >= %d", first.GetPort(), minHostPort)
	}
	if _, err := server.Unbind(context.Background(), &gw.UnbindRequest{PodmanName: testContainer, SocketName: "t8080", Protocol: gw.Protocol_PROTOCOL_TCP}); err != nil {
		t.Fatal(err)
	}
	second, err := server.Bind(context.Background(), bindRequest("t8081", gw.Protocol_PROTOCOL_TCP, first.GetPort()))
	if err != nil {
		t.Fatal(err)
	}
	if second.GetPort() != first.GetPort() {
		t.Fatalf("suggested port %d was not honoured: got %d", first.GetPort(), second.GetPort())
	}
}

func TestBindRejectsUnsupportedRequests(t *testing.T) {
	server, _ := newTestServer(t)
	openLease(t, server)
	cases := map[string]*gw.BindRequest{
		"non-tcp protocol": {PodmanName: testContainer, SocketName: "u53", Protocol: gw.Protocol_PROTOCOL_UDP},
		"unspecified protocol": {
			PodmanName: testContainer, SocketName: "t80", Protocol: gw.Protocol_PROTOCOL_UNSPECIFIED,
		},
		"escaping container": {PodmanName: "../etc", SocketName: "t80", Protocol: gw.Protocol_PROTOCOL_TCP},
		"separator in socket name": {
			PodmanName: testContainer, SocketName: "../x", Protocol: gw.Protocol_PROTOCOL_TCP,
		},
		"ports below the rootless range": bindRequest("t80", gw.Protocol_PROTOCOL_TCP, 80),
		"ports above the range":          bindRequest("t80", gw.Protocol_PROTOCOL_TCP, 70000),
	}
	for name, request := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := server.Bind(context.Background(), request); status.Code(err) != codes.InvalidArgument {
				t.Fatalf("expected InvalidArgument, got %v", err)
			}
		})
	}
}

func TestBindForwardsToThePublishedSocket(t *testing.T) {
	server, root := newTestServer(t)
	publishEcho(t, root, "t8080")
	openLease(t, server)
	response, err := server.Bind(context.Background(), bindRequest("t8080", gw.Protocol_PROTOCOL_TCP, 0))
	if err != nil {
		t.Fatal(err)
	}
	conn, err := net.Dial("tcp", net.JoinHostPort(response.GetAddress(), strconv.Itoa(int(response.GetPort()))))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	if _, err := conn.Write([]byte("hello")); err != nil {
		t.Fatal(err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	buf := make([]byte, len("hello"))
	if _, err := io.ReadFull(conn, buf); err != nil {
		t.Fatal(err)
	}
	if string(buf) != "hello" {
		t.Fatalf("echoed %q, want hello", buf)
	}
}

func TestEndingTheLeaseReleasesEveryPort(t *testing.T) {
	server, root := newTestServer(t)
	publishEcho(t, root, "t8080")
	closeLease := openLease(t, server)
	response, err := server.Bind(context.Background(), bindRequest("t8080", gw.Protocol_PROTOCOL_TCP, 0))
	if err != nil {
		t.Fatal(err)
	}
	closeLease()
	waitFor(t, func() bool {
		server.mu.Lock()
		defer server.mu.Unlock()
		return len(server.bindings) == 0
	})
	// The released port must be free again: rebinding it succeeds.
	listener, err := net.Listen("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(int(response.GetPort()))))
	if err != nil {
		t.Fatalf("port %d was not released: %v", response.GetPort(), err)
	}
	_ = listener.Close()
}

func TestUnbindReleasesOnePort(t *testing.T) {
	server, root := newTestServer(t)
	publishEcho(t, root, "t8080")
	openLease(t, server)
	if _, err := server.Bind(context.Background(), bindRequest("t8080", gw.Protocol_PROTOCOL_TCP, 0)); err != nil {
		t.Fatal(err)
	}
	if _, err := server.Unbind(context.Background(), &gw.UnbindRequest{PodmanName: testContainer, SocketName: "t8080", Protocol: gw.Protocol_PROTOCOL_TCP}); err != nil {
		t.Fatal(err)
	}
	list, err := server.List(context.Background(), &gw.ListRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if len(list.GetBindings()) != 0 {
		t.Fatalf("bindings = %d after Unbind, want 0", len(list.GetBindings()))
	}
}

// TestBindReportsTheSocketPathLimit covers a misconfigured socket root: the
// name patterns allow a path that connect(2) would still reject, so the
// gateway refuses it with an actionable error instead of dialing forever.
func TestBindReportsTheSocketPathLimit(t *testing.T) {
	server := &Server{
		SocketsRoot: "/" + strings.Repeat("x", 120),
		Logger:      slog.New(slog.NewTextHandler(io.Discard, nil)),
	}
	openLease(t, server)
	if _, err := server.Bind(context.Background(), bindRequest("t8080", gw.Protocol_PROTOCOL_TCP, 0)); status.Code(err) != codes.InvalidArgument {
		t.Fatalf("expected InvalidArgument for an over-long socket path, got %v", err)
	}
}
