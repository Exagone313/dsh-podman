// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"strconv"
	"sync"
	"time"

	ctl "github.com/Exagone313/dsh-podman/internal/genproto/dshctl/v1"
	gw "github.com/Exagone313/dsh-podman/internal/genproto/dshgateway/v1"
	guest "github.com/Exagone313/dsh-podman/internal/genproto/dshguest/v1"
	"github.com/Exagone313/dsh-podman/internal/orchestrator/state"
	"github.com/Exagone313/dsh-podman/internal/version"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

const (
	// The host-port range a caller may suggest. Below 1024 a rootless gateway
	// cannot bind; 0 means "choose one".
	minHostPort = 1024
	maxHostPort = 65535
	// guestCallTimeout bounds a call to a container's guest agent.
	guestCallTimeout = 15 * time.Second
)

// gatewayRetryDelay bounds how quickly a gateway started later is noticed. It is
// a variable so tests can shorten the retry cadence.
var gatewayRetryDelay = 5 * time.Second

// gatewayAPI is the orchestrator's view of the optional gateway. The real
// client satisfies it; tests substitute a fake.
type gatewayAPI interface {
	GetVersion(ctx context.Context) (*gw.GetVersionResponse, error)
	Bind(ctx context.Context, podmanName, socketName string, protocol gw.Protocol, suggestedHostPort uint32) (*gw.BindResponse, error)
	Unbind(ctx context.Context, podmanName, socketName string, protocol gw.Protocol) error
	Lease(ctx context.Context, onReady func(context.Context) error) error
}

// GuestPorts publishes and unpublishes pod ports on a container's guest agent.
// The real implementation dials the agent's socket; tests substitute a fake.
type GuestPorts interface {
	Publish(ctx context.Context, record state.Container, protocol string, port uint32) (string, error)
	Unpublish(ctx context.Context, record state.Container, protocol string, port uint32)
}

// guestPorts returns the configured implementation, or the real one.
func (s *Server) guestPorts() GuestPorts {
	if s.GuestPorts != nil {
		return s.GuestPorts
	}
	return agentPorts{}
}

// agentPorts is the real GuestPorts: it dials the container's guest agent.
type agentPorts struct{}

// gatewayStatusCache is the last observed gateway state, written by the
// background loop and read by GetGatewayStatus, so the settings card never
// waits on a dial.
type gatewayStatusCache struct {
	mu       sync.Mutex
	state    ctl.GatewayState
	version  string
	commit   string
	instance string
	bindings uint32
}

var errGatewayUnavailable = status.Error(codes.FailedPrecondition, "the dsh-podman gateway is not configured")

// gatewayError turns a transport failure into an actionable message: the
// gateway is optional, so "not running" must read as a missing deployment, not
// as a broken request.
func gatewayError(err error) error {
	if status.Code(err) == codes.Unavailable {
		return status.Error(codes.FailedPrecondition, "the dsh-podman gateway is not running; install and start the gateway Quadlet to publish ports")
	}
	return err
}

