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
	"strings"
	"testing"

	ctl "gitlab.com/Exagone313/dsh-podman/internal/genproto/dshctl/v1"
	imagebuild "gitlab.com/Exagone313/dsh-podman/internal/orchestrator/images"
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
		WorkspaceSlug: "proj", ContainerName: "dsh-workspace-proj", ImageID: "arch", Status: "running",
		AgentSocketPath: "/sock", AgentToken: "tok", CreatedAt: "now",
		Mounts: []state.Mount{{ProjectName: "a", Mode: "read_only"}, {ProjectName: "b", Mode: "read_write"}},
	}
	proto := toProto(workspace)
	if proto.WorkspaceSlug != "proj" || proto.ContainerName != "dsh-workspace-proj" || proto.AgentToken != "tok" {
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
	if err := store.SaveWorkspaces([]state.Workspace{{WorkspaceSlug: "proj", ContainerName: "dsh-workspace-proj", Status: "running"}}); err != nil {
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

func TestListContainersStateDriven(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{WorkspaceSlug: "proj", ContainerName: "dsh-workspace-proj", Status: "running"}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}
	response, err := server.ListContainers(context.Background(), &ctl.ListContainersRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if len(response.Containers) != 1 || response.Containers[0].ContainerName != "default" || response.Containers[0].PodmanName != "dsh-workspace-proj" || response.Containers[0].WorkspaceSlug != "proj" || response.Containers[0].Status != "running" {
		t.Fatalf("unexpected containers: %#v", response.Containers)
	}
}

func TestListContainersSorted(t *testing.T) {
	store := newTestStore(t)
	workspaces := []state.Workspace{
		{WorkspaceSlug: "b", Containers: []state.Container{{Name: "default", PodmanName: "dsh-workspace-b", Status: "running"}}},
		{WorkspaceSlug: "a", Containers: []state.Container{
			{Name: "dev", PodmanName: "dsh-workspace-a-dev", Status: "running"},
			{Name: "default", PodmanName: "dsh-workspace-a", Status: "running"},
		}},
	}
	if err := store.SaveWorkspaces(workspaces); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}
	response, err := server.ListContainers(context.Background(), &ctl.ListContainersRequest{})
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, container := range response.Containers {
		names = append(names, container.WorkspaceSlug+":"+container.ContainerName)
	}
	if got, want := strings.Join(names, ","), "a:default,a:dev,b:default"; got != want {
		t.Fatalf("containers not sorted: %v, want %v", got, want)
	}
}

func TestCreateWorkspaceRejectsInvalidSlug(t *testing.T) {
	server := &Server{Logger: silentLogger()}
	for _, slug := range []string{"", "a/b", "../x", ".", "..", "-x", "a b", "a:b", "a\\b", "a#b", "a\nb", "x" + strings.Repeat("y", 70)} {
		_, err := server.CreateWorkspace(context.Background(), &ctl.CreateWorkspaceRequest{WorkspaceSlug: slug, ImageId: "arch"})
		if status.Code(err) != codes.InvalidArgument {
			t.Errorf("slug %q: expected InvalidArgument, got %v", slug, err)
		}
	}
	for _, slug := range []string{"proj", "team-app", "a_b.c", "x1", "a-b_c.9-z"} {
		if !validWorkspaceSlug(slug) {
			t.Errorf("rejected valid slug %q", slug)
		}
	}
}

func TestDescribeWorkspaceRejectsInvalidContainerName(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{WorkspaceSlug: "proj", ContainerName: "../escape"}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}
	_, err := server.DescribeWorkspace(context.Background(), &ctl.DescribeWorkspaceRequest{WorkspaceSlug: "proj"})
	if status.Code(err) != codes.NotFound {
		t.Fatalf("expected NotFound, got %v", err)
	}
}

