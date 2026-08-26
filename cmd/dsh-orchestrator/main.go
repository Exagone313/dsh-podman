package main

import (
	"context"
	"fmt"
	"net"
	"os"
	"path/filepath"

	"github.com/containers/podman/v5/pkg/bindings"
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
	socket := os.Getenv("DSH_CONTROL_SOCKET")
	if socket == "" {
		socket = "/run/dsh-sockets/control.sock"
	}
	root := os.Getenv("DSH_PROJECTS_ROOT")
	if root == "" {
		root = "/projects"
	}
	stateDir := os.Getenv("DSH_STATE_DIR")
	if stateDir == "" {
		stateDir = "/var/lib/dsh-orchestrator"
	}
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
	server := grpc.NewServer()
	var podmanClient *podman.Client
	var imageBuilder *images.Builder
	if socketPath := os.Getenv("CONTAINER_HOST"); socketPath != "" {
		podmanClient, err = podman.New(context.Background(), socketPath, filepath.Dir(socket), os.Getenv("DSH_AGENT_BINARY"))
		if err != nil {
			panic(err)
		}
		podmanContext, connectionErr := bindings.NewConnection(context.Background(), socketPath)
		if connectionErr != nil {
			panic(connectionErr)
		}
		imageBuilder = &images.Builder{Context: podmanContext, StateDir: stateDir}
	}
	ctl.RegisterOrchestratorControlServer(server, &grpcserver.Server{ProjectsRoot: root, Store: store, Podman: podmanClient, ImageBuilder: imageBuilder})
	if err := server.Serve(listener); err != nil {
		panic(err)
	}
}
