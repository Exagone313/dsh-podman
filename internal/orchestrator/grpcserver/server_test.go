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

	"github.com/containers/podman/v5/pkg/specgen"
	ctl "gitlab.com/Exagone313/dsh-podman/internal/genproto/dshctl/v1"
	imagebuild "gitlab.com/Exagone313/dsh-podman/internal/orchestrator/images"
	"gitlab.com/Exagone313/dsh-podman/internal/orchestrator/podman"
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
	if got := DefaultImageID(); got != "localhost/dsh-podman/arch-base" {
		t.Fatalf("unexpected default image id: %q", got)
	}
	t.Setenv("DSH_PODMAN_IMAGE_PREFIX", "registry.example.com/dsh/")
	if got := DefaultImageID(); got != "registry.example.com/dsh/arch-base" {
		t.Fatalf("unexpected default image id: %q", got)
	}
	t.Setenv("DSH_PODMAN_IMAGE_PREFIX", "registry.example.com/dsh")
	if got := DefaultImageID(); got != "registry.example.com/dsh/arch-base" {
		t.Fatalf("unexpected default image id: %q", got)
	}
	t.Setenv("DSH_PODMAN_DEFAULT_IMAGE", "custom")
	if got := DefaultImageID(); got != "custom" {
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

func TestPodNameNeverCollidesWithContainerName(t *testing.T) {
	slugs := []string{"proj", "a-b_c.1", "default", "x"}
	logicals := []string{"", "default", "dev", "a1", "x-y"}
	for _, slug := range slugs {
		pod := podNameFor(slug)
		if !strings.HasPrefix(pod, "dsh-pod-") {
			t.Fatalf("unexpected pod name %q", pod)
		}
		for _, logical := range logicals {
			container := podmanContainerName(slug, logical)
			if container == pod {
				t.Fatalf("container name %q collides with pod name %q", container, pod)
			}
		}
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
	if err := store.SaveImages([]state.Image{{ImageID: "arch", ImageTag: "localhost/dsh-podman/arch:latest"}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}
	_, err := server.StartContainer(context.Background(), &ctl.StartContainerRequest{WorkspaceSlug: "proj", Container: "dev", ImageId: "arch"})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("expected FailedPrecondition, got %v", err)
	}
}

func TestStartContainerRejectsUnknownImage(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{WorkspaceSlug: "proj"}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}
	for _, image := range []string{
		"docker.io/library/nginx:latest",
		"localhost/dsh-podman/not-built",
		"arbitrary",
	} {
		_, err := server.StartContainer(context.Background(), &ctl.StartContainerRequest{WorkspaceSlug: "proj", Container: "web", ImageId: image})
		if status.Code(err) != codes.NotFound {
			t.Errorf("image %q: expected NotFound (arbitrary image rejected), got %v", image, err)
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

func TestResolveImageTag(t *testing.T) {
	t.Setenv("DSH_PODMAN_DEFAULT_IMAGE", "arch-base")
	store := newTestStore(t)
	images := []state.Image{
		{ImageID: "arch-base", BaseImage: "docker.io/library/archlinux:latest", ImageTag: "localhost/dsh-podman/arch-base:latest"},
		{ImageID: "valkey", BaseImage: "localhost/dsh-podman/arch-base:latest", ImageTag: "localhost/dsh-podman/valkey:latest"},
	}
	if err := store.SaveImages(images); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}
	cases := map[string]string{
		"arch-base":                             "localhost/dsh-podman/arch-base:latest",
		"arch-base:latest":                      "localhost/dsh-podman/arch-base:latest",
		"localhost/dsh-podman/arch-base":        "localhost/dsh-podman/arch-base:latest",
		"localhost/dsh-podman/arch-base:latest": "localhost/dsh-podman/arch-base:latest",
		"valkey":                                "localhost/dsh-podman/valkey:latest",
		"valkey:latest":                         "localhost/dsh-podman/valkey:latest",
		"localhost/dsh-podman/valkey":           "localhost/dsh-podman/valkey:latest",
		"localhost/dsh-podman/valkey:latest":    "localhost/dsh-podman/valkey:latest",
	}
	for in, want := range cases {
		got, err := server.resolveImageTag(in)
		if err != nil {
			t.Fatalf("resolveImageTag(%q): %v", in, err)
		}
		if got != want {
			t.Fatalf("resolveImageTag(%q) = %q, want %q", in, got, want)
		}
	}
	if _, err := server.resolveImageTag("missing"); status.Code(err) != codes.NotFound {
		t.Fatalf("expected NotFound for missing base, got %v", err)
	}
}

func TestStartContainerAcceptsTagReference(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveImages([]state.Image{{ImageID: "valkey", ImageTag: "localhost/dsh-podman/valkey:latest"}}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveWorkspaces([]state.Workspace{{WorkspaceSlug: "proj"}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}
	_, err := server.StartContainer(context.Background(), &ctl.StartContainerRequest{
		WorkspaceSlug: "proj",
		Container:     "valkey-ctr",
		ImageId:       "localhost/dsh-podman/valkey:latest",
	})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("tag reference should resolve past image lookup, expected FailedPrecondition (podman not configured), got %v", err)
	}
}

func TestGetImageAcceptsTagReference(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveImages([]state.Image{{ImageID: "valkey", ImageTag: "localhost/dsh-podman/valkey:latest"}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}
	image, err := server.GetImage(context.Background(), &ctl.GetImageRequest{ImageId: "localhost/dsh-podman/valkey:latest"})
	if err != nil {
		t.Fatal(err)
	}
	if image.ImageId != "valkey" {
		t.Fatalf("expected stored image valkey, got %q", image.ImageId)
	}
}

func TestRebuildImageAcceptsTagReference(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveImages([]state.Image{{ImageID: "valkey", BaseImage: "localhost/dsh-podman/arch-base:latest", Packages: []string{"valkey"}, ImageTag: "localhost/dsh-podman/valkey:latest"}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, ImageBuilder: &imagebuild.Builder{}, Logger: silentLogger()}
	_, err := server.RebuildImage(context.Background(), &ctl.RebuildImageRequest{ImageId: "localhost/dsh-podman/valkey:latest"})
	if status.Code(err) != codes.Internal {
		t.Fatalf("tag reference should resolve past image lookup, expected Internal (unconfigured builder), got %v", err)
	}
}

func TestBuildImageRejectsBaseTagForm(t *testing.T) {
	t.Setenv("DSH_PODMAN_DEFAULT_IMAGE", "arch-base")
	server := &Server{Logger: silentLogger()}
	_, err := server.BuildImage(context.Background(), &ctl.BuildImageRequest{ImageId: "localhost/dsh-podman/arch-base:latest", BaseImage: "arch-base"})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("expected InvalidArgument for building over the base image, got %v", err)
	}
}

func TestRebuildImageRejectsBaseTagForm(t *testing.T) {
	t.Setenv("DSH_PODMAN_DEFAULT_IMAGE", "arch-base")
	server := &Server{Logger: silentLogger()}
	_, err := server.RebuildImage(context.Background(), &ctl.RebuildImageRequest{ImageId: "arch-base:latest"})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("expected InvalidArgument for rebuilding the base image, got %v", err)
	}
}

func TestRemoveImageRejectsBase(t *testing.T) {
	t.Setenv("DSH_PODMAN_DEFAULT_IMAGE", "arch-base")
	server := &Server{Store: newTestStore(t), Logger: silentLogger()}
	for _, image := range []string{"arch-base", "arch-base:latest", "localhost/dsh-podman/arch-base:latest"} {
		_, err := server.RemoveImage(context.Background(), &ctl.RemoveImageRequest{ImageId: image})
		if status.Code(err) != codes.InvalidArgument {
			t.Errorf("image %q: expected InvalidArgument, got %v", image, err)
		}
	}
}

func TestRemoveImageUnknown(t *testing.T) {
	server := &Server{Store: newTestStore(t), Logger: silentLogger()}
	_, err := server.RemoveImage(context.Background(), &ctl.RemoveImageRequest{ImageId: "nope"})
	if status.Code(err) != codes.NotFound {
		t.Fatalf("expected NotFound, got %v", err)
	}
}

func TestRemoveImageInUse(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveImages([]state.Image{{ImageID: "valkey", ImageTag: "localhost/dsh-podman/valkey:latest"}}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveWorkspaces([]state.Workspace{{
		WorkspaceSlug: "valkey-ws",
		Containers:    []state.Container{{Name: "valkey-ctr", ImageID: "valkey"}},
	}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}
	_, err := server.RemoveImage(context.Background(), &ctl.RemoveImageRequest{ImageId: "localhost/dsh-podman/valkey:latest"})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("named container in use: expected FailedPrecondition, got %v", err)
	}
	if err := store.SaveWorkspaces([]state.Workspace{{
		WorkspaceSlug: "valkey-ws",
		ImageID:       "valkey",
		Containers:    []state.Container{{Name: "default", ImageID: "valkey"}},
	}}); err != nil {
		t.Fatal(err)
	}
	_, err = server.RemoveImage(context.Background(), &ctl.RemoveImageRequest{ImageId: "valkey"})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("workspace default container in use: expected FailedPrecondition, got %v", err)
	}
}

func TestRemoveImageRequiresPodman(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveImages([]state.Image{{ImageID: "valkey", ImageTag: "localhost/dsh-podman/valkey:latest"}}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveWorkspaces([]state.Workspace{{
		WorkspaceSlug: "other-ws",
		Containers:    []state.Container{{Name: "default", ImageID: "arch"}},
	}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}
	_, err := server.RemoveImage(context.Background(), &ctl.RemoveImageRequest{ImageId: "valkey"})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("expected FailedPrecondition, got %v", err)
	}
}

func TestImageRefsMatch(t *testing.T) {
	cases := []struct {
		name  string
		a, b  string
		match bool
	}{
		{"identical short id", "valkey", "valkey", true},
		{"short id vs qualified tag", "valkey", "localhost/dsh-podman/valkey:latest", true},
		{"qualified vs short tag", "localhost/dsh-podman/valkey", "valkey:latest", true},
		{"qualified vs qualified tag", "localhost/dsh-podman/valkey", "localhost/dsh-podman/valkey:latest", true},
		{"tag vs tag", "valkey:latest", "valkey:latest", true},
		{"differing short ids", "valkey", "redis", false},
		{"differing qualified ids", "localhost/dsh-podman/valkey", "localhost/dsh-podman/redis", false},
		{"different prefixes", "registry.example.com/x/valkey", "localhost/dsh-podman/valkey", false},
	}
	for _, tc := range cases {
		if got := imageRefsMatch(tc.a, tc.b); got != tc.match {
			t.Errorf("%s: imageRefsMatch(%q, %q) = %v, want %v", tc.name, tc.a, tc.b, got, tc.match)
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

func TestValidateEnv(t *testing.T) {
	for _, env := range []map[string]string{
		{"DSH_PODMAN_X": "1"},
		{"": "v"},
		{"a=b": "v"},
		{"a\x00b": "v"},
		{"a": "b\x00c"},
	} {
		if err := validateEnv(env); err == nil {
			t.Errorf("accepted invalid env %#v", env)
		}
	}
	if err := validateEnv(map[string]string{"FOO": "bar", "BAZ": "qux"}); err != nil {
		t.Fatalf("rejected valid env: %v", err)
	}
	if err := validateEnv(nil); err != nil {
		t.Fatalf("rejected nil env: %v", err)
	}
}

func TestStartContainerRejectsReservedEnv(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{WorkspaceSlug: "proj", ContainerName: "dsh-workspace-proj"}}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveImages([]state.Image{{ImageID: "arch", ImageTag: "localhost/dsh-podman/arch:latest"}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}
	_, err := server.StartContainer(context.Background(), &ctl.StartContainerRequest{WorkspaceSlug: "proj", Container: "dev", ImageId: "arch", Env: map[string]string{"DSH_PODMAN_X": "1"}})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("expected InvalidArgument, got %v", err)
	}
}

func TestRecreateContainerRejectsReservedEnv(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{WorkspaceSlug: "proj", Containers: []state.Container{{Name: "dev", PodmanName: "dsh-workspace-proj-dev", ImageID: "arch"}}}}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveImages([]state.Image{{ImageID: "arch", ImageTag: "localhost/dsh-podman/arch:latest"}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}
	_, err := server.RecreateContainer(context.Background(), &ctl.RecreateContainerRequest{WorkspaceSlug: "proj", Container: "dev", ImageId: "arch", Env: map[string]string{"DSH_PODMAN_X": "1"}})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("expected InvalidArgument, got %v", err)
	}
}

func TestCreateWorkspaceRejectsReservedEnv(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveImages([]state.Image{{ImageID: "arch-base", ImageTag: "t1"}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}
	_, err := server.CreateWorkspace(context.Background(), &ctl.CreateWorkspaceRequest{WorkspaceSlug: "proj", ImageId: "arch-base", Env: map[string]string{"DSH_PODMAN_X": "1"}})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("expected InvalidArgument, got %v", err)
	}
}

func TestContainerMountsFallback(t *testing.T) {
	ws := state.Workspace{Mounts: []state.Mount{{ProjectName: "a", Mode: "read_only"}}}
	if got := containerMounts(ws, state.Container{}); len(got) != 1 || got[0].ProjectName != "a" {
		t.Fatalf("expected workspace fallback, got %#v", got)
	}
	withOwn := state.Container{Mounts: []state.Mount{{ProjectName: "b", Mode: "read_write", Path: "src"}}}
	got := containerMounts(ws, withOwn)
	if len(got) != 1 || got[0].ProjectName != "b" || got[0].Path != "src" || got[0].Mode != "read_write" {
		t.Fatalf("expected container's own mounts, got %#v", got)
	}
}

func TestMountFromProto(t *testing.T) {
	mount := mountFromProto(&ctl.ProjectMount{ProjectName: "team", Path: "src", Destination: "/x", Mode: ctl.MountMode_MOUNT_MODE_READ_WRITE})
	if mount.ProjectName != "team" || mount.Mode != "read_write" || mount.Path != "src" || mount.Destination != "/x" {
		t.Fatalf("unexpected mount: %#v", mount)
	}
	if ro := mountFromProto(&ctl.ProjectMount{ProjectName: "team"}); ro.Mode != "read_only" {
		t.Fatalf("expected read_only, got %q", ro.Mode)
	}
}

func TestMountModeFromProto(t *testing.T) {
	if mode, err := mountModeFromProto(ctl.MountMode_MOUNT_MODE_READ_WRITE); err != nil || mode != "read_write" {
		t.Fatalf("unexpected: %q %v", mode, err)
	}
	if mode, err := mountModeFromProto(ctl.MountMode_MOUNT_MODE_READ_ONLY); err != nil || mode != "read_only" {
		t.Fatalf("unexpected: %q %v", mode, err)
	}
	if _, err := mountModeFromProto(ctl.MountMode_MOUNT_MODE_UNSPECIFIED); err == nil {
		t.Fatal("expected error for unspecified mode")
	}
}

func TestResolveMount(t *testing.T) {
	root := t.TempDir()
	hostRoot := filepath.Join(t.TempDir(), "host")
	if err := os.MkdirAll(filepath.Join(root, "team", "src"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(hostRoot, "team", "src"), 0755); err != nil {
		t.Fatal(err)
	}
	host, dest, err := resolveMount(root, "", state.Mount{ProjectName: "team", Path: "src", Mode: "read_only"})
	if err != nil {
		t.Fatal(err)
	}
	if host != filepath.Join(root, "team", "src") || dest != filepath.Join(root, "team", "src") {
		t.Fatalf("unexpected resolve: %q %q", host, dest)
	}
	validDest := filepath.Join(root, "custom", "mount")
	host, dest, err = resolveMount(root, "", state.Mount{ProjectName: "team", Path: "src", Destination: validDest})
	if err != nil {
		t.Fatal(err)
	}
	if host != filepath.Join(root, "team", "src") || dest != validDest {
		t.Fatalf("unexpected resolve: %q %q", host, dest)
	}
	host, dest, err = resolveMount(root, hostRoot, state.Mount{ProjectName: "team", Path: "src", Destination: filepath.Join(root, "team", "code")})
	if err != nil {
		t.Fatal(err)
	}
	if host != filepath.Join(hostRoot, "team", "src") || dest != filepath.Join(root, "team", "code") {
		t.Fatalf("unexpected resolve: %q %q", host, dest)
	}
	for _, path := range []string{"..", "../x", "/abs", "a/../b", "a//b", "a/b/", "."} {
		if _, _, err := resolveMount(root, "", state.Mount{ProjectName: "team", Path: path}); err == nil {
			t.Errorf("accepted invalid subpath %q", path)
		}
	}
	for _, dest := range []string{"relative", "/outside", "/workspaces2/x", "/workspaces/../x", "/workspaces/team/../src/"} {
		if _, _, err := resolveMount(root, "", state.Mount{ProjectName: "team", Path: "src", Destination: dest}); err == nil {
			t.Errorf("accepted invalid destination %q", dest)
		}
	}
	if _, _, err := resolveMount(root, "", state.Mount{ProjectName: "team", Path: "missing"}); err == nil {
		t.Fatal("accepted a missing subpath")
	}
	if _, _, err := resolveMount(root, "", state.Mount{ProjectName: "nope"}); err == nil {
		t.Fatal("accepted a missing project")
	}
}

func TestPodmanMountsSubpathAndDestination(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "team", "src"), 0755); err != nil {
		t.Fatal(err)
	}
	server := &Server{ProjectsRoot: root, Logger: silentLogger()}
	mounts, err := server.podmanMounts([]state.Mount{{ProjectName: "team", Path: "src", Mode: "read_write"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(mounts) != 1 || mounts[0].Type != "bind" || mounts[0].Source != filepath.Join(root, "team", "src") || mounts[0].Destination != filepath.Join(root, "team", "src") || len(mounts[0].Options) != 1 || mounts[0].Options[0] != "rw" {
		t.Fatalf("unexpected podman mount: %#v", mounts)
	}
	if _, err := server.podmanMounts([]state.Mount{{ProjectName: "team", Path: "../x"}}); status.Code(err) != codes.InvalidArgument {
		t.Fatalf("expected InvalidArgument for subpath, got %v", err)
	}
	if _, err := server.podmanMounts([]state.Mount{{ProjectName: "team", Destination: "/outside"}}); status.Code(err) != codes.InvalidArgument {
		t.Fatalf("expected InvalidArgument for destination, got %v", err)
	}
}

func TestContainerProtoProjectsContainerMounts(t *testing.T) {
	ws := state.Workspace{
		WorkspaceSlug: "proj",
		Mounts:        []state.Mount{{ProjectName: "ws", Mode: "read_only"}},
		Containers: []state.Container{{
			Name:   "dev",
			Mounts: []state.Mount{{ProjectName: "devp", Mode: "read_write", Path: "src/lib", Destination: "/workspaces/devp/src/lib"}},
		}},
	}
	row := containerProto(ws, ws.Containers[0])
	if len(row.Mounts) != 1 || row.Mounts[0].ProjectName != "devp" || row.Mounts[0].Mode != ctl.MountMode_MOUNT_MODE_READ_WRITE || row.Mounts[0].Path != "src/lib" || row.Mounts[0].Destination != "/workspaces/devp/src/lib" {
		t.Fatalf("container mounts not projected: %#v", row.Mounts)
	}
	fallback := containerProto(ws, state.Container{Name: "default"})
	if len(fallback.Mounts) != 1 || fallback.Mounts[0].ProjectName != "ws" || fallback.Mounts[0].Mode != ctl.MountMode_MOUNT_MODE_READ_ONLY {
		t.Fatalf("workspace fallback not projected: %#v", fallback.Mounts)
	}
}

func TestAddContainerMount(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "team", "src"), 0755); err != nil {
		t.Fatal(err)
	}
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{
		WorkspaceSlug: "proj",
		Mounts:        []state.Mount{{ProjectName: "team", Mode: "read_write"}},
		Containers: []state.Container{
			{Name: "default", PodmanName: "dsh-workspace-proj", ImageID: "arch", Status: "running"},
			{Name: "dev", PodmanName: "dsh-workspace-proj-dev", ImageID: "arch", Status: "running"},
		},
	}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, ProjectsRoot: root, Logger: silentLogger()}

	_, err := server.AddContainerMount(context.Background(), &ctl.AddContainerMountRequest{WorkspaceSlug: "nope", Container: "dev", Project: "team", Mode: ctl.MountMode_MOUNT_MODE_READ_ONLY})
	if status.Code(err) != codes.NotFound {
		t.Fatalf("unknown workspace: expected NotFound, got %v", err)
	}
	_, err = server.AddContainerMount(context.Background(), &ctl.AddContainerMountRequest{WorkspaceSlug: "proj", Container: "nope", Project: "team", Mode: ctl.MountMode_MOUNT_MODE_READ_ONLY})
	if status.Code(err) != codes.NotFound {
		t.Fatalf("unknown container: expected NotFound, got %v", err)
	}
	_, err = server.AddContainerMount(context.Background(), &ctl.AddContainerMountRequest{WorkspaceSlug: "proj", Container: "dev", Project: "missing", Mode: ctl.MountMode_MOUNT_MODE_READ_ONLY})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("invalid project: expected InvalidArgument, got %v", err)
	}
	_, err = server.AddContainerMount(context.Background(), &ctl.AddContainerMountRequest{WorkspaceSlug: "proj", Container: "dev", Project: "team", Path: "../x", Mode: ctl.MountMode_MOUNT_MODE_READ_ONLY})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("invalid path: expected InvalidArgument, got %v", err)
	}
	_, err = server.AddContainerMount(context.Background(), &ctl.AddContainerMountRequest{WorkspaceSlug: "proj", Container: "dev", Project: "team", Path: "src", Destination: "/outside", Mode: ctl.MountMode_MOUNT_MODE_READ_ONLY})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("invalid destination: expected InvalidArgument, got %v", err)
	}
	_, err = server.AddContainerMount(context.Background(), &ctl.AddContainerMountRequest{WorkspaceSlug: "proj", Container: "dev", Project: "team", Mode: ctl.MountMode_MOUNT_MODE_UNSPECIFIED})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("invalid mode: expected InvalidArgument, got %v", err)
	}

	_, err = server.AddContainerMount(context.Background(), &ctl.AddContainerMountRequest{WorkspaceSlug: "proj", Container: "dev", Project: "team", Path: "src", Mode: ctl.MountMode_MOUNT_MODE_READ_ONLY})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("valid add to named container: expected FailedPrecondition, got %v", err)
	}
	_, err = server.AddContainerMount(context.Background(), &ctl.AddContainerMountRequest{WorkspaceSlug: "proj", Container: "default", Project: "team", Path: "src", Destination: filepath.Join(root, "team", "other"), Mode: ctl.MountMode_MOUNT_MODE_READ_ONLY})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("valid add to default container: expected FailedPrecondition, got %v", err)
	}

	_, err = server.AddContainerMount(context.Background(), &ctl.AddContainerMountRequest{WorkspaceSlug: "proj", Container: "dev", Project: "team", Mode: ctl.MountMode_MOUNT_MODE_READ_ONLY})
	if status.Code(err) != codes.AlreadyExists {
		t.Fatalf("duplicate mount: expected AlreadyExists, got %v", err)
	}
}

