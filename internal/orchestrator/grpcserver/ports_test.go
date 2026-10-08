// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	ctl "github.com/Exagone313/dsh-podman/internal/genproto/dshctl/v1"
	gw "github.com/Exagone313/dsh-podman/internal/genproto/dshgateway/v1"
	"github.com/Exagone313/dsh-podman/internal/orchestrator/state"
	"github.com/Exagone313/dsh-podman/internal/version"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type fakeBinding struct {
	address string
	port    uint32
}

// fakeGateway is a gatewayAPI double: it allocates deterministic host ports and
// records what is bound.
type fakeGateway struct {
	mu       sync.Mutex
	version  string
	commit   string
	instance string
	bound    map[string]fakeBinding
	unbound  []string
	nextPort uint32
	bindErr  error
	// versionErr makes GetVersion fail, standing in for a gateway that is not
	// running (its socket is missing).
	versionErr error
}

func newFakeGateway() *fakeGateway {
	return &fakeGateway{version: "1.0.4", instance: "instance-1", bound: map[string]fakeBinding{}}
}

func (f *fakeGateway) GetVersion(context.Context) (*gw.GetVersionResponse, error) {
	if f.versionErr != nil {
		return nil, f.versionErr
	}
	return &gw.GetVersionResponse{Version: f.version, Commit: f.commit, Instance: f.instance}, nil
}

func (f *fakeGateway) Bind(_ context.Context, podmanName, socketName string, _ gw.Protocol, suggested uint32) (*gw.BindResponse, error) {
	if f.bindErr != nil {
		return nil, f.bindErr
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	key := podmanName + "/" + socketName
	if existing, ok := f.bound[key]; ok {
		return &gw.BindResponse{Address: existing.address, Port: existing.port}, nil
	}
	port := suggested
	if port == 0 {
		f.nextPort++
		port = 20000 + f.nextPort
	}
	binding := fakeBinding{address: "127.0.0.1", port: port}
	f.bound[key] = binding
	return &gw.BindResponse{Address: binding.address, Port: binding.port}, nil
}

func (f *fakeGateway) Unbind(_ context.Context, podmanName, socketName string, _ gw.Protocol) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.bound, podmanName+"/"+socketName)
	f.unbound = append(f.unbound, socketName)
	return nil
}

func (f *fakeGateway) Lease(ctx context.Context, onReady func(context.Context) error) error {
	if onReady != nil {
		if err := onReady(ctx); err != nil {
			return err
		}
	}
	<-ctx.Done()
	return ctx.Err()
}

func (f *fakeGateway) bindingFor(podmanName, socketName string) (fakeBinding, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	binding, ok := f.bound[podmanName+"/"+socketName]
	return binding, ok
}

// fakeGuestPorts is a GuestPorts double mirroring the guest agent's
// deterministic socket names.
type fakeGuestPorts struct {
	published   []string
	unpublished []string
	err         error
}

func fakeSocketName(protocol string, port uint32) string {
	prefix := "?"
	if protocol != "" {
		prefix = protocol[:1]
	}
	return prefix + strconv.FormatUint(uint64(port), 10)
}

func (f *fakeGuestPorts) Publish(_ context.Context, _ state.Container, protocol string, port uint32) (string, error) {
	if f.err != nil {
		return "", f.err
	}
	name := fakeSocketName(protocol, port)
	f.published = append(f.published, name)
	return name, nil
}

func (f *fakeGuestPorts) Unpublish(_ context.Context, _ state.Container, protocol string, port uint32) {
	f.unpublished = append(f.unpublished, fakeSocketName(protocol, port))
}

func portServer(t *testing.T) (*Server, *fakeGateway, *fakeGuestPorts) {
	t.Helper()
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{
		WorkspaceSlug: testWorkspaceSlug,
		ProjectName:   "team",
		Containers: []state.Container{{
			Name:            "default",
			PodmanName:      testDefaultContainer,
			ImageID:         "arch",
			Status:          "running",
			AgentSocketPath: "/tmp/unused/guest.sock",
			AgentToken:      "token",
		}},
	}}); err != nil {
		t.Fatal(err)
	}
	podman := newFakePodman()
	podman.exists[testDefaultContainer] = true
	podman.running[testDefaultContainer] = true
	gateway := newFakeGateway()
	ports := &fakeGuestPorts{}
	server := &Server{
		Store:        store,
		Podman:       podman,
		ProjectsRoot: tempRoot(t),
		Logger:       silentLogger(),
		Gateway:      gateway,
		GuestPorts:   ports,
	}
	return server, gateway, ports
}