// PublishPort exposes a pod port on the host. The guest agent creates a Unix
// socket that forwards to the port, the gateway binds a host address and port
// to that socket, and the pair is recorded on the container so it survives a
// recreate.
func (s *Server) PublishPort(ctx context.Context, request *ctl.PublishPortRequest) (*ctl.PublishedPort, error) {
	s.log().Info("control request", "method", "PublishPort", "workspace_slug", request.GetWorkspaceSlug(), "container", request.GetContainer(), "port", request.GetPort(), "protocol", request.GetProtocol())
	if s.Gateway == nil {
		return nil, errGatewayUnavailable
	}
	protocol, err := protocolName(request.GetProtocol())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}
	port := request.GetPort()
	if port == 0 || port > 65535 {
		return nil, status.Errorf(codes.InvalidArgument, "port %d is outside 1..65535", port)
	}
	suggested := request.GetSuggestedHostPort()
	if suggested != 0 && (suggested < minHostPort || suggested > maxHostPort) {
		return nil, status.Errorf(codes.InvalidArgument, "suggested host port %d is outside %d..%d", suggested, minHostPort, maxHostPort)
	}
	workspace, err := workspaceBySlug(s.Store, request.GetWorkspaceSlug())
	if err != nil {
		return nil, status.Error(codes.NotFound, err.Error())
	}
	record, ok := containerByLogical(&workspace, request.GetContainer())
	if !ok {
		return nil, containerNotFoundError(request.GetContainer(), request.GetWorkspaceSlug())
	}
	for _, existing := range record.PublishedPorts {
		if existing.Protocol == protocol && existing.Port == int(port) {
			return publishedPortProto(*record, existing), nil
		}
	}
	socketName, err := s.guestPorts().Publish(ctx, *record, protocol, port)
	if err != nil {
		return nil, err
	}
	entry := state.PublishedPort{Protocol: protocol, Port: int(port), SocketName: socketName}
	address, hostPort, err := s.gatewayBind(ctx, *record, entry, suggested)
	if err != nil {
		// Do not leave a forwarding socket behind for a port the store has no
		// record of.
		s.guestPorts().Unpublish(ctx, *record, protocol, port)
		return nil, err
	}
	entry.Address = address
	entry.HostPort = int(hostPort)
	record.PublishedPorts = append(record.PublishedPorts, entry)
	if _, err := s.upsertContainer(workspace, *record); err != nil {
		s.gatewayUnbind(ctx, *record, entry)
		s.guestPorts().Unpublish(ctx, *record, protocol, port)
		return nil, status.Error(codes.Internal, err.Error())
	}
	s.log().Info("control request completed", "method", "PublishPort", "container", record.Name, "endpoint", publishedEndpoint(entry))
	return publishedPortProto(*record, entry), nil
}

// UnpublishPort releases a published port. Unpublishing a port that is not
// published is a no-op, so a cleanup can call it blindly.
func (s *Server) UnpublishPort(ctx context.Context, request *ctl.UnpublishPortRequest) (*ctl.UnpublishPortResponse, error) {
	s.log().Info("control request", "method", "UnpublishPort", "workspace_slug", request.GetWorkspaceSlug(), "container", request.GetContainer(), "port", request.GetPort(), "protocol", request.GetProtocol())
	protocol, err := protocolName(request.GetProtocol())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}
	workspace, err := workspaceBySlug(s.Store, request.GetWorkspaceSlug())
	if err != nil {
		return nil, status.Error(codes.NotFound, err.Error())
	}
	record, ok := containerByLogical(&workspace, request.GetContainer())
	if !ok {
		return nil, containerNotFoundError(request.GetContainer(), request.GetWorkspaceSlug())
	}
	var released *state.PublishedPort
	remaining := make([]state.PublishedPort, 0, len(record.PublishedPorts))
	for i := range record.PublishedPorts {
		if record.PublishedPorts[i].Protocol == protocol && record.PublishedPorts[i].Port == int(request.GetPort()) {
			released = &record.PublishedPorts[i]
			continue
		}
		remaining = append(remaining, record.PublishedPorts[i])
	}
	if released == nil {
		return &ctl.UnpublishPortResponse{}, nil
	}
	s.gatewayUnbind(ctx, *record, *released)
	s.guestPorts().Unpublish(ctx, *record, protocol, uint32(released.Port))
	record.PublishedPorts = remaining
	if _, err := s.upsertContainer(workspace, *record); err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	s.log().Info("control request completed", "method", "UnpublishPort", "container", record.Name, "port", released.Port)
	return &ctl.UnpublishPortResponse{}, nil
}

func (s *Server) ListPublishedPorts(_ context.Context, request *ctl.ListPublishedPortsRequest) (*ctl.ListPublishedPortsResponse, error) {
	workspace, err := workspaceBySlug(s.Store, request.GetWorkspaceSlug())
	if err != nil {
		return nil, status.Error(codes.NotFound, err.Error())
	}
	response := &ctl.ListPublishedPortsResponse{}
	for _, record := range workspace.Containers {
		for _, port := range record.PublishedPorts {
			response.PublishedPorts = append(response.PublishedPorts, publishedPortProto(record, port))
		}
	}
	return response, nil
}

