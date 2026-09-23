// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/Exagone313/dsh-podman/internal/auth"
	ctl "github.com/Exagone313/dsh-podman/internal/genproto/dshctl/v1"
	"github.com/Exagone313/dsh-podman/internal/grpclog"
	"github.com/Exagone313/dsh-podman/internal/orchestrator/grpcserver"
	"github.com/Exagone313/dsh-podman/internal/orchestrator/images"
	"github.com/Exagone313/dsh-podman/internal/orchestrator/podman"
	"github.com/Exagone313/dsh-podman/internal/orchestrator/state"
	"github.com/Exagone313/dsh-podman/internal/recovery"
	socketpkg "github.com/Exagone313/dsh-podman/internal/socket"
	"github.com/Exagone313/dsh-podman/internal/version"
	"go.podman.io/podman/v6/pkg/bindings"
	"go.podman.io/podman/v6/pkg/bindings/system"
	"google.golang.org/grpc"
)

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--version" {
		fmt.Printf("%s (commit %s)\n", version.Version, version.Commit)
		return
	}
	socketpkg.Restrict()
	socketsRoot := getenv("DSH_PODMAN_SOCKETS_ROOT", "/run/dsh-podman")
	socket := filepath.Join(socketsRoot, "orchestrator.sock")
	root := getenv("DSH_PODMAN_PROJECTS_ROOT", "/projects")
	stateDir := getenv("DSH_PODMAN_ORCHESTRATOR_STATE", "/var/lib/dsh-orchestrator")
	hostProjectsRoot := getenv("DSH_PODMAN_HOST_PROJECTS_ROOT", root)
	hostSocketsRoot := getenv("DSH_PODMAN_HOST_SOCKETS_ROOT", socketsRoot)
	hostGuestBinary := getenv("DSH_PODMAN_HOST_GUEST_AGENT_BIN", "")
	hostPacmanCache := getenv("DSH_PODMAN_HOST_PACMAN_CACHE", "")
	hostAptCache := getenv("DSH_PODMAN_HOST_APT_CACHE", "")
	hostApkCache := getenv("DSH_PODMAN_HOST_APK_CACHE", "")
	controlToken := getenv("DSH_PODMAN_ORCHESTRATOR_TOKEN", "")
	guestAgentImage := getenv("DSH_PODMAN_GUEST_AGENT_IMAGE", "")
	guestAgentBin := getenv("DSH_PODMAN_GUEST_AGENT_IMAGE_AGENT_BIN", "/bin/dsh-podman-guest-agent")
	guestAgentMount := getenv("DSH_PODMAN_GUEST_AGENT_IMAGE_MOUNT", "/opt/dsh-podman/guest-agent")
	if getenvBool("DSH_PODMAN_GUEST_AGENT_IMAGE_USE_VERSION_TAG") && guestAgentImage != "" {
		guestAgentImage = imageRefWithTag(guestAgentImage, version.Version)
	}
	if err := requireDirectory(filepath.Dir(socket)); err != nil {
		panic(err)
	}
	store, err := state.New(stateDir)
	if err != nil {
		panic(err)
	}
	listener, err := socketpkg.Listen(socket)
	if err != nil {
		panic(err)
	}
	logger := slog.New(slog.NewTextHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	logger.Info("dsh-podman-orchestrator starting", "version", version.Version, "commit", version.Commit)
	// Authentication runs first so a rejected call is never logged as a
	// request nor able to panic a handler; the plugin version check runs next,
	// so an incompatible plugin is refused before any handler sees it; recovery
	// runs innermost, closest to the handler it protects.
	unary := []grpc.UnaryServerInterceptor{}
	if controlToken != "" {
		logger.Info("control-plane authentication enabled")
		unary = append(unary, auth.Unary(controlToken))
	} else {
		logger.Warn("control-plane authentication is disabled; set DSH_PODMAN_ORCHESTRATOR_TOKEN")
	}
	unary = append(unary, grpcserver.UnaryVersion(logger), grpclog.Unary(logger), recovery.Unary(logger))
	server := grpc.NewServer(grpc.ChainUnaryInterceptor(unary...))
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
		podmanClient, err = podman.New(context.Background(), podmanSocket, socketsRoot, guestAgentImage, guestAgentBin, guestAgentMount, hostSocketsRoot, root, hostGuestBinary, logger)
		if err != nil {
			panic(fmt.Errorf("initialize Podman client: %w", err))
		}
		imageBuilder = &images.Builder{Context: podmanContext, HostPacmanCache: hostPacmanCache, HostAptCache: hostAptCache, HostApkCache: hostApkCache, ImagePrefix: getenv("DSH_PODMAN_IMAGE_PREFIX", "localhost/dsh-podman/"), BaseImagePrefix: getenv("DSH_PODMAN_BASE_IMAGE_PREFIX", "localhost/dsh-podman/base/"), Logger: logger}
	} else {
		_, orchSocketSet := os.LookupEnv("DSH_PODMAN_ORCHESTRATOR_PODMAN_SOCKET")
		logger.Error("Podman API configuration is missing", "DSH_PODMAN_ORCHESTRATOR_PODMAN_SOCKET_present", orchSocketSet, "expected", "DSH_PODMAN_ORCHESTRATOR_PODMAN_SOCKET=unix:///run/podman/podman.sock")
		panic("Podman API is not configured: DSH_PODMAN_ORCHESTRATOR_PODMAN_SOCKET is absent or empty")
	}
	controlServer := &grpcserver.Server{ProjectsRoot: root, HostProjectsRoot: hostProjectsRoot, SocketsRoot: socketsRoot, GuestAgentMount: guestAgentMount, Store: store, Podman: podmanClient, ImageBuilder: imageBuilder, BaseImagePrefix: getenv("DSH_PODMAN_BASE_IMAGE_PREFIX", "localhost/dsh-podman/base/"), VolumePrefix: getenv("DSH_PODMAN_VOLUME_PREFIX", "dsh-podman-"), SecretPrefix: getenv("DSH_PODMAN_SECRET_PREFIX", "dsh-podman-"), Logger: logger}
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