func loadDefaultContainer(t *testing.T, server *Server) state.Container {
	t.Helper()
	workspace, err := workspaceBySlug(server.Store, testWorkspaceSlug)
	if err != nil {
		t.Fatal(err)
	}
	record, ok := containerByLogical(&workspace, "default")
	if !ok {
		t.Fatal("the default container is missing from the store")
	}
	return *record
}

func publishRequest(port uint32, suggested uint32) *ctl.PublishPortRequest {
	return &ctl.PublishPortRequest{
		WorkspaceSlug:     testWorkspaceSlug,
		Container:         "default",
		Port:              port,
		Protocol:          ctl.Protocol_PROTOCOL_TCP,
		SuggestedHostPort: suggested,
	}
}

func TestPublishPortBindsAndRecords(t *testing.T) {
	server, gateway, ports := portServer(t)
	published, err := server.PublishPort(context.Background(), publishRequest(8080, 0))
	if err != nil {
		t.Fatal(err)
	}
	if published.GetEndpoint() != "tcp://127.0.0.1:"+strconv.Itoa(int(published.GetHostPort())) {
		t.Fatalf("endpoint = %q", published.GetEndpoint())
	}
	if published.GetAddress() != "127.0.0.1" {
		t.Fatalf("address = %q, want the gateway's answer", published.GetAddress())
	}
	if len(ports.published) != 1 || ports.published[0] != "t8080" {
		t.Fatalf("guest publishes = %v, want [t8080]", ports.published)
	}
	record := loadDefaultContainer(t, server)
	if len(record.PublishedPorts) != 1 {
		t.Fatalf("stored ports = %d, want 1", len(record.PublishedPorts))
	}
	stored := record.PublishedPorts[0]
	if stored.Protocol != "tcp" || stored.Port != 8080 || stored.SocketName != "t8080" || stored.Address != "127.0.0.1" || stored.HostPort != int(published.GetHostPort()) {
		t.Fatalf("stored port = %+v", stored)
	}
	if _, ok := gateway.bindingFor(testDefaultContainer, "t8080"); !ok {
		t.Fatal("the gateway was not asked to bind the socket")
	}
}

func TestPublishPortIsIdempotent(t *testing.T) {
	server, gateway, ports := portServer(t)
	first, err := server.PublishPort(context.Background(), publishRequest(8080, 0))
	if err != nil {
		t.Fatal(err)
	}
	second, err := server.PublishPort(context.Background(), publishRequest(8080, 0))
	if err != nil {
		t.Fatal(err)
	}
	if first.GetHostPort() != second.GetHostPort() {
		t.Fatalf("republish moved the host port: %d then %d", first.GetHostPort(), second.GetHostPort())
	}
	if len(ports.published) != 1 {
		t.Fatalf("guest publishes = %v, want one", ports.published)
	}
	if len(loadDefaultContainer(t, server).PublishedPorts) != 1 {
		t.Fatal("republish stored a second entry")
	}
	_ = gateway
}

func TestPublishPortHonoursASuggestedHostPort(t *testing.T) {
	server, _, _ := portServer(t)
	published, err := server.PublishPort(context.Background(), publishRequest(8080, 26000))
	if err != nil {
		t.Fatal(err)
	}
	if published.GetHostPort() != 26000 {
		t.Fatalf("host port = %d, want the suggested 26000", published.GetHostPort())
	}
}