func TestContainerRows(t *testing.T) {
	workspaces := []state.Workspace{{
		WorkspaceSlug: "proj",
		Mounts:        []state.Mount{{ProjectName: "team", Mode: "read_write"}},
		Containers: []state.Container{
			{Name: "default", PodmanName: "dsh-workspace-proj", ImageID: "arch", Status: "running", CreatedAt: "now", AgentSocketPath: "/sock/default", AgentToken: "tok-default"},
			{Name: "dev", PodmanName: "dsh-workspace-proj-dev", ImageID: "devimg", Status: "running", CreatedAt: "later", AgentSocketPath: "/sock/dev", AgentToken: "tok-dev"},
		},
	}}
	exists := func(podmanName string) bool {
		return podmanName == "dsh-workspace-proj-dev"
	}
	rows := containerRows(workspaces, exists)
	if len(rows) != 2 {
		t.Fatalf("expected both containers, got %#v", rows)
	}
	def := rows[0]
	if def.ContainerName != "default" || def.PodmanName != "dsh-workspace-proj" || def.WorkspaceSlug != "proj" || def.ImageId != "arch" || def.Status != "not started" || def.CreatedAt != "now" || def.AgentSocketPath != "/sock/default" || def.AgentToken != "tok-default" {
		t.Fatalf("default row mismatch: %#v", def)
	}
	dev := rows[1]
	if dev.ContainerName != "dev" || dev.PodmanName != "dsh-workspace-proj-dev" || dev.WorkspaceSlug != "proj" || dev.ImageId != "devimg" || dev.Status != "running" || dev.CreatedAt != "later" || dev.AgentSocketPath != "/sock/dev" || dev.AgentToken != "tok-dev" {
		t.Fatalf("named row mismatch: %#v", dev)
	}
	if len(def.Mounts) != 1 || def.Mounts[0].ProjectName != "team" || def.Mounts[0].Mode != ctl.MountMode_MOUNT_MODE_READ_WRITE {
		t.Fatalf("mounts not projected: %#v", def.Mounts)
	}
}

func TestContainerRowsNilExistsKeepsStoredStatus(t *testing.T) {
	workspaces := []state.Workspace{{
		WorkspaceSlug: "proj",
		Containers:    []state.Container{{Name: "default", PodmanName: "dsh-workspace-proj", Status: "stopped"}},
	}}
	rows := containerRows(workspaces, nil)
	if len(rows) != 1 || rows[0].Status != "stopped" {
		t.Fatalf("expected stored status kept, got %#v", rows)
	}
}

func TestContainerNameHelpers(t *testing.T) {
	for _, valid := range []string{"dev", "web", "api-2", "x"} {
		if !validContainerName(valid) {
			t.Errorf("rejected valid container name %q", valid)
		}
	}
	for _, invalid := range []string{"", "default", "Dev", "dev_1", "-dev", "a-b-c-d-e-f-g-h-i-j-k-l-m-n-o-p-q-r-s-t-u-v-w-x-y-z-0"} {
		if validContainerName(invalid) {
			t.Errorf("accepted invalid container name %q", invalid)
		}
	}
	if got := podmanContainerName("proj", ""); got != "dsh-workspace-proj" {
		t.Fatalf("default podman name mismatch: %q", got)
	}
	if got := podmanContainerName("proj", "default"); got != "dsh-workspace-proj" {
		t.Fatalf("default podman name mismatch: %q", got)
	}
	if got := podmanContainerName("proj", "dev"); got != "dsh-workspace-proj-dev" {
		t.Fatalf("named podman name mismatch: %q", got)
	}
	if got := podNameFor("proj"); got != "dsh-pod-proj" {
		t.Fatalf("pod name mismatch: %q", got)
	}
}

func TestContainerByLogical(t *testing.T) {
	workspace := state.Workspace{Containers: []state.Container{
		{Name: "default", PodmanName: "dsh-workspace-proj"},
		{Name: "dev", PodmanName: "dsh-workspace-proj-dev"},
	}}
	for _, name := range []string{"", "default"} {
		container, ok := containerByLogical(&workspace, name)
		if !ok || container.Name != "default" {
			t.Fatalf("name %q: expected default container, got %#v, %v", name, container, ok)
		}
	}
	container, ok := containerByLogical(&workspace, "dev")
	if !ok || container.PodmanName != "dsh-workspace-proj-dev" {
		t.Fatalf("expected dev container, got %#v, %v", container, ok)
	}
	if _, ok := containerByLogical(&workspace, "nope"); ok {
		t.Fatal("unexpectedly found unknown container")
	}
}

func TestStartContainerRejectsDefault(t *testing.T) {
	server := &Server{Logger: silentLogger()}
	for _, name := range []string{"", "default", "Dev", "dev_1", "-dev"} {
		_, err := server.StartContainer(context.Background(), &ctl.StartContainerRequest{WorkspaceSlug: "proj", Container: name})
		if status.Code(err) != codes.InvalidArgument {
			t.Errorf("container %q: expected InvalidArgument, got %v", name, err)
		}
	}
}

func TestStartContainerRequiresPodman(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{WorkspaceSlug: "proj", ContainerName: "dsh-workspace-proj"}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}
	_, err := server.StartContainer(context.Background(), &ctl.StartContainerRequest{WorkspaceSlug: "proj", Container: "dev"})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("expected FailedPrecondition, got %v", err)
	}
}

