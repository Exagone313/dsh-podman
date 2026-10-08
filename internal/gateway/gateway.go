// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// Package gateway implements the optional bridge that exposes a published pod
// port on the host loopback. It listens on a Unix socket in the shared socket
// root, binds 127.0.0.1:<port>, and forwards every connection to the socket the
// guest agent published.
//
// It is never a source of truth: bindings live only while an orchestrator holds
// a Lease stream open, so a host port cannot outlive the orchestrator that
// asked for it.
package gateway

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"net"
	"path/filepath"
	"regexp"
	"strconv"
	"sync"
	"time"

	gw "github.com/Exagone313/dsh-podman/internal/genproto/dshgateway/v1"
	"github.com/Exagone313/dsh-podman/internal/proxy"
	"github.com/Exagone313/dsh-podman/internal/version"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// loopbackAddress is the only address a published port is exposed on. It is a
// constant rather than configuration: the point of the gateway is that a guest
// port stays reachable from this host alone.
const loopbackAddress = "127.0.0.1"

// The range a caller may suggest. Below 1024 a rootless gateway cannot bind;
// 0 is not a suggestion but "choose one".
const (
	minHostPort = 1024
	maxHostPort = 65535
)

// podmanNamePattern matches the orchestrator's container names, so the
// container field cannot be used to walk out of the socket root.
var podmanNamePattern = regexp.MustCompile(`^dsh-podman-[a-z0-9][a-z0-9-]{0,90}$`)

// socketNamePattern matches the short deterministic names the guest agent
// derives, e.g. "t8080". It stays strict because the name is joined into a
// path.
var socketNamePattern = regexp.MustCompile(`^[a-z][0-9]{1,5}$`)

// maxUnixPath is the longest path connect(2) accepts on Linux.
const maxUnixPath = 107

type key struct {
	podmanName string
	socketName string
	protocol   gw.Protocol
}

type binding struct {
	address  string
	port     uint32
	listener net.Listener
}

// Server implements dshgateway.v1.Gateway.
type Server struct {
	gw.UnimplementedGatewayServer

	// SocketsRoot holds one directory per guest container.
	SocketsRoot string
	// DialTimeout bounds connecting to a published socket. Zero means 5s.
	DialTimeout time.Duration
	Logger      *slog.Logger

	mu       sync.Mutex
	bindings map[key]*binding
	leases   int

	instanceOnce sync.Once
	instanceID   string
}

func (s *Server) log() *slog.Logger {
	if s.Logger != nil {
		return s.Logger
	}
	return slog.Default()
}

func (s *Server) dialTimeout() time.Duration {
	if s.DialTimeout > 0 {
		return s.DialTimeout
	}
	return 5 * time.Second
}

// instance returns a random id generated once per process. A caller compares it
// across calls to tell a live gateway from a restarted one.
func (s *Server) instance() string {
	s.instanceOnce.Do(func() {
		buf := make([]byte, 8)
		if _, err := rand.Read(buf); err != nil {
			s.instanceID = "unknown"
			return
		}
		s.instanceID = hex.EncodeToString(buf)
	})
	return s.instanceID
}

func (s *Server) GetVersion(context.Context, *gw.GetVersionRequest) (*gw.GetVersionResponse, error) {
	return &gw.GetVersionResponse{Version: version.Version, Commit: version.Commit, Instance: s.instance()}, nil
}

// Bind exposes a published socket on the loopback and returns the address and
// port it chose. It is idempotent per (container, socket, protocol): a second
// Bind for the same target returns the same pair instead of moving the port.
func (s *Server) Bind(_ context.Context, req *gw.BindRequest) (*gw.BindResponse, error) {
	k, target, err := s.validate(req)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.leases == 0 {
		return nil, status.Error(codes.FailedPrecondition, "no lease is held; the orchestrator must keep a Lease stream open")
	}
	if existing, ok := s.bindings[k]; ok {
		return &gw.BindResponse{Address: existing.address, Port: existing.port}, nil
	}
	listener, err := net.Listen("tcp4", net.JoinHostPort(loopbackAddress, strconv.Itoa(int(req.GetSuggestedHostPort()))))
	if err != nil {
		return nil, status.Errorf(codes.FailedPrecondition, "bind %s:%d: %v", loopbackAddress, req.GetSuggestedHostPort(), err)
	}
	port, ok := listenerPort(listener)
	if !ok {
		_ = listener.Close()
		return nil, status.Error(codes.Internal, "the bound listener has no TCP port")
	}
	if s.bindings == nil {
		s.bindings = map[key]*binding{}
	}
	s.bindings[k] = &binding{address: loopbackAddress, port: port, listener: listener}
	go s.serve(listener, target)
	s.log().Info("published port bound", "podman_name", k.podmanName, "socket", k.socketName, "address", loopbackAddress, "port", port)
	return &gw.BindResponse{Address: loopbackAddress, Port: port}, nil
}