func TestRemoveContainerMount(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "team", "src"), 0755); err != nil {
		t.Fatal(err)
	}
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{
		WorkspaceSlug: "proj",
		Mounts:        []state.Mount{{ProjectName: "team", Mode: "read_write"}},
		Containers: []state.Container{
			{Name: "default", PodmanName: "dsh-workspace-proj", ImageID: "arch", Status: "running"},
			{Name: "dev", PodmanName: "dsh-workspace-proj-dev", ImageID: "arch", Status: "running", Mounts: []state.Mount{{ProjectName: "team", Path: "src", Mode: "read_only"}, {ProjectName: "team", Mode: "read_write"}}},
		},
	}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, ProjectsRoot: root, Logger: silentLogger()}

	_, err := server.RemoveContainerMount(context.Background(), &ctl.RemoveContainerMountRequest{WorkspaceSlug: "nope", Container: "dev", Project: "team"})
	if status.Code(err) != codes.NotFound {
		t.Fatalf("unknown workspace: expected NotFound, got %v", err)
	}
	_, err = server.RemoveContainerMount(context.Background(), &ctl.RemoveContainerMountRequest{WorkspaceSlug: "proj", Container: "nope", Project: "team"})
	if status.Code(err) != codes.NotFound {
		t.Fatalf("unknown container: expected NotFound, got %v", err)
	}
	_, err = server.RemoveContainerMount(context.Background(), &ctl.RemoveContainerMountRequest{WorkspaceSlug: "proj", Container: "dev", Project: "team", Path: "nope"})
	if status.Code(err) != codes.NotFound {
		t.Fatalf("unknown mount: expected NotFound, got %v", err)
	}
	_, err = server.RemoveContainerMount(context.Background(), &ctl.RemoveContainerMountRequest{WorkspaceSlug: "proj", Container: "dev", Project: "team", Path: "src"})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("matching mount removal: expected FailedPrecondition, got %v", err)
	}
	_, err = server.RemoveContainerMount(context.Background(), &ctl.RemoveContainerMountRequest{WorkspaceSlug: "proj", Container: "default", Project: "team"})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("workspace-seeded mount removal: expected FailedPrecondition, got %v", err)
	}
}