// GetGatewayStatus reports the cached gateway state. It never dials, so the
// settings card renders instantly even when the gateway is absent.
func (s *Server) GetGatewayStatus(context.Context, *ctl.GetGatewayStatusRequest) (*ctl.GetGatewayStatusResponse, error) {
	s.gatewayStatus.mu.Lock()
	defer s.gatewayStatus.mu.Unlock()
	return &ctl.GetGatewayStatusResponse{
		State:    s.gatewayStatus.state,
		Version:  s.gatewayStatus.version,
		Commit:   s.gatewayStatus.commit,
		Instance: s.gatewayStatus.instance,
		Bindings: s.gatewayStatus.bindings,
	}, nil
}

// StartGatewayLoop keeps the optional gateway's lease and cached status fresh.
// It returns immediately when no gateway client is configured.
func (s *Server) StartGatewayLoop(ctx context.Context) {
	if s.Gateway == nil {
		return
	}
	go s.gatewayLoop(ctx)
}

// gatewayLoop keeps a session open and reports an outage once instead of on
// every retry: the gateway is optional, so its absence must not fill the journal
// nor make a serving orchestrator look stuck.
func (s *Server) gatewayLoop(ctx context.Context) {
	warned := false
	for {
		err := s.gatewaySession(ctx, func() {
			// The lease is up: say so once, and only to close an outage this
			// loop reported, so a healthy start stays silent.
			if warned {
				s.log().Info("dsh-podman gateway reachable; port publishing is available")
				warned = false
			}
		})
		if err != nil && ctx.Err() == nil && !warned {
			s.log().Warn("the dsh-podman gateway is not running; port publishing is unavailable", "error", err)
			warned = true
		}
		s.setGatewayStatus(ctl.GatewayState_GATEWAY_STATE_ABSENT, "", "", "", 0)
		select {
		case <-ctx.Done():
			return
		case <-time.After(gatewayRetryDelay):
		}
	}
}

// gatewaySession connects, re-establishes the persisted ports under a fresh
// lease, and holds that lease until the gateway goes away. onEstablished runs
// once the gateway has accepted the lease, which is the moment an outage is
// over. The lease is what owns the host ports, so losing it releases them and
// the next session re-binds them from the store.
func (s *Server) gatewaySession(ctx context.Context, onEstablished func()) error {
	info, err := s.Gateway.GetVersion(ctx)
	if err != nil {
		s.setGatewayStatus(ctl.GatewayState_GATEWAY_STATE_ABSENT, "", "", "", 0)
		return fmt.Errorf("gateway is not reachable: %w", err)
	}
	if version.Core(version.Version) != "" && (version.Core(info.GetVersion()) == "" || version.Major(info.GetVersion()) != version.Major(version.Version)) {
		s.setGatewayStatus(ctl.GatewayState_GATEWAY_STATE_INCOMPATIBLE, info.GetVersion(), info.GetCommit(), info.GetInstance(), 0)
		return fmt.Errorf("gateway %s is incompatible with orchestrator %s", info.GetVersion(), version.Version)
	}
	return s.Gateway.Lease(ctx, func(leaseCtx context.Context) error {
		if onEstablished != nil {
			onEstablished()
		}
		s.setGatewayStatus(ctl.GatewayState_GATEWAY_STATE_RUNNING, info.GetVersion(), info.GetCommit(), info.GetInstance(), 0)
		return s.rebindAllPublishedPorts(leaseCtx)
	})
}

// rebindAllPublishedPorts re-establishes every persisted published port, and
// caches how many host ports the gateway now holds.
func (s *Server) rebindAllPublishedPorts(ctx context.Context) error {
	workspaces, err := s.Store.Workspaces()
	if err != nil {
		return err
	}
	var bindings uint32
	var firstErr error
	for i := range workspaces {
		for j := range workspaces[i].Containers {
			record := &workspaces[i].Containers[j]
			if len(record.PublishedPorts) == 0 {
				continue
			}
			if err := s.reestablishPublishedPorts(ctx, *record); err != nil {
				s.log().Warn("could not re-establish published ports", "container", record.Name, "error", err)
				if firstErr == nil {
					firstErr = err
				}
				continue
			}
			bindings += uint32(len(record.PublishedPorts))
		}
	}
	s.setGatewayBindings(bindings)
	return firstErr
}