func TestReplaceContainerRejectsDefault(t *testing.T) {
	server := &Server{Logger: silentLogger()}
	for _, name := range []string{"", "default"} {
		_, err := server.ReplaceContainer(context.Background(), &ctl.ReplaceContainerRequest{WorkspaceSlug: "proj", Container: name, ImageId: "arch"})
		if status.Code(err) != codes.InvalidArgument {
			t.Errorf("container %q: expected InvalidArgument, got %v", name, err)
		}
	}
}

func TestRemoveContainerRejectsDefault(t *testing.T) {
	server := &Server{Logger: silentLogger()}
	for _, name := range []string{"", "default"} {
		_, err := server.RemoveContainer(context.Background(), &ctl.RemoveContainerRequest{WorkspaceSlug: "proj", Container: name})
		if status.Code(err) != codes.InvalidArgument {
			t.Errorf("container %q: expected InvalidArgument, got %v", name, err)
		}
	}
}

func TestRemoveContainerUnknownContainer(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{WorkspaceSlug: "proj", ContainerName: "dsh-workspace-proj"}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}
	_, err := server.RemoveContainer(context.Background(), &ctl.RemoveContainerRequest{WorkspaceSlug: "proj", Container: "dev"})
	if status.Code(err) != codes.NotFound {
		t.Fatalf("expected NotFound, got %v", err)
	}
}

func TestGetImageMissing(t *testing.T) {
	server := &Server{Store: newTestStore(t), Logger: silentLogger()}
	_, err := server.GetImage(context.Background(), &ctl.GetImageRequest{ImageId: "nope"})
	if status.Code(err) != codes.NotFound {
		t.Fatalf("expected NotFound, got %v", err)
	}
}

func TestGetImage(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveImages([]state.Image{{ImageID: "arch", BaseImage: "archlinux", Packages: []string{"git"}, ImageTag: "t1", BuiltAt: "now"}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}
	image, err := server.GetImage(context.Background(), &ctl.GetImageRequest{ImageId: "arch"})
	if err != nil {
		t.Fatal(err)
	}
	if image.ImageId != "arch" || image.BaseImage != "archlinux" || image.ImageTag != "t1" || image.BuiltAt != "now" || len(image.Packages) != 1 || image.Packages[0] != "git" {
		t.Fatalf("unexpected image: %#v", image)
	}
}

func TestBuildImageRejectsBase(t *testing.T) {
	t.Setenv("DSH_PODMAN_DEFAULT_IMAGE", "arch-base")
	server := &Server{Logger: silentLogger()}
	_, err := server.BuildImage(context.Background(), &ctl.BuildImageRequest{ImageId: "arch-base", BaseImage: "arch-base"})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("expected InvalidArgument, got %v", err)
	}
}

func TestRebuildImageRejectsBase(t *testing.T) {
	t.Setenv("DSH_PODMAN_DEFAULT_IMAGE", "arch-base")
	server := &Server{Logger: silentLogger()}
	_, err := server.RebuildImage(context.Background(), &ctl.RebuildImageRequest{ImageId: "arch-base"})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("expected InvalidArgument, got %v", err)
	}
}

func TestBuildImageMissingBase(t *testing.T) {
	server := &Server{Store: newTestStore(t), ImageBuilder: &imagebuild.Builder{}, Logger: silentLogger()}
	_, err := server.BuildImage(context.Background(), &ctl.BuildImageRequest{ImageId: "dev", BaseImage: "missing"})
	if status.Code(err) != codes.NotFound {
		t.Fatalf("expected NotFound, got %v", err)
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
	if err := store.SaveWorkspaces([]state.Workspace{{WorkspaceSlug: "proj", ContainerName: "dsh-workspace-proj"}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}
	_, err := server.StopWorkspace(context.Background(), &ctl.StopWorkspaceRequest{WorkspaceSlug: "proj"})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("expected FailedPrecondition, got %v", err)
	}
}

func TestRemoveContainerRequiresPodman(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{WorkspaceSlug: "proj", ContainerName: "dsh-workspace-proj", Containers: []state.Container{{Name: "dev", PodmanName: "dsh-workspace-proj-dev", Status: "running"}}}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}
	_, err := server.RemoveContainer(context.Background(), &ctl.RemoveContainerRequest{WorkspaceSlug: "proj", Container: "dev"})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("expected FailedPrecondition, got %v", err)
	}
}

func TestRemoveContainerMissingWorkspace(t *testing.T) {
	server := &Server{Store: newTestStore(t), Logger: silentLogger()}
	_, err := server.RemoveContainer(context.Background(), &ctl.RemoveContainerRequest{WorkspaceSlug: "nope", Container: "dev"})
	if status.Code(err) != codes.NotFound {
		t.Fatalf("expected NotFound, got %v", err)
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