func TestStartContainerMountsValidation(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "team", "src"), 0755); err != nil {
		t.Fatal(err)
	}
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{WorkspaceSlug: "proj", ContainerName: "dsh-workspace-proj"}}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveImages([]state.Image{{ImageID: "arch", ImageTag: "localhost/dsh-podman/arch:latest"}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, ProjectsRoot: root, Logger: silentLogger()}
	_, err := server.StartContainer(context.Background(), &ctl.StartContainerRequest{WorkspaceSlug: "proj", Container: "dev", Mounts: []*ctl.ProjectMount{{ProjectName: "team", Path: "../x"}}})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("invalid mount: expected InvalidArgument, got %v", err)
	}
	_, err = server.StartContainer(context.Background(), &ctl.StartContainerRequest{WorkspaceSlug: "proj", Container: "dev", ImageId: "arch", Mounts: []*ctl.ProjectMount{{ProjectName: "team", Path: "src", Mode: ctl.MountMode_MOUNT_MODE_READ_WRITE}}})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("valid mounts: expected FailedPrecondition, got %v", err)
	}
}

func TestRecreateContainerMountsValidation(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "team", "src"), 0755); err != nil {
		t.Fatal(err)
	}
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{WorkspaceSlug: "proj", Mounts: []state.Mount{{ProjectName: "team", Mode: "read_only"}}, Containers: []state.Container{{Name: "dev", PodmanName: "dsh-workspace-proj-dev", ImageID: "arch"}}}}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveImages([]state.Image{{ImageID: "arch", ImageTag: "localhost/dsh-podman/arch:latest"}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, ProjectsRoot: root, Logger: silentLogger()}
	_, err := server.RecreateContainer(context.Background(), &ctl.RecreateContainerRequest{WorkspaceSlug: "proj", Container: "dev", Mounts: []*ctl.ProjectMount{{ProjectName: "team", Destination: "/outside"}}})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("invalid destination: expected InvalidArgument, got %v", err)
	}
	_, err = server.RecreateContainer(context.Background(), &ctl.RecreateContainerRequest{WorkspaceSlug: "proj", Container: "dev", ImageId: "arch", Mounts: []*ctl.ProjectMount{{ProjectName: "team", Path: "src", Mode: ctl.MountMode_MOUNT_MODE_READ_ONLY}}})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("valid mounts: expected FailedPrecondition, got %v", err)
	}
}