// reestablishPublishedPorts re-creates a container's forwarding socket and its
// host binding. Both steps are idempotent, which is what keeps a host port
// stable across a container recreate and a gateway restart.
func (s *Server) reestablishPublishedPorts(ctx context.Context, record state.Container) error {
	if len(record.PublishedPorts) == 0 {
		return nil
	}
	var firstErr error
	for _, port := range record.PublishedPorts {
		socketName, err := s.guestPorts().Publish(ctx, record, port.Protocol, uint32(port.Port))
		if err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		if socketName != port.SocketName {
			if firstErr == nil {
				firstErr = fmt.Errorf("guest agent returned socket %q for port %d, want %q", socketName, port.Port, port.SocketName)
			}
			continue
		}
		if _, _, err := s.gatewayBind(ctx, record, port, uint32(port.HostPort)); err != nil {
			if firstErr == nil {
				firstErr = err
			}
		}
	}
	return firstErr
}

// releasePublishedPorts drops a container's host ports. Its guest sockets die
// with the container, so only the gateway bindings have to go.
func (s *Server) releasePublishedPorts(ctx context.Context, record state.Container) {
	for _, port := range record.PublishedPorts {
		s.gatewayUnbind(ctx, record, port)
	}
}

// restorePublishedPorts re-establishes a container's published ports, retrying
// while a freshly started guest agent comes up. It runs off the request path
// because a create holds the project-mount lock and the agent is not
// necessarily listening yet.
func (s *Server) restorePublishedPorts(record state.Container) {
	if len(record.PublishedPorts) == 0 || s.Gateway == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	var err error
	for attempt := 0; attempt < 10; attempt++ {
		if err = s.reestablishPublishedPorts(ctx, record); err == nil {
			return
		}
		select {
		case <-ctx.Done():
			s.log().Warn("could not re-establish published ports", "container", record.Name, "error", err)
			return
		case <-time.After(300 * time.Millisecond):
		}
	}
	s.log().Warn("could not re-establish published ports", "container", record.Name, "error", err)
}

func (s *Server) gatewayBind(ctx context.Context, record state.Container, port state.PublishedPort, suggestedHostPort uint32) (string, uint32, error) {
	if s.Gateway == nil {
		return "", 0, errGatewayUnavailable
	}
	protocol, err := gatewayProtocol(port.Protocol)
	if err != nil {
		return "", 0, status.Error(codes.InvalidArgument, err.Error())
	}
	response, err := s.Gateway.Bind(ctx, record.PodmanName, port.SocketName, protocol, suggestedHostPort)
	if err != nil {
		return "", 0, gatewayError(err)
	}
	return response.GetAddress(), response.GetPort(), nil
}

func (s *Server) gatewayUnbind(ctx context.Context, record state.Container, port state.PublishedPort) {
	if s.Gateway == nil {
		return
	}
	protocol, err := gatewayProtocol(port.Protocol)
	if err != nil {
		return
	}
	if err := s.Gateway.Unbind(ctx, record.PodmanName, port.SocketName, protocol); err != nil {
		s.log().Warn("could not unbind a published port", "container", record.Name, "port", port.Port, "error", err)
	}
}

func (s *Server) setGatewayStatus(gatewayState ctl.GatewayState, versionValue, commit, instance string, bindings uint32) {
	s.gatewayStatus.mu.Lock()
	defer s.gatewayStatus.mu.Unlock()
	s.gatewayStatus.state = gatewayState
	s.gatewayStatus.version = versionValue
	s.gatewayStatus.commit = commit
	s.gatewayStatus.instance = instance
	s.gatewayStatus.bindings = bindings
}

func (s *Server) setGatewayBindings(bindings uint32) {
	s.gatewayStatus.mu.Lock()
	defer s.gatewayStatus.mu.Unlock()
	s.gatewayStatus.bindings = bindings
}

// publishedPortProto rebuilds the control-plane view of one published port.
func publishedPortProto(record state.Container, port state.PublishedPort) *ctl.PublishedPort {
	return &ctl.PublishedPort{
		Container: record.Name,
		Protocol:  protocolToProto(port.Protocol),
		Port:      uint32(port.Port),
		Address:   port.Address,
		HostPort:  uint32(port.HostPort),
		Endpoint:  publishedEndpoint(port),
	}
}

