// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	ctl "github.com/Exagone313/dsh-podman/internal/genproto/dshctl/v1"
	"github.com/Exagone313/dsh-podman/internal/orchestrator/state"
	"github.com/opencontainers/runtime-spec/specs-go"
	"go.podman.io/podman/v6/pkg/specgen"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func TestValidateProject(t *testing.T) {
	root := tempRoot(t)
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

// TestValidateProjectRejectsSymlinkedProject covers a project entry that is a
// symlink leaving the projects root: the project must not resolve, or podman
// would bind-mount the link's target.
func TestValidateProjectRejectsSymlinkedProject(t *testing.T) {
	root := tempRoot(t)
	outside := tempRoot(t)
	if err := os.MkdirAll(filepath.Join(outside, "secrets"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(outside, "secrets"), filepath.Join(root, "escape")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/", filepath.Join(root, "slash")); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"escape", "slash"} {
		if _, err := ValidateProject(root, name); err == nil {
			t.Errorf("accepted symlinked project %q", name)
		}
	}
}

func TestListProjects(t *testing.T) {
	root := tempRoot(t)
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

func TestDescribeWorkspace(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{WorkspaceSlug: testWorkspaceSlug, ContainerName: testDefaultContainer, Status: "running"}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}
	workspace, err := server.DescribeWorkspace(context.Background(), &ctl.DescribeWorkspaceRequest{WorkspaceSlug: testWorkspaceSlug})
	if err != nil {
		t.Fatal(err)
	}
	if workspace.WorkspaceSlug != testWorkspaceSlug || workspace.Status != "running" {
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

func TestCreateWorkspaceRejectsInvalidSlug(t *testing.T) {
	server := &Server{Logger: silentLogger()}
	for _, slug := range []string{"", "a/b", "../x", ".", "..", "-x", "a b", "a:b", "a\\b", "a#b", "a\nb", "x" + strings.Repeat("y", 70), "proj", "team-app", "2c573001-4171-4900-904b", "2c573001-4171-4900-904b-12a5cc02737a-x"} {
		_, err := server.CreateWorkspace(context.Background(), &ctl.CreateWorkspaceRequest{WorkspaceSlug: slug, ImageId: "arch"})
		if status.Code(err) != codes.InvalidArgument {
			t.Errorf("slug %q: expected InvalidArgument, got %v", slug, err)
		}
	}
	for _, slug := range []string{testWorkspaceSlug, "00000000-0000-0000-0000-000000000000", "ABCDEF01-2345-6789-ABCD-EF0123456789"} {
		if !validWorkspaceSlug(slug) {
			t.Errorf("rejected valid slug %q", slug)
		}
	}
}

func (f *fakePodman) CreateWorkspace(_pod, name, _image, _token string, _mounts []specs.Mount, _secrets []specgen.Secret, _envSecrets, _env map[string]string, paths []string) error {
	if f.createErr != nil {
		return f.createErr
	}
	f.created = append(f.created, name)
	f.createdPaths = append([]string(nil), paths...)
	f.exists[name] = true
	f.running[name] = true
	return nil
}

func TestCreateWorkspaceRejectsReservedEnv(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveImages([]state.Image{{ImageID: "devimg", ImageTag: "t1"}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}
	_, err := server.CreateWorkspace(context.Background(), &ctl.CreateWorkspaceRequest{WorkspaceSlug: testWorkspaceSlug, ImageId: "devimg", Env: map[string]string{"DSH_PODMAN_X": "1"}})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("expected InvalidArgument, got %v", err)
	}
}

func TestCreateWorkspaceRequiresProjectName(t *testing.T) {
	server := &Server{Store: newTestStore(t), Logger: silentLogger()}
	_, err := server.CreateWorkspace(context.Background(), &ctl.CreateWorkspaceRequest{WorkspaceSlug: testWorkspaceSlug})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("expected InvalidArgument without a project name, got %v", err)
	}
	for _, name := range []string{"../x", "/abs", "a/../b"} {
		_, err := server.CreateWorkspace(context.Background(), &ctl.CreateWorkspaceRequest{WorkspaceSlug: testWorkspaceSlug, ProjectName: name})
		if status.Code(err) != codes.InvalidArgument {
			t.Errorf("project name %q: expected InvalidArgument, got %v", name, err)
		}
	}
}

func TestRemoveWorkspaceRemovesPodAndRecord(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{
		WorkspaceSlug: testWorkspaceSlug,
		ContainerName: testDefaultContainer,
		ImageID:       "arch",
		Status:        "running",
		Containers: []state.Container{{
			Name: "default", PodmanName: testDefaultContainer, ImageID: "arch", Status: "running",
		}},
	}}); err != nil {
		t.Fatal(err)
	}
	fake := newFakePodman()
	server := &Server{Store: store, Podman: fake, SocketsRoot: t.TempDir(), Logger: silentLogger()}

	if _, err := server.RemoveWorkspace(context.Background(), &ctl.RemoveWorkspaceRequest{WorkspaceSlug: testWorkspaceSlug}); err != nil {
		t.Fatal(err)
	}
	if !sameStrings(fake.removedPods, []string{podNameFor(testWorkspaceSlug)}) {
		t.Fatalf("pod not removed: %#v", fake.removedPods)
	}
	if !sameStrings(fake.removedSocketDirs, []string{testDefaultContainer}) {
		t.Fatalf("socket dir not removed: %#v", fake.removedSocketDirs)
	}
	workspaces, err := store.Workspaces()
	if err != nil {
		t.Fatal(err)
	}
	if len(workspaces) != 0 {
		t.Fatalf("workspace not dropped: %#v", workspaces)
	}
	// Idempotent: a second call succeeds and still removes the (absent) pod.
	if _, err := server.RemoveWorkspace(context.Background(), &ctl.RemoveWorkspaceRequest{WorkspaceSlug: testWorkspaceSlug}); err != nil {
		t.Fatalf("second RemoveWorkspace: %v", err)
	}
}

func TestRemoveWorkspaceRejectsInvalidSlug(t *testing.T) {
	server := &Server{Store: newTestStore(t), Podman: newFakePodman(), Logger: silentLogger()}
	_, err := server.RemoveWorkspace(context.Background(), &ctl.RemoveWorkspaceRequest{WorkspaceSlug: "nope"})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("expected InvalidArgument, got %v", err)
	}
}