func TestCreateWorkspacePreservesDefaultContainerMounts(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "team", "src"), 0755); err != nil {
		t.Fatal(err)
	}
	store := newTestStore(t)
	if err := store.SaveImages([]state.Image{{ImageID: "arch-base", ImageTag: "t1"}}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveWorkspaces([]state.Workspace{{
		WorkspaceSlug: "proj",
		ContainerName: "dsh-workspace-proj",
		ImageID:       "arch-base",
		Containers: []state.Container{{
			Name:       "default",
			PodmanName: "dsh-workspace-proj",
			ImageID:    "arch-base",
			Mounts:     []state.Mount{{ProjectName: "team", Path: "src", Mode: "read_only"}},
		}},
	}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, ProjectsRoot: root, Logger: silentLogger()}
	_, err := server.CreateWorkspace(context.Background(), &ctl.CreateWorkspaceRequest{WorkspaceSlug: "proj", ImageId: "arch-base", Mounts: []*ctl.ProjectMount{{ProjectName: "team", Path: "nope", Mode: ctl.MountMode_MOUNT_MODE_READ_ONLY}}})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("preserved default container mounts should win over invalid request mounts, expected FailedPrecondition, got %v", err)
	}
}

func TestStopContainerDaemonsUnreachable(t *testing.T) {
	server := &Server{Logger: silentLogger()}
	server.stopContainerDaemons(context.Background(), state.Container{AgentSocketPath: "/nonexistent/guest.sock", AgentToken: "tok"})
}

func TestStopContainerDaemonsMissingSocketOrToken(t *testing.T) {
	server := &Server{Logger: silentLogger()}
	server.stopContainerDaemons(context.Background(), state.Container{PodmanName: "dsh-workspace-proj"})
	server.stopContainerDaemons(context.Background(), state.Container{PodmanName: "dsh-workspace-proj", AgentSocketPath: "/nonexistent/guest.sock"})
	server.stopContainerDaemons(context.Background(), state.Container{PodmanName: "dsh-workspace-proj", AgentToken: "tok"})
}

func TestRecreateContainerStopsDaemons(t *testing.T) {
	t.Setenv("DSH_PODMAN_DEFAULT_IMAGE", "arch-base")
	store := newTestStore(t)
	if err := store.SaveImages([]state.Image{{ImageID: "arch-base", ImageTag: "t1"}}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveWorkspaces([]state.Workspace{{
		WorkspaceSlug: "proj",
		Containers: []state.Container{{
			Name: "default", PodmanName: "dsh-workspace-proj", ImageID: "arch-base", Status: "running",
		}},
	}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}

	_, err := server.RecreateContainer(context.Background(), &ctl.RecreateContainerRequest{WorkspaceSlug: "proj", Container: "Bad", ImageId: "arch-base"})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("invalid container name: expected InvalidArgument, got %v", err)
	}
	_, err = server.RecreateContainer(context.Background(), &ctl.RecreateContainerRequest{WorkspaceSlug: "nope", ImageId: "arch-base"})
	if status.Code(err) != codes.NotFound {
		t.Fatalf("unknown workspace: expected NotFound, got %v", err)
	}
	_, err = server.RecreateContainer(context.Background(), &ctl.RecreateContainerRequest{WorkspaceSlug: "proj", ImageId: "arch-base"})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("nil Podman: expected FailedPrecondition, got %v", err)
	}
}