// publishedEndpoint is the address string a caller shows the user. The scheme
// comes from the protocol, so a later udp or http publish reads correctly
// without changing the shape.
func publishedEndpoint(port state.PublishedPort) string {
	return port.Protocol + "://" + net.JoinHostPort(port.Address, strconv.Itoa(port.HostPort))
}

func protocolName(protocol ctl.Protocol) (string, error) {
	if protocol == ctl.Protocol_PROTOCOL_TCP {
		return "tcp", nil
	}
	return "", fmt.Errorf("protocol %s is not supported yet; only tcp is", protocol)
}

func protocolToProto(name string) ctl.Protocol {
	if name == "tcp" {
		return ctl.Protocol_PROTOCOL_TCP
	}
	return ctl.Protocol_PROTOCOL_UNSPECIFIED
}

func gatewayProtocol(name string) (gw.Protocol, error) {
	if name == "tcp" {
		return gw.Protocol_PROTOCOL_TCP, nil
	}
	return gw.Protocol_PROTOCOL_UNSPECIFIED, fmt.Errorf("protocol %q is not supported yet; only tcp is", name)
}

func guestProtocol(name string) (guest.Protocol, error) {
	if name == "tcp" {
		return guest.Protocol_PROTOCOL_TCP, nil
	}
	return guest.Protocol_PROTOCOL_UNSPECIFIED, fmt.Errorf("protocol %q is not supported yet; only tcp is", name)
}

// guestClient dials a container's guest agent. The caller closes the
// connection.
func guestClient(record state.Container) (*grpc.ClientConn, guest.WorkspaceGuestAgentClient, error) {
	conn, err := grpc.NewClient("unix://"+record.AgentSocketPath, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return nil, nil, err
	}
	return conn, guest.NewWorkspaceGuestAgentClient(conn), nil
}

// Publish asks a container's guest agent to forward a pod port over a Unix
// socket, and returns the socket file name.
func (agentPorts) Publish(ctx context.Context, record state.Container, protocol string, port uint32) (string, error) {
	if record.AgentSocketPath == "" || record.AgentToken == "" {
		return "", status.Error(codes.FailedPrecondition, "the container has no guest agent socket; recreate the container")
	}
	guestProto, err := guestProtocol(protocol)
	if err != nil {
		return "", status.Error(codes.InvalidArgument, err.Error())
	}
	conn, client, err := guestClient(record)
	if err != nil {
		return "", grpcError(err)
	}
	defer conn.Close()
	callCtx, cancel := context.WithTimeout(ctx, guestCallTimeout)
	defer cancel()
	callCtx = metadata.AppendToOutgoingContext(callCtx, "authorization", "bearer "+record.AgentToken)
	response, err := client.PublishPort(callCtx, &guest.PublishPortRequest{Port: port, Protocol: guestProto})
	if err != nil {
		if status.Code(err) == codes.Unimplemented {
			return "", status.Error(codes.FailedPrecondition, "the container's guest agent does not support port publishing; recreate the container")
		}
		return "", grpcError(err)
	}
	return response.GetSocketName(), nil
}

// Unpublish asks a container's guest agent to stop forwarding a pod port. It
// never fails the caller: the container may already be gone.
func (agentPorts) Unpublish(ctx context.Context, record state.Container, protocol string, port uint32) {
	if record.AgentSocketPath == "" || record.AgentToken == "" {
		return
	}
	guestProto, err := guestProtocol(protocol)
	if err != nil {
		return
	}
	conn, client, err := guestClient(record)
	if err != nil {
		return
	}
	defer conn.Close()
	callCtx, cancel := context.WithTimeout(ctx, guestCallTimeout)
	defer cancel()
	callCtx = metadata.AppendToOutgoingContext(callCtx, "authorization", "bearer "+record.AgentToken)
	if _, err := client.UnpublishPort(callCtx, &guest.UnpublishPortRequest{Port: port, Protocol: guestProto}); err != nil {
		slog.Warn("could not unpublish a pod port", "container", record.Name, "port", port, "error", err)
	}
}