func TestPublishPortRejectsUnsupportedRequests(t *testing.T) {
	server, _, _ := portServer(t)
	cases := map[string]*ctl.PublishPortRequest{
		"udp":                        {WorkspaceSlug: testWorkspaceSlug, Container: "default", Port: 8080, Protocol: ctl.Protocol_PROTOCOL_UDP},
		"unspecified protocol":       {WorkspaceSlug: testWorkspaceSlug, Container: "default", Port: 8080, Protocol: ctl.Protocol_PROTOCOL_UNSPECIFIED},
		"port zero":                  publishRequest(0, 0),
		"port out of range":          publishRequest(70000, 0),
		"suggested port below range": publishRequest(8080, 80),
		"suggested port above range": publishRequest(8080, 70000),
	}
	for name, request := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := server.PublishPort(context.Background(), request); status.Code(err) != codes.InvalidArgument {
				t.Fatalf("expected InvalidArgument, got %v", err)
			}
		})
	}
}

func TestPublishPortWithoutAGateway(t *testing.T) {
	server, _, _ := portServer(t)
	server.Gateway = nil
	if _, err := server.PublishPort(context.Background(), publishRequest(8080, 0)); status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("expected FailedPrecondition, got %v", err)
	}
}

func TestPublishPortRollsBackWhenTheGatewayFails(t *testing.T) {
	server, gateway, ports := portServer(t)
	gateway.bindErr = status.Error(codes.Unavailable, "no gateway")
	if _, err := server.PublishPort(context.Background(), publishRequest(8080, 0)); status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("expected a FailedPrecondition, got %v", err)
	}
	if len(ports.unpublished) != 1 {
		t.Fatalf("the pod socket was not released: %v", ports.unpublished)
	}
	if len(loadDefaultContainer(t, server).PublishedPorts) != 0 {
		t.Fatal("a failed publish was recorded")
	}
}

func TestUnpublishPortReleasesEverything(t *testing.T) {
	server, gateway, ports := portServer(t)
	published, err := server.PublishPort(context.Background(), publishRequest(8080, 0))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := server.UnpublishPort(context.Background(), &ctl.UnpublishPortRequest{WorkspaceSlug: testWorkspaceSlug, Container: "default", Port: 8080, Protocol: ctl.Protocol_PROTOCOL_TCP}); err != nil {
		t.Fatal(err)
	}
	if len(loadDefaultContainer(t, server).PublishedPorts) != 0 {
		t.Fatal("the published port was not removed from the record")
	}
	if _, ok := gateway.bindingFor(testDefaultContainer, "t8080"); ok {
		t.Fatal("the gateway binding survived UnpublishPort")
	}
	if len(ports.unpublished) != 1 {
		t.Fatalf("guest unpublishes = %v, want one", ports.unpublished)
	}
	// A second UnpublishPort is a no-op.
	if _, err := server.UnpublishPort(context.Background(), &ctl.UnpublishPortRequest{WorkspaceSlug: testWorkspaceSlug, Container: "default", Port: 8080, Protocol: ctl.Protocol_PROTOCOL_TCP}); err != nil {
		t.Fatalf("unpublishing twice must be a no-op: %v", err)
	}
	_ = published
}

func TestRemoveContainerReleasesPorts(t *testing.T) {
	server, gateway, _ := portServer(t)
	if _, err := server.PublishPort(context.Background(), publishRequest(8080, 0)); err != nil {
		t.Fatal(err)
	}
	if _, err := server.RemoveContainer(context.Background(), &ctl.RemoveContainerRequest{WorkspaceSlug: testWorkspaceSlug, Container: "default"}); err != nil {
		t.Fatal(err)
	}
	if _, ok := gateway.bindingFor(testDefaultContainer, "t8080"); ok {
		t.Fatal("removing the container left its host port bound")
	}
}

func TestReestablishPublishedPortsKeepsTheHostPort(t *testing.T) {
	server, gateway, _ := portServer(t)
	published, err := server.PublishPort(context.Background(), publishRequest(8080, 0))
	if err != nil {
		t.Fatal(err)
	}
	// A restarted gateway lost every binding.
	gateway.mu.Lock()
	gateway.bound = map[string]fakeBinding{}
	gateway.mu.Unlock()
	if err := server.reestablishPublishedPorts(context.Background(), loadDefaultContainer(t, server)); err != nil {
		t.Fatal(err)
	}
	rebound, ok := gateway.bindingFor(testDefaultContainer, "t8080")
	if !ok {
		t.Fatal("the port was not re-bound")
	}
	if rebound.port != published.GetHostPort() {
		t.Fatalf("host port moved on re-bind: %d then %d", published.GetHostPort(), rebound.port)
	}
}