func TestPodmanMountsTmpfsAndVolume(t *testing.T) {
	root := t.TempDir()
	server := &Server{ProjectsRoot: root, VolumePrefix: "dsh-podman-", Logger: silentLogger()}

	mounts, err := server.podmanMounts([]state.Mount{{Kind: "tmpfs", Destination: "/tmp/work", Mode: "read_write"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(mounts) != 1 || mounts[0].Type != "tmpfs" || mounts[0].Source != "" || mounts[0].Destination != "/tmp/work" || len(mounts[0].Options) != 1 || mounts[0].Options[0] != "rw" {
		t.Fatalf("unexpected tmpfs mount: %#v", mounts)
	}

	mounts, err = server.podmanMounts([]state.Mount{{Kind: "volume", Volume: "data", Destination: "/srv/data", Mode: "read_write"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(mounts) != 1 || mounts[0].Type != "volume" || mounts[0].Source != "dsh-podman-data" || mounts[0].Destination != "/srv/data" || len(mounts[0].Options) != 1 || mounts[0].Options[0] != "rw" {
		t.Fatalf("unexpected volume mount: %#v", mounts)
	}

	mounts, err = server.podmanMounts([]state.Mount{{Kind: "volume", Volume: "data", Destination: "/srv/data", Mode: "read_only"}})
	if err != nil {
		t.Fatal(err)
	}
	if mounts[0].Options[0] != "ro" {
		t.Fatalf("expected read-only volume options, got %#v", mounts[0].Options)
	}

	underRoot := filepath.Join(root, "x")
	for _, mount := range []state.Mount{{Kind: "tmpfs", Destination: underRoot}, {Kind: "volume", Volume: "data", Destination: underRoot}, {Kind: "tmpfs", Destination: root}, {Kind: "volume", Volume: "data", Destination: root}} {
		if _, err := server.podmanMounts([]state.Mount{mount}); status.Code(err) != codes.InvalidArgument {
			t.Errorf("mount %#v under projects root: expected InvalidArgument, got %v", mount, err)
		}
	}
	for _, destination := range []string{"relative", "/a/../b", "/a/", "/a/./b"} {
		if _, err := server.podmanMounts([]state.Mount{{Kind: "tmpfs", Destination: destination}}); status.Code(err) != codes.InvalidArgument {
			t.Errorf("destination %q: expected InvalidArgument, got %v", destination, err)
		}
	}
	for _, volume := range []string{"", "-bad", "a/b", "a b", strings.Repeat("a", 65)} {
		if _, err := server.podmanMounts([]state.Mount{{Kind: "volume", Volume: volume, Destination: "/data"}}); status.Code(err) != codes.InvalidArgument {
			t.Errorf("volume name %q: expected InvalidArgument, got %v", volume, err)
		}
	}
	for _, volume := range []string{"data", "a_b.c-1", "x1", "UPPER", strings.Repeat("a", 64)} {
		if _, err := server.podmanMounts([]state.Mount{{Kind: "volume", Volume: volume, Destination: "/data"}}); err != nil {
			t.Errorf("valid volume name %q rejected: %v", volume, err)
		}
	}
	if _, err := server.podmanMounts([]state.Mount{{Kind: "bogus", Destination: "/data"}}); status.Code(err) != codes.InvalidArgument {
		t.Fatalf("unknown kind: expected InvalidArgument, got %v", err)
	}
}

func TestNonProjectDestination(t *testing.T) {
	root := filepath.Join(t.TempDir(), "projects")
	if err := nonProjectDestination(root, "/tmp/work"); err != nil {
		t.Fatalf("valid destination rejected: %v", err)
	}
	for _, destination := range []string{"relative", "/a/../b", "/a/", root, filepath.Join(root, "x"), filepath.Join(root, "x", "y")} {
		if err := nonProjectDestination(root, destination); err == nil {
			t.Errorf("accepted invalid destination %q", destination)
		}
	}
}

func TestVolumeRPCsRequirePodman(t *testing.T) {
	server := &Server{Logger: silentLogger()}
	if _, err := server.ListVolumes(context.Background(), &ctl.ListVolumesRequest{}); status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("ListVolumes: expected FailedPrecondition, got %v", err)
	}
	if _, err := server.CreateVolume(context.Background(), &ctl.CreateVolumeRequest{Name: "data"}); status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("CreateVolume: expected FailedPrecondition, got %v", err)
	}
	if _, err := server.RemoveVolume(context.Background(), &ctl.RemoveVolumeRequest{Name: "data"}); status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("RemoveVolume: expected FailedPrecondition, got %v", err)
	}
}

func TestCreateVolumeRejectsInvalidName(t *testing.T) {
	server := &Server{Logger: silentLogger()}
	for _, name := range []string{"", "-bad", "a/b", "a b", strings.Repeat("a", 65)} {
		if _, err := server.CreateVolume(context.Background(), &ctl.CreateVolumeRequest{Name: name}); status.Code(err) != codes.InvalidArgument {
			t.Errorf("name %q: expected InvalidArgument, got %v", name, err)
		}
	}
	for _, name := range []string{"data", "a_b.c-1", "x1", "UPPER", strings.Repeat("a", 64)} {
		if _, err := server.CreateVolume(context.Background(), &ctl.CreateVolumeRequest{Name: name}); status.Code(err) != codes.FailedPrecondition {
			t.Errorf("valid name %q: expected FailedPrecondition (nil Podman), got %v", name, err)
		}
	}
}

func TestAddContainerMountTmpfsAndVolume(t *testing.T) {
	root := t.TempDir()
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{
		WorkspaceSlug: "proj",
		Containers: []state.Container{
			{Name: "dev", PodmanName: "dsh-workspace-proj-dev", ImageID: "arch", Status: "running"},
		},
	}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, ProjectsRoot: root, VolumePrefix: "dsh-podman-", Logger: silentLogger()}

	_, err := server.AddContainerMount(context.Background(), &ctl.AddContainerMountRequest{WorkspaceSlug: "proj", Container: "dev", Kind: ctl.MountKind_MOUNT_KIND_TMPFS, Destination: filepath.Join(root, "x"), Mode: ctl.MountMode_MOUNT_MODE_READ_WRITE})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("tmpfs under projects root: expected InvalidArgument, got %v", err)
	}
	_, err = server.AddContainerMount(context.Background(), &ctl.AddContainerMountRequest{WorkspaceSlug: "proj", Container: "dev", Kind: ctl.MountKind_MOUNT_KIND_VOLUME, Volume: "data", Destination: filepath.Join(root, "x"), Mode: ctl.MountMode_MOUNT_MODE_READ_WRITE})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("volume under projects root: expected InvalidArgument, got %v", err)
	}
	_, err = server.AddContainerMount(context.Background(), &ctl.AddContainerMountRequest{WorkspaceSlug: "proj", Container: "dev", Kind: ctl.MountKind_MOUNT_KIND_VOLUME, Volume: "bad/name", Destination: "/data", Mode: ctl.MountMode_MOUNT_MODE_READ_WRITE})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("invalid volume name: expected InvalidArgument, got %v", err)
	}
	_, err = server.AddContainerMount(context.Background(), &ctl.AddContainerMountRequest{WorkspaceSlug: "proj", Container: "dev", Kind: ctl.MountKind_MOUNT_KIND_TMPFS, Destination: "/tmp/x", Mode: ctl.MountMode_MOUNT_MODE_READ_ONLY})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("read-only tmpfs: expected InvalidArgument, got %v", err)
	}
	_, err = server.AddContainerMount(context.Background(), &ctl.AddContainerMountRequest{WorkspaceSlug: "proj", Container: "dev", Kind: ctl.MountKind(99), Destination: "/tmp/x", Mode: ctl.MountMode_MOUNT_MODE_READ_WRITE})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("unknown kind: expected InvalidArgument, got %v", err)
	}
	_, err = server.AddContainerMount(context.Background(), &ctl.AddContainerMountRequest{WorkspaceSlug: "proj", Container: "dev", Kind: ctl.MountKind_MOUNT_KIND_VOLUME, Volume: "data", Destination: "/data", Mode: ctl.MountMode_MOUNT_MODE_READ_WRITE})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("valid volume add: expected FailedPrecondition, got %v", err)
	}
	_, err = server.AddContainerMount(context.Background(), &ctl.AddContainerMountRequest{WorkspaceSlug: "proj", Container: "dev", Kind: ctl.MountKind_MOUNT_KIND_TMPFS, Destination: "/tmp/x", Mode: ctl.MountMode_MOUNT_MODE_READ_WRITE})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("valid tmpfs add: expected FailedPrecondition, got %v", err)
	}
	_, err = server.AddContainerMount(context.Background(), &ctl.AddContainerMountRequest{WorkspaceSlug: "nope", Container: "dev", Kind: ctl.MountKind_MOUNT_KIND_VOLUME, Volume: "data", Destination: "/data", Mode: ctl.MountMode_MOUNT_MODE_READ_WRITE})
	if status.Code(err) != codes.NotFound {
		t.Fatalf("unknown workspace: expected NotFound, got %v", err)
	}
	_, err = server.AddContainerMount(context.Background(), &ctl.AddContainerMountRequest{WorkspaceSlug: "proj", Container: "nope", Kind: ctl.MountKind_MOUNT_KIND_VOLUME, Volume: "data", Destination: "/data", Mode: ctl.MountMode_MOUNT_MODE_READ_WRITE})
	if status.Code(err) != codes.NotFound {
		t.Fatalf("unknown container: expected NotFound, got %v", err)
	}
}

func TestAddContainerMountDuplicateTmpfsAndVolume(t *testing.T) {
	root := t.TempDir()
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{
		WorkspaceSlug: "proj",
		Containers: []state.Container{{
			Name: "dev", PodmanName: "dsh-workspace-proj-dev", ImageID: "arch", Status: "running",
			Mounts: []state.Mount{{Kind: "volume", Volume: "data", Destination: "/data", Mode: "read_write"}, {Kind: "tmpfs", Destination: "/tmp/x", Mode: "read_write"}},
		}},
	}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, ProjectsRoot: root, VolumePrefix: "dsh-podman-", Logger: silentLogger()}
	_, err := server.AddContainerMount(context.Background(), &ctl.AddContainerMountRequest{WorkspaceSlug: "proj", Container: "dev", Kind: ctl.MountKind_MOUNT_KIND_VOLUME, Volume: "data", Destination: "/other", Mode: ctl.MountMode_MOUNT_MODE_READ_WRITE})
	if status.Code(err) != codes.AlreadyExists {
		t.Fatalf("duplicate volume: expected AlreadyExists, got %v", err)
	}
	_, err = server.AddContainerMount(context.Background(), &ctl.AddContainerMountRequest{WorkspaceSlug: "proj", Container: "dev", Kind: ctl.MountKind_MOUNT_KIND_TMPFS, Destination: "/tmp/x", Mode: ctl.MountMode_MOUNT_MODE_READ_WRITE})
	if status.Code(err) != codes.AlreadyExists {
		t.Fatalf("duplicate tmpfs: expected AlreadyExists, got %v", err)
	}
}

func TestRemoveContainerMountVolume(t *testing.T) {
	root := t.TempDir()
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{
		WorkspaceSlug: "proj",
		Containers: []state.Container{{
			Name: "dev", PodmanName: "dsh-workspace-proj-dev", ImageID: "arch", Status: "running",
			Mounts: []state.Mount{{Kind: "volume", Volume: "data", Destination: "/data", Mode: "read_write"}},
		}},
	}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, ProjectsRoot: root, VolumePrefix: "dsh-podman-", Logger: silentLogger()}

	_, err := server.RemoveContainerMount(context.Background(), &ctl.RemoveContainerMountRequest{WorkspaceSlug: "proj", Container: "dev", Kind: ctl.MountKind_MOUNT_KIND_VOLUME, Volume: "missing"})
	if status.Code(err) != codes.NotFound {
		t.Fatalf("missing volume: expected NotFound, got %v", err)
	}
	_, err = server.RemoveContainerMount(context.Background(), &ctl.RemoveContainerMountRequest{WorkspaceSlug: "proj", Container: "dev", Project: "team", Path: "src"})
	if status.Code(err) != codes.NotFound {
		t.Fatalf("project match against a volume mount: expected NotFound, got %v", err)
	}
	_, err = server.RemoveContainerMount(context.Background(), &ctl.RemoveContainerMountRequest{WorkspaceSlug: "proj", Container: "dev", Kind: ctl.MountKind_MOUNT_KIND_VOLUME, Volume: "data"})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("matching volume removal: expected FailedPrecondition, got %v", err)
	}
	_, err = server.RemoveContainerMount(context.Background(), &ctl.RemoveContainerMountRequest{WorkspaceSlug: "nope", Container: "dev", Kind: ctl.MountKind_MOUNT_KIND_VOLUME, Volume: "data"})
	if status.Code(err) != codes.NotFound {
		t.Fatalf("unknown workspace: expected NotFound, got %v", err)
	}
	_, err = server.RemoveContainerMount(context.Background(), &ctl.RemoveContainerMountRequest{WorkspaceSlug: "proj", Container: "nope", Kind: ctl.MountKind_MOUNT_KIND_VOLUME, Volume: "data"})
	if status.Code(err) != codes.NotFound {
		t.Fatalf("unknown container: expected NotFound, got %v", err)
	}
}