func TestRemoveWorkspaceWithoutPodman(t *testing.T) {
	server := &Server{Store: newTestStore(t), Logger: silentLogger()}
	_, err := server.RemoveWorkspace(context.Background(), &ctl.RemoveWorkspaceRequest{WorkspaceSlug: testWorkspaceSlug})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("expected FailedPrecondition, got %v", err)
	}
}

// TestSyncDefaultFieldsTracksDefaultMounts pins the workspace-level mount list
// to the default container's, so a later fallback (a fresh default container)
// does not restore a stale mode.
func TestSyncDefaultFieldsTracksDefaultMounts(t *testing.T) {
	synced := state.Workspace{
		WorkspaceSlug: "proj",
		ProjectName:   "team",
		Mounts:        []state.Mount{{ProjectName: "team", Mode: "read_write"}},
		Containers: []state.Container{{
			Name: "default", PodmanName: "dsh-podman-proj-default",
			Mounts: []state.Mount{{ProjectName: "team", Mode: "read_only"}},
		}},
	}
	syncDefaultFields(&synced)
	if len(synced.Mounts) != 1 || synced.Mounts[0].Mode != "read_only" {
		t.Fatalf("expected the workspace mounts to track the default container, got %#v", synced.Mounts)
	}

	// A default container with no own mounts leaves the fallback untouched.
	fallback := state.Workspace{
		ProjectName: "team",
		Mounts:      []state.Mount{{ProjectName: "team", Mode: "read_only"}},
		Containers:  []state.Container{{Name: "default", PodmanName: "dsh-podman-proj-default"}},
	}
	syncDefaultFields(&fallback)
	if len(fallback.Mounts) != 1 || fallback.Mounts[0].Mode != "read_only" {
		t.Fatalf("an empty default container must not clear the fallback, got %#v", fallback.Mounts)
	}

	// No default container keeps the last-known list for a fresh one.
	removed := state.Workspace{
		ProjectName: "team",
		Mounts:      []state.Mount{{ProjectName: "team", Mode: "read_only"}},
	}
	syncDefaultFields(&removed)
	if len(removed.Mounts) != 1 || removed.Mounts[0].Mode != "read_only" {
		t.Fatalf("removing the default container must keep the last-known mounts, got %#v", removed.Mounts)
	}
}