// getenvBool reports whether an env var is set to a truthy value ("1",
// "true", "yes", "on"; case-insensitive). Anything else, including unset, is
// falsy.
func getenvBool(name string) bool {
	switch strings.ToLower(os.Getenv(name)) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

// imageRefWithTag returns ref with its tag replaced by (or set to) tag. Only
// the colon after the last slash is treated as a tag separator, so registry
// ports (e.g. localhost:5000/...) are not mistaken for tags. A digest
// reference cannot be overridden and panics, since it signals a misconfigured
// DSH_PODMAN_GUEST_AGENT_IMAGE when DSH_PODMAN_GUEST_AGENT_IMAGE_USE_VERSION_TAG
// is set.
func imageRefWithTag(ref, tag string) string {
	if strings.Contains(ref, "@") {
		panic("DSH_PODMAN_GUEST_AGENT_IMAGE must not use a digest with DSH_PODMAN_GUEST_AGENT_IMAGE_USE_VERSION_TAG=true")
	}
	slash := strings.LastIndexByte(ref, '/')
	if colon := strings.LastIndexByte(ref[slash+1:], ':'); colon >= 0 {
		return ref[:slash+1+colon] + ":" + tag
	}
	return ref + ":" + tag
}

// requireDirectory checks that the control socket's directory exists and is
// private to its owner. The socket itself is created 0600, but that only
// matters if the directory above it cannot be traversed by other users: the
// control plane is a full-privilege interface onto the Podman API.
func requireDirectory(dir string) error {
	info, err := os.Stat(dir)
	if err != nil {
		return fmt.Errorf("socket root %q is not accessible: %w", dir, err)
	}
	if !info.IsDir() {
		return fmt.Errorf("socket root %q is not a directory", dir)
	}
	if mode := info.Mode().Perm(); mode&0o077 != 0 {
		return fmt.Errorf("socket root %q is group- or world-accessible (mode %04o); it must be 0700", dir, mode)
	}
	return nil
}
