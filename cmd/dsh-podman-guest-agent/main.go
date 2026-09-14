// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package main

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"

	"github.com/Exagone313/dsh-podman/internal/auth"
	guest "github.com/Exagone313/dsh-podman/internal/genproto/dshguest/v1"
	workspacefs "github.com/Exagone313/dsh-podman/internal/guestagent/fs"
	"github.com/Exagone313/dsh-podman/internal/guestagent/grpcserver"
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
	extra, err := guestMounts(os.Getenv("DSH_PODMAN_GUEST_MOUNTS"))
	if err != nil {
		panic(err)
	}
	paths, err := guestPaths(os.Getenv("DSH_PODMAN_GUEST_PATHS"))
	if err != nil {
		panic(err)
	}
	filesystem, err := workspacefs.New(append(
		[]workspacefs.Mount{{Virtual: root, Host: root}},
		extra...,
	))
	if err != nil {
		panic(err)
	}
	server := grpc.NewServer(
		grpc.ChainUnaryInterceptor(auth.Unary(token), recovery.Unary(logger)),
		grpc.ChainStreamInterceptor(auth.Stream(token), recovery.Stream(logger)),
	)
	agent := grpcserver.New().WithFS(filesystem)
	agent.Paths.Set(paths)
	guest.RegisterWorkspaceGuestAgentServer(server, agent)
	logger.Info("guest agent listening", "socket", socket)
	if err := server.Serve(listener); err != nil {
		panic(err)
	}
}

// guestMounts decodes the orchestrator-provided DSH_PODMAN_GUEST_MOUNTS value
// into the extra workspace mounts the file API may reach, or nil when unset.
func guestMounts(encoded string) ([]workspacefs.Mount, error) {
	if encoded == "" {
		return nil, nil
	}
	var entries []struct {
		Path     string `json:"path"`
		ReadOnly bool   `json:"read_only"`
	}
	if err := json.Unmarshal([]byte(encoded), &entries); err != nil {
		return nil, fmt.Errorf("decode DSH_PODMAN_GUEST_MOUNTS: %w", err)
	}
	mounts := make([]workspacefs.Mount, 0, len(entries))
	for _, entry := range entries {
		if !filepath.IsAbs(entry.Path) {
			return nil, fmt.Errorf("mount path must be absolute: %q", entry.Path)
		}
		mounts = append(mounts, workspacefs.Mount{
			Virtual:  entry.Path,
			Host:     entry.Path,
			ReadOnly: entry.ReadOnly,
		})
	}
	return mounts, nil
}

// guestPaths decodes the orchestrator-provided DSH_PODMAN_GUEST_PATHS value
// into the PATH additions the agent prepends to every child, or nil when unset.
func guestPaths(encoded string) ([]string, error) {
	if encoded == "" {
		return nil, nil
	}
	var paths []string
	if err := json.Unmarshal([]byte(encoded), &paths); err != nil {
		return nil, fmt.Errorf("decode DSH_PODMAN_GUEST_PATHS: %w", err)
	}
	return paths, nil
}