func TestContainerProtoProjectsTmpfsAndVolumeKinds(t *testing.T) {
	ws := state.Workspace{
		WorkspaceSlug: "proj",
		Containers: []state.Container{{
			Name: "dev",
			Mounts: []state.Mount{
				{Kind: "tmpfs", Destination: "/tmp/work", Mode: "read_write"},
				{Kind: "volume", Volume: "data", Destination: "/data", Mode: "read_only"},
				{ProjectName: "team", Mode: "read_write"},
			},
		}},
	}
	row := containerProto(ws, ws.Containers[0])
	if len(row.Mounts) != 3 {
		t.Fatalf("unexpected mounts: %#v", row.Mounts)
	}
	if row.Mounts[0].Kind != ctl.MountKind_MOUNT_KIND_TMPFS || row.Mounts[0].Destination != "/tmp/work" || row.Mounts[0].Mode != ctl.MountMode_MOUNT_MODE_READ_WRITE {
		t.Fatalf("tmpfs not projected: %#v", row.Mounts[0])
	}
	if row.Mounts[1].Kind != ctl.MountKind_MOUNT_KIND_VOLUME || row.Mounts[1].Volume != "data" || row.Mounts[1].Destination != "/data" || row.Mounts[1].Mode != ctl.MountMode_MOUNT_MODE_READ_ONLY {
		t.Fatalf("volume not projected: %#v", row.Mounts[1])
	}
	if row.Mounts[2].Kind != ctl.MountKind_MOUNT_KIND_PROJECT || row.Mounts[2].ProjectName != "team" {
		t.Fatalf("project kind not projected: %#v", row.Mounts[2])
	}
}

func TestMountFromProtoKindAndVolume(t *testing.T) {
	for _, kind := range []ctl.MountKind{ctl.MountKind_MOUNT_KIND_UNSPECIFIED, ctl.MountKind_MOUNT_KIND_PROJECT} {
		if m := mountFromProto(&ctl.ProjectMount{Kind: kind}); m.Kind != "" {
			t.Fatalf("kind %v should map to empty, got %q", kind, m.Kind)
		}
	}
	if m := mountFromProto(&ctl.ProjectMount{Kind: ctl.MountKind_MOUNT_KIND_TMPFS}); m.Kind != "tmpfs" {
		t.Fatalf("tmpfs kind not mapped, got %q", m.Kind)
	}
	m := mountFromProto(&ctl.ProjectMount{Kind: ctl.MountKind_MOUNT_KIND_VOLUME, Volume: "data", Mode: ctl.MountMode_MOUNT_MODE_READ_WRITE})
	if m.Kind != "volume" || m.Volume != "data" || m.Mode != "read_write" {
		t.Fatalf("volume mount not mapped: %#v", m)
	}
}

func TestMountKindFromProto(t *testing.T) {
	if kind, err := mountKindFromProto(ctl.MountKind_MOUNT_KIND_UNSPECIFIED); err != nil || kind != "" {
		t.Fatalf("unspecified kind: got %q %v", kind, err)
	}
	if kind, err := mountKindFromProto(ctl.MountKind_MOUNT_KIND_PROJECT); err != nil || kind != "" {
		t.Fatalf("project kind: got %q %v", kind, err)
	}
	if kind, err := mountKindFromProto(ctl.MountKind_MOUNT_KIND_TMPFS); err != nil || kind != "tmpfs" {
		t.Fatalf("tmpfs kind: got %q %v", kind, err)
	}
	if kind, err := mountKindFromProto(ctl.MountKind_MOUNT_KIND_VOLUME); err != nil || kind != "volume" {
		t.Fatalf("volume kind: got %q %v", kind, err)
	}
	if _, err := mountKindFromProto(ctl.MountKind(99)); err == nil {
		t.Fatal("expected error for unknown kind")
	}
}

func TestPodmanSecrets(t *testing.T) {
	root := t.TempDir()
	server := &Server{ProjectsRoot: root, SecretPrefix: "dsh-podman-", Logger: silentLogger()}

	secrets, err := server.podmanSecrets([]state.Mount{{Kind: "secret", Secret: "valkey-tls", Destination: "/run/secrets/tls"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(secrets) != 1 || secrets[0] != (specgen.Secret{Source: "dsh-podman-valkey-tls", Target: "/run/secrets/tls"}) {
		t.Fatalf("unexpected secret: %#v", secrets)
	}

	for _, mount := range []state.Mount{
		{Kind: "secret", Secret: "data", Destination: root},
		{Kind: "secret", Secret: "data", Destination: filepath.Join(root, "x")},
	} {
		if _, err := server.podmanSecrets([]state.Mount{mount}); status.Code(err) != codes.InvalidArgument {
			t.Errorf("mount %#v under projects root: expected InvalidArgument, got %v", mount, err)
		}
	}
	for _, name := range []string{"", "-bad", "a/b", "a b", strings.Repeat("a", 65)} {
		if _, err := server.podmanSecrets([]state.Mount{{Kind: "secret", Secret: name, Destination: "/run/secrets/x"}}); status.Code(err) != codes.InvalidArgument {
			t.Errorf("invalid secret name %q: expected InvalidArgument, got %v", name, err)
		}
	}
	if _, err := server.podmanSecrets([]state.Mount{{Kind: "secret", Secret: "data"}}); status.Code(err) != codes.InvalidArgument {
		t.Fatalf("missing destination: expected InvalidArgument, got %v", err)
	}
	if _, err := server.podmanSecrets([]state.Mount{{Kind: "bogus", Secret: "data", Destination: "/x"}}); err != nil {
		t.Fatalf("non-secret mounts should be skipped, got %v", err)
	}
}

func TestContainerEnvSecrets(t *testing.T) {
	server := &Server{SecretPrefix: "dsh-podman-"}
	got := server.containerEnvSecrets(map[string]string{"VALKEY_TOKEN": "valkey-token"})
	if len(got) != 1 || got["VALKEY_TOKEN"] != "dsh-podman-valkey-token" {
		t.Fatalf("unexpected env secrets: %#v", got)
	}
	if got := server.containerEnvSecrets(nil); got != nil {
		t.Fatalf("expected nil for empty input, got %#v", got)
	}
}

func TestRandomSecret(t *testing.T) {
	value, err := randomSecret(0, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(value) != 32 {
		t.Fatalf("expected 32 chars, got %d", len(value))
	}
	for _, c := range value {
		if !strings.ContainsRune(secretAlphabets["alphanumeric"], c) {
			t.Fatalf("alphanumeric charset violated: %q", c)
		}
	}
	value, err = randomSecret(16, "hex")
	if err != nil {
		t.Fatal(err)
	}
	if len(value) != 16 {
		t.Fatalf("expected 16 chars, got %d", len(value))
	}
	for _, c := range value {
		if !strings.ContainsRune(secretAlphabets["hex"], c) {
			t.Fatalf("hex charset violated: %q", c)
		}
	}
	value, err = randomSecret(20, "base64url")
	if err != nil {
		t.Fatal(err)
	}
	if len(value) != 20 {
		t.Fatalf("expected 20 chars, got %d", len(value))
	}
	for _, c := range value {
		if !strings.ContainsRune(secretAlphabets["base64url"], c) {
			t.Fatalf("base64url charset violated: %q", c)
		}
	}
	if value, err := randomSecret(2000, ""); err == nil {
		t.Fatalf("expected error for length 2000, got %q", value)
	}
	if value, err := randomSecret(0, "bogus"); err == nil {
		t.Fatalf("expected error for bad charset, got %q", value)
	}
}

func TestValidateEnvKey(t *testing.T) {
	for _, key := range []string{"DSH_PODMAN_X", "", "A=B", "a\x00b"} {
		if err := validateEnvKey(key); err == nil {
			t.Errorf("accepted invalid env key %q", key)
		}
	}
	if err := validateEnvKey("FOO"); err != nil {
		t.Fatalf("rejected valid env key FOO: %v", err)
	}
}

func TestSecretRPCsRequirePodman(t *testing.T) {
	server := &Server{Logger: silentLogger()}
	if _, err := server.ListSecrets(context.Background(), &ctl.ListSecretsRequest{}); status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("ListSecrets: expected FailedPrecondition, got %v", err)
	}
	if _, err := server.CreateSecret(context.Background(), &ctl.CreateSecretRequest{Name: "data"}); status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("CreateSecret: expected FailedPrecondition, got %v", err)
	}
	if _, err := server.WriteSecretValue(context.Background(), &ctl.WriteSecretValueRequest{Name: "data", Value: "v"}); status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("WriteSecretValue: expected FailedPrecondition, got %v", err)
	}
	if _, err := server.RemoveSecret(context.Background(), &ctl.RemoveSecretRequest{Name: "data"}); status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("RemoveSecret: expected FailedPrecondition, got %v", err)
	}
}

