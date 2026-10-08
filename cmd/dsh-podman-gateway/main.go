// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package main

import (
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/Exagone313/dsh-podman/internal/auth"
	"github.com/Exagone313/dsh-podman/internal/gateway"
	gw "github.com/Exagone313/dsh-podman/internal/genproto/dshgateway/v1"
	"github.com/Exagone313/dsh-podman/internal/grpclog"
	"github.com/Exagone313/dsh-podman/internal/grpcopts"
	"github.com/Exagone313/dsh-podman/internal/recovery"
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
	socketsRoot := getenv("DSH_PODMAN_GATEWAY_SOCKETS_ROOT", "/run/dsh-podman")
	socket := getenv("DSH_PODMAN_GATEWAY_SOCKET", filepath.Join(socketsRoot, "gateway.sock"))
	token := getenv("DSH_PODMAN_GATEWAY_TOKEN", "")
	// The published sockets live under this root and are readable by whoever
	// can reach the directory, so it must stay private to its owner.
	if err := socketpkg.RequirePrivateDir(socketsRoot); err != nil {
		panic(err)
	}
	listener, err := socketpkg.Listen(socket)
	if err != nil {
		panic(err)
	}
	socketpkg.Relax()
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	logger.Info("dsh-podman-gateway starting", "socket", socket, "sockets_root", socketsRoot, "version", version.Version, "commit", version.Commit)
	// Authentication runs first so a rejected call is never logged as a
	// request; the orchestrator version check runs next, so an incompatible
	// orchestrator is refused before any handler sees it; recovery runs
	// innermost, closest to the handler it protects.
	unary := []grpc.UnaryServerInterceptor{}
	stream := []grpc.StreamServerInterceptor{}
	if token != "" {
		logger.Info("gateway authentication enabled")
		unary = append(unary, auth.Unary(token))
		stream = append(stream, auth.Stream(token))
	} else {
		logger.Warn("gateway authentication is disabled; set DSH_PODMAN_GATEWAY_TOKEN")
	}
	unary = append(unary, gateway.UnaryVersion(logger), grpclog.Sanitize(), grpclog.Unary(logger), recovery.Unary(logger))
	stream = append(stream, gateway.StreamVersion(logger), grpclog.Stream(logger), recovery.Stream(logger))
	server := grpc.NewServer(
		grpc.ChainUnaryInterceptor(unary...),
		grpc.ChainStreamInterceptor(stream...),
		grpcopts.KeepalivePolicy(),
	)
	gw.RegisterGatewayServer(server, &gateway.Server{SocketsRoot: socketsRoot, Logger: logger})
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, os.Interrupt)
	go func() {
		sig := <-sigCh
		logger.Info("received signal, stopping", "signal", sig.String())
		// Every binding dies with the process, so a hard stop is enough. A
		// graceful stop would instead wait for the orchestrator's Lease stream,
		// which never ends on its own.
		server.Stop()
	}()
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
