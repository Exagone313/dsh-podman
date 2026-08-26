package main

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"os"
	"path/filepath"

	"github.com/containers/podman/v5/pkg/bindings"
	"github.com/containers/podman/v5/pkg/bindings/system"
	ctl "gitlab.com/Exagone313/dsh-container-plugin/internal/genproto/dshctl/v1"
	"gitlab.com/Exagone313/dsh-container-plugin/internal/orchestrator/grpcserver"
	"gitlab.com/Exagone313/dsh-container-plugin/internal/orchestrator/images"
	"gitlab.com/Exagone313/dsh-container-plugin/internal/orchestrator/podman"
	"gitlab.com/Exagone313/dsh-container-plugin/internal/orchestrator/state"
	"google.golang.org/grpc"
)

const version = "0.1.0"

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--version" {
		fmt.Println(version)
		return
	}
	socketsRoot := getenv("DSH_ORCH_SOCKETS_ROOT", "/run/dsh-sockets")
	socket := getenv("DSH_CONTROL_SOCKET", filepath.Join(socketsRoot, "control.sock"))
	root := getenv("DSH_ORCH_PROJECTS_ROOT", getenv("DSH_PROJECTS_ROOT", "/projects"))
	stateDir := getenv("DSH_ORCH_STATE", getenv("DSH_STATE_DIR", "/var/lib/dsh-orchestrator"))
	hostProjectsRoot := getenv("DSH_ORCH_HOST_PROJECTS_ROOT", root)
	hostSocketsRoot := getenv("DSH_ORCH_HOST_SOCKETS_ROOT", socketsRoot)
	agentBinary := getenv("DSH_ORCH_AGENT_BIN", "")
	hostAgentBinary := getenv("DSH_ORCH_HOST_AGENT_BIN", agentBinary)
	if err := os.MkdirAll(filepath.Dir(socket), 0700); err != nil {
		panic(err)
	}
	_ = os.Remove(socket)
	store, err := state.New(stateDir)
	if err != nil {
		panic(err)
	}
	listener, err := net.Listen("unix", socket)
	if err != nil {
		panic(err)
	}
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	server := grpc.NewServer(grpc.UnaryInterceptor(grpcserver.UnaryLogger(logger)))
	var podmanClient *podman.Client
	var imageBuilder *images.Builder
	podmanSocket := os.Getenv("DSH_PODMAN_SOCKET")
	if podmanSocket == "" {
		podmanSocket = os.Getenv("CONTAINER_HOST")
	}
	if podmanSocket != "" {
		logger.Info("Podman API configured", "socket", podmanSocket)
		podmanContext, connectionErr := bindings.NewConnection(context.Background(), podmanSocket)
		if connectionErr != nil {
			panic(fmt.Errorf("connect to Podman API: %w", connectionErr))
		}
		if _, connectionErr = system.Info(podmanContext, nil); connectionErr != nil {
			panic(fmt.Errorf("Podman API is unreachable: %w", connectionErr))
		}
		logger.Info("Podman API reachable", "socket", podmanSocket)
		podmanClient, err = podman.New(context.Background(), podmanSocket, socketsRoot, agentBinary, hostSocketsRoot, hostAgentBinary)
		if err != nil {
			panic(fmt.Errorf("initialize Podman client: %w", err))
		}
		imageBuilder = &images.Builder{Context: podmanContext, StateDir: stateDir}
	} else {
		panic("Podman API is not configured: set DSH_ORCH_PODMAN_SOCKET")
	}
	ctl.RegisterOrchestratorControlServer(server, &grpcserver.Server{ProjectsRoot: root, HostProjectsRoot: hostProjectsRoot, SocketsRoot: socketsRoot, Store: store, Podman: podmanClient, ImageBuilder: imageBuilder, Logger: logger})
	if err := server.Serve(listener); err != nil {
		panic(err)
	}
}

func getenv(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