func TestCreateSecretRejectsInvalidName(t *testing.T) {
	server := &Server{Logger: silentLogger()}
	for _, name := range []string{"", "-bad", "a/b", "a b", strings.Repeat("a", 65)} {
		if _, err := server.CreateSecret(context.Background(), &ctl.CreateSecretRequest{Name: name}); status.Code(err) != codes.InvalidArgument {
			t.Errorf("name %q: expected InvalidArgument, got %v", name, err)
		}
	}
	for _, name := range []string{"data", "a_b.c-1", "x1", "UPPER", strings.Repeat("a", 64)} {
		if _, err := server.CreateSecret(context.Background(), &ctl.CreateSecretRequest{Name: name}); status.Code(err) != codes.FailedPrecondition {
			t.Errorf("valid name %q: expected FailedPrecondition (nil Podman), got %v", name, err)
		}
	}
	for _, charset := range []string{"bogus", "UPPER"} {
		if _, err := server.CreateSecret(context.Background(), &ctl.CreateSecretRequest{Name: "data", Charset: charset}); status.Code(err) != codes.InvalidArgument {
			t.Errorf("charset %q: expected InvalidArgument, got %v", charset, err)
		}
	}
	if _, err := server.CreateSecret(context.Background(), &ctl.CreateSecretRequest{Name: "data", Length: 2000}); status.Code(err) != codes.InvalidArgument {
		t.Fatalf("length 2000: expected InvalidArgument, got %v", err)
	}
}

func TestAddContainerSecretRejectsReservedEnv(t *testing.T) {
	root := t.TempDir()
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{
		WorkspaceSlug: "proj",
		Containers: []state.Container{
			{Name: "default", PodmanName: "dsh-workspace-proj", ImageID: "arch", Status: "running"},
			{Name: "dev", PodmanName: "dsh-workspace-proj-dev", ImageID: "arch", Status: "running", SecretEnv: map[string]string{"FOO": "existing"}},
		},
	}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, ProjectsRoot: root, SecretPrefix: "dsh-podman-", Logger: silentLogger()}

	_, err := server.AddContainerSecret(context.Background(), &ctl.AddContainerSecretRequest{WorkspaceSlug: "proj", Container: "dev", Env: "DSH_PODMAN_X", Secret: "data"})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("reserved env: expected InvalidArgument, got %v", err)
	}
	_, err = server.AddContainerSecret(context.Background(), &ctl.AddContainerSecretRequest{WorkspaceSlug: "proj", Container: "nope", Env: "FOO", Secret: "data"})
	if status.Code(err) != codes.NotFound {
		t.Fatalf("unknown container: expected NotFound, got %v", err)
	}
	_, err = server.AddContainerSecret(context.Background(), &ctl.AddContainerSecretRequest{WorkspaceSlug: "nope", Container: "dev", Env: "FOO", Secret: "data"})
	if status.Code(err) != codes.NotFound {
		t.Fatalf("unknown workspace: expected NotFound, got %v", err)
	}
	_, err = server.AddContainerSecret(context.Background(), &ctl.AddContainerSecretRequest{WorkspaceSlug: "proj", Container: "dev", Env: "FOO", Secret: "data"})
	if status.Code(err) != codes.AlreadyExists {
		t.Fatalf("duplicate env: expected AlreadyExists, got %v", err)
	}
	_, err = server.AddContainerSecret(context.Background(), &ctl.AddContainerSecretRequest{WorkspaceSlug: "proj", Container: "dev", Env: "BAR", Secret: "data"})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("valid add: expected FailedPrecondition, got %v", err)
	}
	_, err = server.AddContainerSecret(context.Background(), &ctl.AddContainerSecretRequest{WorkspaceSlug: "proj", Container: "dev", Env: "BAR", Secret: "-bad"})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("invalid secret name: expected InvalidArgument, got %v", err)
	}
}

func TestRemoveContainerSecret(t *testing.T) {
	root := t.TempDir()
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{
		WorkspaceSlug: "proj",
		Containers: []state.Container{
			{Name: "default", PodmanName: "dsh-workspace-proj", ImageID: "arch", Status: "running"},
			{Name: "dev", PodmanName: "dsh-workspace-proj-dev", ImageID: "arch", Status: "running", SecretEnv: map[string]string{"FOO": "existing"}},
		},
	}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, ProjectsRoot: root, SecretPrefix: "dsh-podman-", Logger: silentLogger()}

	_, err := server.RemoveContainerSecret(context.Background(), &ctl.RemoveContainerSecretRequest{WorkspaceSlug: "proj", Container: "dev", Env: "DSH_PODMAN_X"})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("reserved env: expected InvalidArgument, got %v", err)
	}
	_, err = server.RemoveContainerSecret(context.Background(), &ctl.RemoveContainerSecretRequest{WorkspaceSlug: "proj", Container: "dev", Env: "MISSING"})
	if status.Code(err) != codes.NotFound {
		t.Fatalf("unknown env: expected NotFound, got %v", err)
	}
	_, err = server.RemoveContainerSecret(context.Background(), &ctl.RemoveContainerSecretRequest{WorkspaceSlug: "proj", Container: "nope", Env: "FOO"})
	if status.Code(err) != codes.NotFound {
		t.Fatalf("unknown container: expected NotFound, got %v", err)
	}
	_, err = server.RemoveContainerSecret(context.Background(), &ctl.RemoveContainerSecretRequest{WorkspaceSlug: "proj", Container: "dev", Env: "FOO"})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("valid removal: expected FailedPrecondition, got %v", err)
	}
}

func TestSecretKindMapping(t *testing.T) {
	if kind, err := mountKindFromProto(ctl.MountKind_MOUNT_KIND_SECRET); err != nil || kind != "secret" {
		t.Fatalf("secret kind: got %q %v", kind, err)
	}
	if kind := mountKindToProto("secret"); kind != ctl.MountKind_MOUNT_KIND_SECRET {
		t.Fatalf("secret kind projection: got %v", kind)
	}
	m := mountFromProto(&ctl.ProjectMount{Kind: ctl.MountKind_MOUNT_KIND_SECRET, Secret: "valkey-tls", Destination: "/run/secrets/tls"})
	if m.Kind != "secret" || m.Secret != "valkey-tls" || m.Destination != "/run/secrets/tls" {
		t.Fatalf("secret mount not mapped: %#v", m)
	}
}

func TestContainerProtoProjectsSecretEnvAndMount(t *testing.T) {
	ws := state.Workspace{
		WorkspaceSlug: "proj",
		Containers: []state.Container{{
			Name:      "dev",
			SecretEnv: map[string]string{"VALKEY_TOKEN": "valkey-token"},
			Mounts:    []state.Mount{{Kind: "secret", Secret: "valkey-tls", Destination: "/run/secrets/tls"}},
		}},
	}
	row := containerProto(ws, ws.Containers[0])
	if len(row.SecretEnv) != 1 || row.SecretEnv["VALKEY_TOKEN"] != "valkey-token" {
		t.Fatalf("secret env not projected: %#v", row.SecretEnv)
	}
	if len(row.Mounts) != 1 || row.Mounts[0].Kind != ctl.MountKind_MOUNT_KIND_SECRET || row.Mounts[0].Secret != "valkey-tls" || row.Mounts[0].Destination != "/run/secrets/tls" {
		t.Fatalf("secret mount not projected: %#v", row.Mounts)
	}
}

