// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"context"
	"os"
	"path/filepath"
	"slices"
	"testing"

	ctl "github.com/Exagone313/dsh-podman/internal/genproto/dshctl/v1"
	"github.com/Exagone313/dsh-podman/internal/orchestrator/state"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func TestValidPathAdditions(t *testing.T) {
	got, err := validPathAdditions([]string{"/opt/bin", "/usr/local/bin", "/opt/bin", ""})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(got, []string{"/opt/bin", "/usr/local/bin"}) {
		t.Fatalf("unexpected paths: %#v", got)
	}
	if got, err := validPathAdditions(nil); err != nil || len(got) != 0 {
		t.Fatalf("nil list: %#v %v", got, err)
	}
	for _, bad := range []string{"relative", "/a/../b", "/a/", "/a:b", "/a\nb", "/a\x00b"} {
		if _, err := validPathAdditions([]string{bad}); err == nil {
			t.Errorf("accepted invalid path %q", bad)
		}
	}
	if _, err := validPathAdditions([]string{"/"}); err != nil {
		t.Errorf("rejected the root path: %v", err)
	}
}

func TestSetContainerPathsPersistsAndProjects(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{
		WorkspaceSlug: "proj",
		Containers: []state.Container{{
			Name: "default", PodmanName: "dsh-podman-proj-default", ImageID: "arch", Status: "running",
		}},
	}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}
	container, err := server.SetContainerPaths(context.Background(), &ctl.SetContainerPathsRequest{
		WorkspaceSlug: "proj", Container: "default", Paths: []string{"/opt/bin", "/opt/bin", "/usr/local/bin"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(container.GetPaths(), []string{"/opt/bin", "/usr/local/bin"}) {
		t.Fatalf("unexpected projected paths: %#v", container.GetPaths())
	}
	stored, err := store.Workspaces()
	if err != nil {
		t.Fatal(err)
	}
	record, ok := containerByLogical(&stored[0], "default")
	if !ok || !slices.Equal(record.Paths, []string{"/opt/bin", "/usr/local/bin"}) {
		t.Fatalf("paths not persisted: %#v", record)
	}
	// Replacing the list overwrites it.
	if _, err := server.SetContainerPaths(context.Background(), &ctl.SetContainerPathsRequest{WorkspaceSlug: "proj", Container: "default", Paths: []string{"/only"}}); err != nil {
		t.Fatal(err)
	}
	stored, _ = store.Workspaces()
	record, _ = containerByLogical(&stored[0], "default")
	if !slices.Equal(record.Paths, []string{"/only"}) {
		t.Fatalf("paths not replaced: %#v", record.Paths)
	}

	for _, tc := range []struct {
		label   string
		request *ctl.SetContainerPathsRequest
	}{
		{"unknown workspace", &ctl.SetContainerPathsRequest{WorkspaceSlug: "nope", Container: "default"}},
		{"unknown container", &ctl.SetContainerPathsRequest{WorkspaceSlug: "proj", Container: "nope"}},
	} {
		if _, err := server.SetContainerPaths(context.Background(), tc.request); status.Code(err) != codes.NotFound {
			t.Errorf("%s: expected NotFound, got %v", tc.label, err)
		}
	}
	if _, err := server.SetContainerPaths(context.Background(), &ctl.SetContainerPathsRequest{WorkspaceSlug: "proj", Container: "default", Paths: []string{"relative"}}); status.Code(err) != codes.InvalidArgument {
		t.Errorf("invalid path: expected InvalidArgument, got %v", err)
	}
}

// TestRecreateContainerPassesPathAdditions pins that a recreate hands the
// persisted additions to the guest container environment.
func TestRecreateContainerPassesPathAdditions(t *testing.T) {
	root := tempRoot(t)
	if err := os.MkdirAll(filepath.Join(root, "team"), 0755); err != nil {
		t.Fatal(err)
	}
	store := newTestStore(t)
	if err := store.SaveImages([]state.Image{{ImageID: "arch", ImageTag: "localhost/dsh-podman/arch:latest"}}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveWorkspaces([]state.Workspace{{
		WorkspaceSlug: "proj", ProjectName: "team",
		Mounts: []state.Mount{{ProjectName: "team", Mode: "read_write"}},
		Containers: []state.Container{{
			Name: "default", PodmanName: "dsh-podman-proj-default", ImageID: "arch", Status: "running",
			Mounts: []state.Mount{{ProjectName: "team", Mode: "read_write"}},
			Paths:  []string{"/opt/bin"},
		}},
	}}); err != nil {
		t.Fatal(err)
	}
	fake := newFakePodman()
	fake.exists["dsh-podman-proj-default"] = true
	server := &Server{Store: store, Podman: fake, ProjectsRoot: root, Logger: silentLogger()}
	if _, err := server.RecreateContainer(context.Background(), &ctl.RecreateContainerRequest{WorkspaceSlug: "proj", Container: "default"}); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(fake.createdPaths, []string{"/opt/bin"}) {
		t.Fatalf("recreate did not pass the path additions: %#v", fake.createdPaths)
	}
}

// pathServer builds a server whose podman double records the PATH additions of
// the container it creates, with one stored workspace and image.
func pathServer(t *testing.T, slug string, paths []string) (*Server, *fakePodman, *state.Store) {
	t.Helper()
	root := tempRoot(t)
	if err := os.MkdirAll(filepath.Join(root, "team"), 0755); err != nil {
		t.Fatal(err)
	}
	store := newTestStore(t)
	if err := store.SaveImages([]state.Image{{ImageID: "arch", ImageTag: "localhost/dsh-podman/arch:latest"}}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveWorkspaces([]state.Workspace{{
		WorkspaceSlug: slug, ProjectName: "team",
		Mounts: []state.Mount{{ProjectName: "team", Mode: "read_write"}},
		Containers: []state.Container{{
			Name: "default", PodmanName: "dsh-podman-" + slug + "-default", ImageID: "arch", Status: "running",
			Mounts: []state.Mount{{ProjectName: "team", Mode: "read_write"}},
			Paths:  paths,
		}},
	}}); err != nil {
		t.Fatal(err)
	}
	fake := newFakePodman()
	fake.exists["dsh-podman-"+slug+"-default"] = true
	return &Server{Store: store, Podman: fake, ProjectsRoot: root, Logger: silentLogger()}, fake, store
}

// TestCreateWorkspaceSetsPathAdditions pins that a create request sets the
// default container's PATH additions.
func TestCreateWorkspaceSetsPathAdditions(t *testing.T) {
	server, fake, store := pathServer(t, testWorkspaceSlug, []string{"/old/bin"})
	// The stored default container is gone (for example its pod was removed),
	// so the create must build it rather than report it as already existing.
	fake.exists = map[string]bool{}
	if _, err := server.CreateWorkspace(context.Background(), &ctl.CreateWorkspaceRequest{
		WorkspaceSlug: testWorkspaceSlug, ProjectName: "team", ImageId: "arch",
		Paths: []string{"/opt/bin", "/opt/bin", "/usr/local/bin"},
	}); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(fake.createdPaths, []string{"/opt/bin", "/usr/local/bin"}) {
		t.Fatalf("create did not pass the path additions: %#v", fake.createdPaths)
	}
	stored, err := store.Workspaces()
	if err != nil {
		t.Fatal(err)
	}
	record, ok := containerByLogical(&stored[0], "default")
	if !ok || !slices.Equal(record.Paths, []string{"/opt/bin", "/usr/local/bin"}) {
		t.Fatalf("paths not persisted: %#v", record)
	}
}

// TestStartContainerSetsPathAdditions pins that a start request sets the
// container's PATH additions instead of keeping the stored ones.
func TestStartContainerSetsPathAdditions(t *testing.T) {
	server, fake, store := pathServer(t, "proj", []string{"/old/bin"})
	if _, err := server.StartContainer(context.Background(), &ctl.StartContainerRequest{
		WorkspaceSlug: "proj", Container: "default", Paths: []string{"/opt/bin", "/opt/bin", "/usr/local/bin"},
	}); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(fake.createdPaths, []string{"/opt/bin", "/usr/local/bin"}) {
		t.Fatalf("start did not pass the path additions: %#v", fake.createdPaths)
	}
	stored, err := store.Workspaces()
	if err != nil {
		t.Fatal(err)
	}
	record, ok := containerByLogical(&stored[0], "default")
	if !ok || !slices.Equal(record.Paths, []string{"/opt/bin", "/usr/local/bin"}) {
		t.Fatalf("paths not persisted: %#v", record)
	}
}

// TestRecreateContainerSetsPathAdditions pins that a recreate request replaces
// the container's PATH additions.
func TestRecreateContainerSetsPathAdditions(t *testing.T) {
	server, fake, store := pathServer(t, "proj", []string{"/old/bin"})
	if _, err := server.RecreateContainer(context.Background(), &ctl.RecreateContainerRequest{
		WorkspaceSlug: "proj", Container: "default", Paths: []string{"/new/bin"},
	}); err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(fake.createdPaths, []string{"/new/bin"}) {
		t.Fatalf("recreate did not pass the path additions: %#v", fake.createdPaths)
	}
	stored, err := store.Workspaces()
	if err != nil {
		t.Fatal(err)
	}
	record, ok := containerByLogical(&stored[0], "default")
	if !ok || !slices.Equal(record.Paths, []string{"/new/bin"}) {
		t.Fatalf("paths not replaced: %#v", record)
	}
}

// TestContainerRequestsRejectInvalidPathAdditions pins that every request that
// can set PATH additions validates them.
func TestContainerRequestsRejectInvalidPathAdditions(t *testing.T) {
	server, _, _ := pathServer(t, "proj", nil)
	if _, err := server.StartContainer(context.Background(), &ctl.StartContainerRequest{WorkspaceSlug: "proj", Container: "default", Paths: []string{"relative"}}); status.Code(err) != codes.InvalidArgument {
		t.Errorf("start: expected InvalidArgument, got %v", err)
	}
	if _, err := server.RecreateContainer(context.Background(), &ctl.RecreateContainerRequest{WorkspaceSlug: "proj", Container: "default", Paths: []string{"/a/../b"}}); status.Code(err) != codes.InvalidArgument {
		t.Errorf("recreate: expected InvalidArgument, got %v", err)
	}
	created, _, _ := pathServer(t, testWorkspaceSlug, nil)
	if _, err := created.CreateWorkspace(context.Background(), &ctl.CreateWorkspaceRequest{WorkspaceSlug: testWorkspaceSlug, ProjectName: "team", ImageId: "arch", Paths: []string{"relative"}}); status.Code(err) != codes.InvalidArgument {
		t.Errorf("create: expected InvalidArgument, got %v", err)
	}
}
