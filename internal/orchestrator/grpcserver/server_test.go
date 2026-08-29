// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"

	ctl "gitlab.com/Exagone313/dsh-podman/internal/genproto/dshctl/v1"
	"gitlab.com/Exagone313/dsh-podman/internal/orchestrator/state"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func newTestStore(t *testing.T) *state.Store {
	t.Helper()
	store, err := state.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return store
}

func silentLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func TestValidateProject(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "team"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "file"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	path, err := ValidateProject(root, "team")
	if err != nil || !filepath.IsAbs(path) {
		t.Fatalf("valid project rejected: %v %v", path, err)
	}
	invalid := []string{"", "..", ".", "../x", "/abs", "a/../b", "a//b", "a\x00b", "missing"}
	for _, name := range invalid {
		if _, err := ValidateProject(root, name); err == nil {
			t.Errorf("accepted invalid project name %q", name)
		}
	}
	if _, err := ValidateProject(root, "file"); err == nil {
		t.Fatal("accepted non-directory project")
	}
}

func TestToProto(t *testing.T) {
	workspace := state.Workspace{
		WorkspaceSlug: "proj", ContainerName: "c", ImageID: "arch", Status: "running",
		AgentSocketPath: "/sock", AgentToken: "tok", CreatedAt: "now",
		Mounts: []state.Mount{{ProjectName: "a", Mode: "read_only"}, {ProjectName: "b", Mode: "read_write"}},
	}
	proto := toProto(workspace)
	if proto.WorkspaceSlug != "proj" || proto.ContainerName != "c" || proto.AgentToken != "tok" {
		t.Fatalf("unexpected proto: %#v", proto)
	}
	if len(proto.Mounts) != 2 || proto.Mounts[0].Mode != ctl.MountMode_MOUNT_MODE_READ_ONLY || proto.Mounts[1].Mode != ctl.MountMode_MOUNT_MODE_READ_WRITE {
		t.Fatalf("mount modes not mapped: %#v", proto.Mounts)
	}
}

func TestDefaultImageID(t *testing.T) {
	t.Setenv("DSH_PODMAN_DEFAULT_IMAGE", "")
	t.Setenv("DSH_PODMAN_IMAGE_PREFIX", "")
	if got := defaultImageID(); got != "localhost/dsh-podman/arch-base" {
		t.Fatalf("unexpected default image id: %q", got)
	}
	t.Setenv("DSH_PODMAN_IMAGE_PREFIX", "registry.example.com/dsh/")
	if got := defaultImageID(); got != "registry.example.com/dsh/arch-base" {
		t.Fatalf("unexpected default image id: %q", got)
	}
	t.Setenv("DSH_PODMAN_IMAGE_PREFIX", "registry.example.com/dsh")
	if got := defaultImageID(); got != "registry.example.com/dsh/arch-base" {
		t.Fatalf("unexpected default image id: %q", got)
	}
	t.Setenv("DSH_PODMAN_DEFAULT_IMAGE", "custom")
	if got := defaultImageID(); got != "custom" {
		t.Fatalf("unexpected default image id: %q", got)
	}
}

func TestUnaryLoggerPassesThrough(t *testing.T) {
	interceptor := UnaryLogger(silentLogger())
	called := false
	handler := func(ctx context.Context, req any) (any, error) { called = true; return "value", nil }
	result, err := interceptor(context.Background(), nil, &grpc.UnaryServerInfo{FullMethod: "/test/Method"}, handler)
	if err != nil || result != "value" || !called {
		t.Fatalf("interceptor did not pass through: %v %v %v", result, err, called)
	}
}

func TestListProjects(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "alpha"), 0755); err != nil {
		t.Fatal(err)
	}
	server := &Server{ProjectsRoot: root, Logger: silentLogger()}
	response, err := server.ListProjects(context.Background(), &ctl.ListProjectsRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if len(response.Projects) != 1 || response.Projects[0].Name != "alpha" {
		t.Fatalf("unexpected projects: %#v", response.Projects)
	}
}

func TestListProjectsMissingRoot(t *testing.T) {
	server := &Server{ProjectsRoot: filepath.Join(t.TempDir(), "nope"), Logger: silentLogger()}
	_, err := server.ListProjects(context.Background(), &ctl.ListProjectsRequest{})
	if status.Code(err) != codes.Internal {
		t.Fatalf("expected Internal, got %v", err)
	}
}

func TestListWorkspaces(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{WorkspaceSlug: "a"}, {WorkspaceSlug: "b"}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}
	response, err := server.ListWorkspaces(context.Background(), &ctl.ListWorkspacesRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if len(response.Workspaces) != 2 {
		t.Fatalf("unexpected workspaces: %#v", response.Workspaces)
	}
}

func TestListWorkspacesEmpty(t *testing.T) {
	server := &Server{Store: newTestStore(t), Logger: silentLogger()}
	response, err := server.ListWorkspaces(context.Background(), &ctl.ListWorkspacesRequest{})
	if err != nil || len(response.Workspaces) != 0 {
		t.Fatalf("unexpected workspaces: %#v, %v", response.Workspaces, err)
	}
}

