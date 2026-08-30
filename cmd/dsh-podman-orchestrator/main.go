// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package main

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/containers/podman/v5/pkg/bindings"
	"github.com/containers/podman/v5/pkg/bindings/system"
	"github.com/Exagone313/dsh-podman/internal/auth"
	ctl "github.com/Exagone313/dsh-podman/internal/genproto/dshctl/v1"
	"github.com/Exagone313/dsh-podman/internal/orchestrator/grpcserver"
	"github.com/Exagone313/dsh-podman/internal/orchestrator/images"
	"github.com/Exagone313/dsh-podman/internal/orchestrator/podman"
	"github.com/Exagone313/dsh-podman/internal/orchestrator/state"
	"google.golang.org/grpc"
)

const version = "0.1.0"

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--version" {
		fmt.Println(version)
		return
	}
	socketsRoot := getenv("DSH_PODMAN_SOCKETS_ROOT", "/run/dsh-podman")
	socket := filepath.Join(socketsRoot, "orchestrator.sock")
	root := getenv("DSH_PODMAN_PROJECTS_ROOT", "/projects")
	stateDir := getenv("DSH_PODMAN_ORCHESTRATOR_STATE", "/var/lib/dsh-orchestrator")
	hostProjectsRoot := getenv("DSH_PODMAN_HOST_PROJECTS_ROOT", root)
	hostSocketsRoot := getenv("DSH_PODMAN_HOST_SOCKETS_ROOT", socketsRoot)
	guestBinary := getenv("DSH_PODMAN_GUEST_AGENT_BIN", "dsh-podman-guest-agent")
	hostGuestBinary := getenv("DSH_PODMAN_HOST_GUEST_AGENT_BIN", "")
	hostPacmanCache := getenv("DSH_PODMAN_HOST_PACMAN_CACHE", "")
	hostAptCache := getenv("DSH_PODMAN_HOST_APT_CACHE", "")
	hostApkCache := getenv("DSH_PODMAN_HOST_APK_CACHE", "")
	controlToken := getenv("DSH_PODMAN_ORCHESTRATOR_TOKEN", "")
	if err := requireDirectory(filepath.Dir(socket)); err != nil {
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
	if err := os.Chmod(socket, 0600); err != nil {
		panic(err)
	}
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	var server *grpc.Server
	if controlToken != "" {
		logger.Info("control-plane authentication enabled")
		server = grpc.NewServer(grpc.ChainUnaryInterceptor(auth.Unary(controlToken), grpcserver.UnaryLogger(logger)))
	} else {
		logger.Warn("control-plane authentication is disabled; set DSH_PODMAN_ORCHESTRATOR_TOKEN")
		server = grpc.NewServer(grpc.UnaryInterceptor(grpcserver.UnaryLogger(logger)))
	}
	var podmanClient *podman.Client
	var imageBuilder *images.Builder
	podmanSocket := os.Getenv("DSH_PODMAN_ORCHESTRATOR_PODMAN_SOCKET")
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
		podmanClient, err = podman.New(context.Background(), podmanSocket, socketsRoot, guestBinary, hostSocketsRoot, root, hostGuestBinary, logger)
		if err != nil {
			panic(fmt.Errorf("initialize Podman client: %w", err))
		}
		imageBuilder = &images.Builder{Context: podmanContext, StateDir: stateDir, HostPacmanCache: hostPacmanCache, HostAptCache: hostAptCache, HostApkCache: hostApkCache, GuestAgentImage: images.GuestAgentImage{
			Image:        getenv("DSH_PODMAN_GUEST_AGENT_IMAGE", ""),
			AgentBin:     getenv("DSH_PODMAN_GUEST_AGENT_IMAGE_AGENT_BIN", "/bin/dsh-podman-guest-agent"),
			DestAgentBin: getenv("DSH_PODMAN_GUEST_AGENT_IMAGE_DEST_AGENT_BIN", "/usr/local/bin/dsh-podman-guest-agent"),
		}, ImagePrefix: getenv("DSH_PODMAN_IMAGE_PREFIX", "localhost/dsh-podman/"), BaseImagePrefix: getenv("DSH_PODMAN_BASE_IMAGE_PREFIX", "localhost/dsh-podman/base/"), Logger: logger}
	} else {
		_, orchSocketSet := os.LookupEnv("DSH_PODMAN_ORCHESTRATOR_PODMAN_SOCKET")
		logger.Error("Podman API configuration is missing", "DSH_PODMAN_ORCHESTRATOR_PODMAN_SOCKET_present", orchSocketSet, "expected", "DSH_PODMAN_ORCHESTRATOR_PODMAN_SOCKET=unix:///run/podman/podman.sock")
		panic("Podman API is not configured: DSH_PODMAN_ORCHESTRATOR_PODMAN_SOCKET is absent or empty")
	}
	controlServer := &grpcserver.Server{ProjectsRoot: root, HostProjectsRoot: hostProjectsRoot, SocketsRoot: socketsRoot, Store: store, Podman: podmanClient, ImageBuilder: imageBuilder, BaseImagePrefix: getenv("DSH_PODMAN_BASE_IMAGE_PREFIX", "localhost/dsh-podman/base/"), VolumePrefix: getenv("DSH_PODMAN_VOLUME_PREFIX", "dsh-podman-"), SecretPrefix: getenv("DSH_PODMAN_SECRET_PREFIX", "dsh-podman-"), Logger: logger}
	ctl.RegisterOrchestratorControlServer(server, controlServer)
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGTERM, os.Interrupt)
	go func() {
		sig := <-sigCh
		logger.Info("received signal, stopping container daemons", "signal", sig.String())
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		controlServer.StopAllContainerDaemons(ctx)
		cancel()
		logger.Info("graceful control-plane shutdown")
		server.GracefulStop()
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

func requireDirectory(dir string) error {
	info, err := os.Stat(dir)
	if err != nil {
		return fmt.Errorf("socket root %q is not accessible: %w", dir, err)
	}
	if !info.IsDir() {
		return fmt.Errorf("socket root %q is not a directory", dir)
	}
	return nil
}
