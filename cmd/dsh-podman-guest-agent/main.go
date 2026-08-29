// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package main

import (
	"fmt"
	"log/slog"
	"net"
	"os"
	"path/filepath"

	"gitlab.com/Exagone313/dsh-podman/internal/auth"
	workspacefs "gitlab.com/Exagone313/dsh-podman/internal/guestagent/fs"
	"gitlab.com/Exagone313/dsh-podman/internal/guestagent/grpcserver"
	guest "gitlab.com/Exagone313/dsh-podman/internal/genproto/dshguest/v1"
	"google.golang.org/grpc"
)

const version = "0.1.0"

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--version" {
		fmt.Println(version)
		return
	}
	socket := os.Getenv("DSH_PODMAN_GUEST_SOCKET")
	if socket == "" {
		panic("DSH_PODMAN_GUEST_SOCKET is required")
	}
	token := os.Getenv("DSH_PODMAN_GUEST_TOKEN")
	root := os.Getenv("DSH_PODMAN_PROJECTS_ROOT")
	if root == "" {
		root = "/projects"
	}
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)
	logger.Info("guest agent starting", "socket", socket, "workspace_root", root, "token_configured", token != "")
	if err := os.MkdirAll(filepath.Dir(socket), 0700); err != nil {
		panic(err)
	}
	_ = os.Remove(socket)
	listener, err := net.Listen("unix", socket)
	if err != nil {
		panic(err)
	}
	filesystem, err := workspacefs.New([]workspacefs.Mount{{Virtual: root, Host: root}})
	if err != nil {
		panic(err)
	}
	server := grpc.NewServer(grpc.UnaryInterceptor(auth.Unary(token)), grpc.StreamInterceptor(auth.Stream(token)))
	guest.RegisterWorkspaceGuestAgentServer(server, grpcserver.New().WithFS(filesystem))
	logger.Info("guest agent listening", "socket", socket)
	if err := server.Serve(listener); err != nil {
		panic(err)
	}
}
