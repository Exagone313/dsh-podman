// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package main

import (
	"fmt"
	"log/slog"
	"os"

	"github.com/Exagone313/dsh-podman/internal/auth"
	guest "github.com/Exagone313/dsh-podman/internal/genproto/dshguest/v1"
	workspacefs "github.com/Exagone313/dsh-podman/internal/guestagent/fs"
	"github.com/Exagone313/dsh-podman/internal/guestagent/grpcserver"
	socketpkg "github.com/Exagone313/dsh-podman/internal/socket"
	"github.com/Exagone313/dsh-podman/internal/version"
	"google.golang.org/grpc"
)

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--version" {
		fmt.Printf("%s (commit %s)\n", version.Version, version.Commit)
		return
	}
	socketpkg.Restrict()
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
	logger.Info("guest agent starting", "socket", socket, "workspace_root", root, "token_configured", token != "", "version", version.Version, "commit", version.Commit)
	listener, err := socketpkg.Listen(socket)
	if err != nil {
		panic(err)
	}
	filesystem, err := workspacefs.New([]workspacefs.Mount{{Virtual: root, Host: root}})
	if err != nil {
		panic(err)
	}
	server := grpc.NewServer(
		grpc.ChainUnaryInterceptor(auth.Unary(token), grpcserver.RecoveryUnary(logger)),
		grpc.ChainStreamInterceptor(auth.Stream(token), grpcserver.RecoveryStream(logger)),
	)
	guest.RegisterWorkspaceGuestAgentServer(server, grpcserver.New().WithFS(filesystem))
	logger.Info("guest agent listening", "socket", socket)
	if err := server.Serve(listener); err != nil {
		panic(err)
	}
}
