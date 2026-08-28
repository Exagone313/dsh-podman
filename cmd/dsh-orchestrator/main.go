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
	ctl "gitlab.com/Exagone313/dsh-podman/internal/genproto/dshctl/v1"
	"gitlab.com/Exagone313/dsh-podman/internal/orchestrator/grpcserver"
	"gitlab.com/Exagone313/dsh-podman/internal/orchestrator/images"
	"gitlab.com/Exagone313/dsh-podman/internal/orchestrator/podman"
	"gitlab.com/Exagone313/dsh-podman/internal/orchestrator/state"
	"google.golang.org/grpc"
)

const version = "0.1.0"

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--version" {
		fmt.Println(version)
		return
	}
	socketsRoot := getenv("DSH_ORCH_SOCKETS_ROOT", "/run/dsh-sockets")
	socket := filepath.Join(socketsRoot, "control.sock")
	root := getenv("DSH_ORCH_PROJECTS_ROOT", "/projects")
	stateDir := getenv("DSH_ORCH_STATE", "/var/lib/dsh-orchestrator")
	hostProjectsRoot := getenv("DSH_ORCH_HOST_PROJECTS_ROOT", root)
	hostSocketsRoot := getenv("DSH_ORCH_HOST_SOCKETS_ROOT", socketsRoot)
	agentBinary := getenv("DSH_ORCH_AGENT_BIN", "")
	hostAgentBinary := getenv("DSH_ORCH_HOST_AGENT_BIN", agentBinary)
	hostPacmanCache := getenv("DSH_ORCH_HOST_PACMAN_CACHE", "")
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
	podmanSocket := os.Getenv("DSH_ORCH_PODMAN_SOCKET")
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
		podmanClient, err = podman.New(context.Background(), podmanSocket, socketsRoot, agentBinary, hostSocketsRoot, root, hostAgentBinary, logger)
		if err != nil {
			panic(fmt.Errorf("initialize Podman client: %w", err))
		}
		imageBuilder = &images.Builder{Context: podmanContext, StateDir: stateDir, HostPacmanCache: hostPacmanCache, Logger: logger}
	} else {
		_, orchSocketSet := os.LookupEnv("DSH_ORCH_PODMAN_SOCKET")
		logger.Error("Podman API configuration is missing", "DSH_ORCH_PODMAN_SOCKET_present", orchSocketSet, "expected", "DSH_ORCH_PODMAN_SOCKET=unix:///run/podman/podman.sock")
		panic("Podman API is not configured: DSH_ORCH_PODMAN_SOCKET is absent or empty")
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