func TestListImages(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveImages([]state.Image{{ImageID: "arch", ImageTag: "t1"}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}
	response, err := server.ListImages(context.Background(), &ctl.ListImagesRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if len(response.Images) != 1 || response.Images[0].ImageId != "arch" || response.Images[0].ImageTag != "t1" {
		t.Fatalf("unexpected images: %#v", response.Images)
	}
}

func TestDescribeWorkspace(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{WorkspaceSlug: "proj", ContainerName: "c", Status: "running"}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}
	workspace, err := server.DescribeWorkspace(context.Background(), &ctl.DescribeWorkspaceRequest{WorkspaceSlug: "proj"})
	if err != nil {
		t.Fatal(err)
	}
	if workspace.WorkspaceSlug != "proj" || workspace.Status != "running" {
		t.Fatalf("unexpected workspace: %#v", workspace)
	}
}

func TestDescribeWorkspaceNotFound(t *testing.T) {
	server := &Server{Store: newTestStore(t), Logger: silentLogger()}
	_, err := server.DescribeWorkspace(context.Background(), &ctl.DescribeWorkspaceRequest{WorkspaceSlug: "nope"})
	if status.Code(err) != codes.NotFound {
		t.Fatalf("expected NotFound, got %v", err)
	}
}

func TestListContainersRequiresPodman(t *testing.T) {
	server := &Server{Store: newTestStore(t), Logger: silentLogger()}
	_, err := server.ListContainers(context.Background(), &ctl.ListContainersRequest{})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("expected FailedPrecondition, got %v", err)
	}
}

func TestCreateWorkspaceRejectsInvalidSlug(t *testing.T) {
	server := &Server{Logger: silentLogger()}
	for _, slug := range []string{"", "a/b", "../x"} {
		_, err := server.CreateWorkspace(context.Background(), &ctl.CreateWorkspaceRequest{WorkspaceSlug: slug, ImageId: "arch"})
		if status.Code(err) != codes.InvalidArgument {
			t.Errorf("slug %q: expected InvalidArgument, got %v", slug, err)
		}
	}
}

func TestCreateWorkspaceRejectsUnknownImage(t *testing.T) {
	t.Setenv("DSH_PODMAN_DEFAULT_IMAGE", "arch-base")
	server := &Server{Store: newTestStore(t), Logger: silentLogger()}
	_, err := server.CreateWorkspace(context.Background(), &ctl.CreateWorkspaceRequest{WorkspaceSlug: "proj", ImageId: "missing"})
	if status.Code(err) != codes.NotFound {
		t.Fatalf("expected NotFound, got %v", err)
	}
}

func TestCreateWorkspaceRequiresBuilderForDefaultImage(t *testing.T) {
	t.Setenv("DSH_PODMAN_DEFAULT_IMAGE", "arch-base")
	server := &Server{Store: newTestStore(t), Logger: silentLogger(), BuildDefaultImage: true}
	_, err := server.CreateWorkspace(context.Background(), &ctl.CreateWorkspaceRequest{WorkspaceSlug: "proj", ImageId: "arch-base"})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("expected FailedPrecondition, got %v", err)
	}
}

func TestCreateWorkspaceRefusesToBuildWhenDisabled(t *testing.T) {
	t.Setenv("DSH_PODMAN_DEFAULT_IMAGE", "arch-base")
	server := &Server{Store: newTestStore(t), Logger: silentLogger(), BuildDefaultImage: false}
	_, err := server.CreateWorkspace(context.Background(), &ctl.CreateWorkspaceRequest{WorkspaceSlug: "proj", ImageId: "arch-base"})
	if status.Code(err) != codes.NotFound {
		t.Fatalf("expected NotFound, got %v", err)
	}
}

func TestRebuildImageRequiresBuilder(t *testing.T) {
	server := &Server{Logger: silentLogger()}
	_, err := server.RebuildImage(context.Background(), &ctl.RebuildImageRequest{ImageId: "arch"})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("expected FailedPrecondition, got %v", err)
	}
}

func TestStopWorkspaceRequiresPodman(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{WorkspaceSlug: "proj", ContainerName: "c"}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}
	_, err := server.StopWorkspace(context.Background(), &ctl.StopWorkspaceRequest{WorkspaceSlug: "proj"})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("expected FailedPrecondition, got %v", err)
	}
}

func TestStopWorkspaceMissingWorkspace(t *testing.T) {
	server := &Server{Store: newTestStore(t), Logger: silentLogger()}
	_, err := server.StopWorkspace(context.Background(), &ctl.StopWorkspaceRequest{WorkspaceSlug: "nope"})
	if status.Code(err) != codes.NotFound {
		t.Fatalf("expected NotFound, got %v", err)
	}
}

func TestRecreateWorkspaceNotImplemented(t *testing.T) {
	server := &Server{Logger: silentLogger()}
	_, err := server.RecreateWorkspace(context.Background(), &ctl.RecreateWorkspaceRequest{})
	if status.Code(err) != codes.Unimplemented {
		t.Fatalf("expected Unimplemented, got %v", err)
	}
}