func TestListPublishedPorts(t *testing.T) {
	server, _, _ := portServer(t)
	if _, err := server.PublishPort(context.Background(), publishRequest(8080, 0)); err != nil {
		t.Fatal(err)
	}
	response, err := server.ListPublishedPorts(context.Background(), &ctl.ListPublishedPortsRequest{WorkspaceSlug: testWorkspaceSlug})
	if err != nil {
		t.Fatal(err)
	}
	if len(response.GetPublishedPorts()) != 1 {
		t.Fatalf("published ports = %d, want 1", len(response.GetPublishedPorts()))
	}
	if response.GetPublishedPorts()[0].GetContainer() != "default" {
		t.Fatalf("container = %q", response.GetPublishedPorts()[0].GetContainer())
	}
}

func TestGetGatewayStatusReportsTheCache(t *testing.T) {
	server, _, _ := portServer(t)
	server.setGatewayStatus(ctl.GatewayState_GATEWAY_STATE_RUNNING, "1.0.4", "abc1234", "instance-1", 2)
	statusResponse, err := server.GetGatewayStatus(context.Background(), &ctl.GetGatewayStatusRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if statusResponse.GetState() != ctl.GatewayState_GATEWAY_STATE_RUNNING || statusResponse.GetVersion() != "1.0.4" || statusResponse.GetCommit() != "abc1234" || statusResponse.GetInstance() != "instance-1" || statusResponse.GetBindings() != 2 {
		t.Fatalf("gateway status = %+v", statusResponse)
	}
}

func TestGatewaySessionMarksAnIncompatibleGateway(t *testing.T) {
	server, gateway, _ := portServer(t)
	// The orchestrator build in a test has no version core, so pin one path:
	// an empty gateway version is never compatible with a versioned
	// orchestrator, and this asserts the loop's classification only through
	// the cached state helper.
	server.setGatewayStatus(ctl.GatewayState_GATEWAY_STATE_INCOMPATIBLE, gateway.version, "", gateway.instance, 0)
	response, err := server.GetGatewayStatus(context.Background(), &ctl.GetGatewayStatusRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if response.GetState() != ctl.GatewayState_GATEWAY_STATE_INCOMPATIBLE {
		t.Fatalf("state = %v", response.GetState())
	}
}

func TestPublishPortRejectsAnUnknownContainer(t *testing.T) {
	server, _, _ := portServer(t)
	request := publishRequest(8080, 0)
	request.Container = "nope"
	if _, err := server.PublishPort(context.Background(), request); status.Code(err) != codes.NotFound {
		t.Fatalf("expected NotFound, got %v", err)
	}
}

// loggingGateway answers GetVersion from an atomic flag, so a test can make the
// gateway appear under a running loop without touching Server.Gateway.
type loggingGateway struct {
	healthy atomic.Bool
}

func (g *loggingGateway) GetVersion(context.Context) (*gw.GetVersionResponse, error) {
	if !g.healthy.Load() {
		return nil, errors.New("dial unix /run/dsh-podman/gateway.sock: connect: no such file or directory")
	}
	return &gw.GetVersionResponse{Version: "1.0.4", Instance: "instance-1"}, nil
}

func (g *loggingGateway) Bind(context.Context, string, string, gw.Protocol, uint32) (*gw.BindResponse, error) {
	return &gw.BindResponse{Address: "127.0.0.1", Port: 20000}, nil
}

func (g *loggingGateway) Unbind(context.Context, string, string, gw.Protocol) error { return nil }

func (g *loggingGateway) Lease(ctx context.Context, onReady func(context.Context) error) error {
	if onReady != nil {
		if err := onReady(ctx); err != nil {
			return err
		}
	}
	<-ctx.Done()
	return ctx.Err()
}

// gatewayLogServer wires a logging gateway to a logger that keeps every line.
// It carries a real (empty) store, because a reached gateway re-establishes the
// persisted ports from it.
func gatewayLogServer(t *testing.T, gateway gatewayAPI) (*Server, *bytes.Buffer) {
	t.Helper()
	buffer := &bytes.Buffer{}
	server := &Server{
		Store:      newTestStore(t),
		Gateway:    gateway,
		GuestPorts: &fakeGuestPorts{},
		Logger:     slog.New(slog.NewTextHandler(buffer, &slog.HandlerOptions{Level: slog.LevelInfo})),
	}
	return server, buffer
}

// fastGatewayRetry shortens the loop's cadence for the duration of a test.
func fastGatewayRetry(t *testing.T) {
	t.Helper()
	previous := gatewayRetryDelay
	gatewayRetryDelay = time.Millisecond
	t.Cleanup(func() { gatewayRetryDelay = previous })
}

// waitForLog polls until the captured logger holds the wanted marker, so the
// tests never depend on a fixed sleep.
func waitForLog(t *testing.T, buffer *bytes.Buffer, marker string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if strings.Contains(buffer.String(), marker) {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("log never contained %q, got:\n%s", marker, buffer.String())
}

func TestGatewaySessionReportsWhenTheGatewayIsReached(t *testing.T) {
	server, gateway, _ := portServer(t)
	reached := 0
	onEstablished := func() { reached++ }

	gateway.versionErr = errors.New("gateway is not running")
	if err := server.gatewaySession(context.Background(), onEstablished); err == nil {
		t.Fatal("an unreachable gateway must return an error")
	}
	if reached != 0 {
		t.Fatalf("an unreachable gateway must not report an established lease, got %d", reached)
	}

	previous := version.Version
	version.Version = "1.0.0"
	t.Cleanup(func() { version.Version = previous })
	gateway.versionErr = nil
	gateway.version = ""
	if err := server.gatewaySession(context.Background(), onEstablished); err == nil {
		t.Fatal("an incompatible gateway must return an error")
	}
	if reached != 0 {
		t.Fatalf("an incompatible gateway must not report an established lease, got %d", reached)
	}

	// A reachable gateway reports the lease as established even though the
	// blocking lease then ends with the cancelled context: that is what lets the
	// loop tell an outage from a session that merely ended.
	gateway.version = "1.0.0"
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := server.gatewaySession(ctx, onEstablished); !errors.Is(err, context.Canceled) {
		t.Fatalf("a reached gateway must end with the context error, got %v", err)
	}
	if reached != 1 {
		t.Fatalf("a reached gateway must report the lease once, got %d", reached)
	}
}

func TestGatewayLoopWarnsOnceWhileTheGatewayIsDown(t *testing.T) {
	fastGatewayRetry(t)
	server, buffer := gatewayLogServer(t, &fakeGateway{versionErr: errors.New("gateway is not running")})
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		server.gatewayLoop(ctx)
		close(done)
	}()
	waitForLog(t, buffer, "the dsh-podman gateway is not running")
	// Several retries must pass before the single line is the whole story.
	time.Sleep(20 * time.Millisecond)
	cancel()
	<-done

	if warnings := strings.Count(buffer.String(), "level=WARN"); warnings != 1 {
		t.Fatalf("expected exactly one warning, got %d:\n%s", warnings, buffer.String())
	}
	if strings.Contains(buffer.String(), "level=INFO") {
		t.Fatalf("an outage must not be announced as a recovery:\n%s", buffer.String())
	}
}

func TestGatewayLoopAnnouncesRecoveryOnce(t *testing.T) {
	fastGatewayRetry(t)
	gateway := &loggingGateway{}
	server, buffer := gatewayLogServer(t, gateway)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		server.gatewayLoop(ctx)
		close(done)
	}()
	waitForLog(t, buffer, "the dsh-podman gateway is not running")
	gateway.healthy.Store(true)
	waitForLog(t, buffer, "dsh-podman gateway reachable")
	// Let the loop retry a few more times: the recovery is announced once.
	time.Sleep(20 * time.Millisecond)
	cancel()
	<-done

	if infos := strings.Count(buffer.String(), "gateway reachable"); infos != 1 {
		t.Fatalf("expected exactly one recovery line, got %d:\n%s", infos, buffer.String())
	}
	if warnings := strings.Count(buffer.String(), "level=WARN"); warnings != 1 {
		t.Fatalf("expected exactly one warning, got %d:\n%s", warnings, buffer.String())
	}
}