func TestPodmanMountsSkipsSecretKinds(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "team"), 0755); err != nil {
		t.Fatal(err)
	}
	server := &Server{ProjectsRoot: root, SecretPrefix: "dsh-podman-", Logger: silentLogger()}
	mounts, err := server.podmanMounts([]state.Mount{
		{ProjectName: "team", Mode: "read_only"},
		{Kind: "secret", Secret: "data", Destination: "/run/secrets/x"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(mounts) != 1 || mounts[0].Type != "bind" || mounts[0].Source != filepath.Join(root, "team") {
		t.Fatalf("secret mount leaked into OCI mounts: %#v", mounts)
	}
}

const (
	rebuildAllBaseTag = "localhost/dsh-podman/arch-base:latest"
	rebuildAllMidTag  = "localhost/dsh-podman/mid:latest"
	rebuildAllTopTag  = "localhost/dsh-podman/top:latest"
)

func sameStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func sameImageIDs(images []state.Image, ids []string) bool {
	if len(images) != len(ids) {
		return false
	}
	for i := range images {
		if images[i].ImageID != ids[i] {
			return false
		}
	}
	return true
}

func rebuildAllImagesFixtures() []state.Image {
	return []state.Image{
		{ImageID: DefaultImageID(), BaseImage: "docker.io/library/archlinux:latest", ImageTag: rebuildAllBaseTag, BuiltAt: "old"},
		{ImageID: "localhost/dsh-podman/mid", BaseImage: rebuildAllBaseTag, ImageTag: rebuildAllMidTag, BuiltAt: "old"},
		{ImageID: "localhost/dsh-podman/top", BaseImage: rebuildAllMidTag, ImageTag: rebuildAllTopTag, BuiltAt: "old"},
	}
}

func TestRebuildAllImagesRequiresBuilder(t *testing.T) {
	server := &Server{Store: newTestStore(t), Logger: silentLogger()}
	_, err := server.RebuildAllImages(context.Background(), &ctl.RebuildAllImagesRequest{})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("expected FailedPrecondition, got %v", err)
	}
}

func TestRebuildAllImagesRequiresPodman(t *testing.T) {
	server := &Server{Store: newTestStore(t), ImageBuilder: &imagebuild.Builder{}, Logger: silentLogger()}
	_, err := server.RebuildAllImages(context.Background(), &ctl.RebuildAllImagesRequest{})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("expected FailedPrecondition, got %v", err)
	}
}

func TestRebuildAllImagesNoImages(t *testing.T) {
	server := &Server{Store: newTestStore(t), ImageBuilder: &imagebuild.Builder{}, Podman: &podman.Client{}, Logger: silentLogger()}
	_, err := server.RebuildAllImages(context.Background(), &ctl.RebuildAllImagesRequest{})
	if status.Code(err) != codes.NotFound {
		t.Fatalf("expected NotFound, got %v", err)
	}
}

func TestRebuildAllImagesFailingBuilderSkipsAll(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveImages(rebuildAllImagesFixtures()); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, ImageBuilder: &imagebuild.Builder{}, Podman: &podman.Client{}, Logger: silentLogger(), BuildDefaultImage: true}
	response, err := server.RebuildAllImages(context.Background(), &ctl.RebuildAllImagesRequest{})
	if err != nil {
		t.Fatalf("build failures must not surface as a gRPC error, got %v", err)
	}
	if len(response.Rebuilt) != 0 {
		t.Fatalf("expected no rebuilt images, got %#v", response.Rebuilt)
	}
	want := []string{DefaultImageID(), "localhost/dsh-podman/mid", "localhost/dsh-podman/top"}
	if !sameStrings(response.Skipped, want) {
		t.Fatalf("expected skipped %#v, got %#v", want, response.Skipped)
	}
}

func TestRebuildAllImagesBaseDisabled(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveImages(rebuildAllImagesFixtures()); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, ImageBuilder: &imagebuild.Builder{}, Podman: &podman.Client{}, Logger: silentLogger(), BuildDefaultImage: false}
	response, err := server.RebuildAllImages(context.Background(), &ctl.RebuildAllImagesRequest{})
	if err != nil {
		t.Fatalf("build failures must not surface as a gRPC error, got %v", err)
	}
	if len(response.Rebuilt) != 0 {
		t.Fatalf("expected no rebuilt images, got %#v", response.Rebuilt)
	}
	if !sameStrings(response.Skipped, []string{"localhost/dsh-podman/mid", "localhost/dsh-podman/top"}) {
		t.Fatalf("expected derived images skipped, got %#v", response.Skipped)
	}
	after, err := store.Images()
	if err != nil {
		t.Fatal(err)
	}
	for _, image := range after {
		if image.ImageID == DefaultImageID() && image.BuiltAt != "old" {
			t.Fatalf("default image was rebuilt despite BuildDefaultImage=false: %#v", image)
		}
	}
}

func TestRebuildGraph(t *testing.T) {
	images := []state.Image{
		{ImageID: "a", ImageTag: "tag-a"},
		{ImageID: "b", ImageTag: "tag-b"},
		{ImageID: "c", BaseImage: "tag-a"},
		{ImageID: "d", BaseImage: "tag-b"},
		{ImageID: "e", BaseImage: "tag-a"},
		{ImageID: "f", BaseImage: "missing"},
		{ImageID: "g"},
	}
	byID, byTag, dependents := rebuildGraph(images)
	if len(byID) != 7 {
		t.Fatalf("unexpected byID size: %#v", byID)
	}
	if byTag["tag-a"] != "a" || byTag["tag-b"] != "b" {
		t.Fatalf("unexpected byTag: %#v", byTag)
	}
	if _, ok := byTag[""]; ok {
		t.Fatalf("empty tag must not be indexed: %#v", byTag)
	}
	want := map[string][]string{"a": {"c", "e"}, "b": {"d"}}
	if len(dependents) != len(want) {
		t.Fatalf("unexpected dependents: %#v", dependents)
	}
	for owner, deps := range want {
		if !sameStrings(dependents[owner], deps) {
			t.Fatalf("dependents[%q] = %#v, want %#v", owner, dependents[owner], deps)
		}
	}
	if _, ok := dependents["f"]; ok {
		t.Fatalf("unresolvable base must not create a dependent edge: %#v", dependents)
	}
}

func TestRebuildGraphByIDLastWins(t *testing.T) {
	images := []state.Image{
		{ImageID: "a", ImageTag: "tag-a", Packages: []string{"x"}},
		{ImageID: "a", ImageTag: "tag-a", Packages: []string{"y"}},
	}
	byID, _, _ := rebuildGraph(images)
	if len(byID["a"].Packages) != 1 || byID["a"].Packages[0] != "y" {
		t.Fatalf("expected last image to win, got %#v", byID["a"])
	}
}

func TestRebuildPlanOrder(t *testing.T) {
	images := append(rebuildAllImagesFixtures(),
		state.Image{ImageID: "localhost/dsh-podman/unresolvable", BaseImage: "docker.io/library/does-not-exist:latest", ImageTag: "unresolvable:latest"},
	)
	ordered, skipped := rebuildPlan(images, true)
	wantOrder := []string{DefaultImageID(), "localhost/dsh-podman/mid", "localhost/dsh-podman/top"}
	if !sameImageIDs(ordered, wantOrder) {
		t.Fatalf("expected order %#v, got %#v", wantOrder, ordered)
	}
	if !sameStrings(skipped, []string{"localhost/dsh-podman/unresolvable"}) {
		t.Fatalf("expected unresolvable skipped, got %#v", skipped)
	}
}

func TestRebuildPlanBaseDisabled(t *testing.T) {
	ordered, skipped := rebuildPlan(rebuildAllImagesFixtures(), false)
	wantOrder := []string{"localhost/dsh-podman/mid", "localhost/dsh-podman/top"}
	if !sameImageIDs(ordered, wantOrder) {
		t.Fatalf("expected default excluded from order %#v, got %#v", wantOrder, ordered)
	}
	if len(skipped) != 0 {
		t.Fatalf("expected nothing skipped, got %#v", skipped)
	}
}

func TestRebuildPlanCycleSkipped(t *testing.T) {
	images := []state.Image{
		{ImageID: "cyc-a", BaseImage: "tag-b", ImageTag: "tag-a"},
		{ImageID: "cyc-b", BaseImage: "tag-a", ImageTag: "tag-b"},
	}
	ordered, skipped := rebuildPlan(images, true)
	if len(ordered) != 0 {
		t.Fatalf("expected no rebuild candidates for a cycle, got %#v", ordered)
	}
	if !sameStrings(skipped, []string{"cyc-a", "cyc-b"}) {
		t.Fatalf("expected cycle members skipped, got %#v", skipped)
	}
}

func TestSkipDependents(t *testing.T) {
	_, _, dependents := rebuildGraph(rebuildAllImagesFixtures())
	cases := []struct {
		failed string
		want   []string
	}{
		{failed: DefaultImageID(), want: []string{DefaultImageID(), "localhost/dsh-podman/mid", "localhost/dsh-podman/top"}},
		{failed: "localhost/dsh-podman/mid", want: []string{"localhost/dsh-podman/mid", "localhost/dsh-podman/top"}},
		{failed: "localhost/dsh-podman/top", want: []string{"localhost/dsh-podman/top"}},
		{failed: "independent", want: []string{"independent"}},
	}
	for _, tc := range cases {
		if got := skipDependents(dependents, tc.failed); !sameStrings(got, tc.want) {
			t.Fatalf("skipDependents(%q) = %#v, want %#v", tc.failed, got, tc.want)
		}
	}
}