func (s *Server) Unbind(_ context.Context, req *gw.UnbindRequest) (*gw.UnbindResponse, error) {
	k := key{req.GetPodmanName(), req.GetSocketName(), req.GetProtocol()}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.unbindLocked(k)
	return &gw.UnbindResponse{}, nil
}

func (s *Server) List(context.Context, *gw.ListRequest) (*gw.ListResponse, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	response := &gw.ListResponse{}
	for k, b := range s.bindings {
		response.Bindings = append(response.Bindings, &gw.Binding{PodmanName: k.podmanName, SocketName: k.socketName, Protocol: k.protocol, Address: b.address, Port: b.port})
	}
	return response, nil
}

// Lease ties every binding to the caller's liveness. The orchestrator holds the
// stream open and pings it; when the stream ends, because the orchestrator
// stopped or crashed, every binding is released. Bindings are only accepted
// while at least one lease is open.
func (s *Server) Lease(stream gw.Gateway_LeaseServer) error {
	s.beginLease()
	defer s.endLease()
	for {
		if _, err := stream.Recv(); err != nil {
			return nil
		}
		if err := stream.Send(&gw.LeaseResponse{}); err != nil {
			return nil
		}
	}
}

func (s *Server) beginLease() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.leases++
	s.log().Info("gateway lease opened", "leases", s.leases)
}

func (s *Server) endLease() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.leases--
	if s.leases > 0 {
		return
	}
	for k := range s.bindings {
		s.unbindLocked(k)
	}
	s.log().Info("gateway lease closed; every published port released")
}

func (s *Server) unbindLocked(k key) {
	b, ok := s.bindings[k]
	if !ok {
		return
	}
	delete(s.bindings, k)
	_ = b.listener.Close()
	s.log().Info("published port unbound", "podman_name", k.podmanName, "socket", k.socketName)
}

// serve forwards every accepted connection to target until the listener is
// closed.
func (s *Server) serve(listener net.Listener, target string) {
	proxy.Serve(listener, func() (net.Conn, error) {
		dialer := net.Dialer{Timeout: s.dialTimeout()}
		return dialer.Dial("unix", target)
	}, func(err error) {
		s.log().Warn("published port forwarding failed", "error", err)
	})
}

// validate checks the request and returns the binding key and the socket path.
func (s *Server) validate(req *gw.BindRequest) (key, string, error) {
	k := key{req.GetPodmanName(), req.GetSocketName(), req.GetProtocol()}
	if !podmanNamePattern.MatchString(k.podmanName) {
		return key{}, "", status.Errorf(codes.InvalidArgument, "invalid container name %q", k.podmanName)
	}
	if !socketNamePattern.MatchString(k.socketName) {
		return key{}, "", status.Errorf(codes.InvalidArgument, "invalid socket name %q", k.socketName)
	}
	if k.protocol != gw.Protocol_PROTOCOL_TCP {
		return key{}, "", status.Errorf(codes.InvalidArgument, "protocol %s is not supported yet; only tcp is", k.protocol)
	}
	if suggested := req.GetSuggestedHostPort(); suggested != 0 && (suggested < minHostPort || suggested > maxHostPort) {
		return key{}, "", status.Errorf(codes.InvalidArgument, "suggested host port %d is outside %d..%d", suggested, minHostPort, maxHostPort)
	}
	target := filepath.Join(s.SocketsRoot, k.podmanName, k.socketName)
	if len(target) > maxUnixPath {
		return key{}, "", status.Errorf(codes.InvalidArgument, "socket path is %d bytes, over the %d-byte limit", len(target), maxUnixPath)
	}
	return k, target, nil
}

func listenerPort(listener net.Listener) (uint32, bool) {
	addr, ok := listener.Addr().(*net.TCPAddr)
	if !ok || addr.Port <= 0 {
		return 0, false
	}
	return uint32(addr.Port), true
}
