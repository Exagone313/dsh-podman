package main

import (
	"fmt"
	"net"
	"os"
	"path/filepath"

	"dsh-container-plugin/internal/agent/grpcserver"
	agent "dsh-container-plugin/internal/genproto/dshagent/v1"
	"google.golang.org/grpc"
)

const version = "0.1.0"

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--version" {
		fmt.Println(version)
		return
	}
	socket := os.Getenv("DSH_AGENT_SOCKET")
	if socket == "" {
		socket = "/run/dsh-sockets/agent.sock"
	}
	if err := os.MkdirAll(filepath.Dir(socket), 0700); err != nil {
		panic(err)
	}
	_ = os.Remove(socket)
	listener, err := net.Listen("unix", socket)
	if err != nil {
		panic(err)
	}
	server := grpc.NewServer()
	agent.RegisterWorkspaceAgentServer(server, grpcserver.New())
	if err := server.Serve(listener); err != nil {
		panic(err)
	}
}
