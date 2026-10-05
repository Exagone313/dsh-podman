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
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// ListContainerBindMounts serves the seeded bind mounts, read-write ones from
// writeMounts and read-only ones from readMounts, filtered by name prefix,
// mirroring the real client's list-and-inspect shape.
func (f *fakePodman) ListContainerBindMounts(namePrefix string) (map[string][]specs.Mount, error) {
	result := map[string][]specs.Mount{}
	for mode, seeded := range map[string]map[string][]string{"rw": f.writeMounts, "ro": f.readMounts} {
		for name, sources := range seeded {
			if !strings.HasPrefix(name, namePrefix) {
				continue
			}
			for _, source := range sources {
				result[name] = append(result[name], specs.Mount{Type: "bind", Source: source, Destination: source, Options: []string{mode}})
			}
		}
	}
	return result, nil
}

func TestPathsStrictAncestor(t *testing.T) {
	cases := []struct {
		parent, child string
		want          bool
	}{
		{"/projects/team", "/projects/team/src", true},
		{"/projects/team", "/projects/team", false},
		{"/projects/team/src", "/projects/team", false},
		{"/projects/team", "/projects/teams", false},
		{"/", "/projects/team", true},
	}
	for _, tc := range cases {
		if got := pathsStrictAncestor(tc.parent, tc.child); got != tc.want {
			t.Errorf("pathsStrictAncestor(%q, %q) = %v, want %v", tc.parent, tc.child, got, tc.want)
		}
	}
}

func TestCheckProjectMountConflicts(t *testing.T) {
	const slug = "11111111-1111-1111-1111-111111111111"
	other := "dsh-podman-" + slug + "-other"
	// A bind mount whose source is /projects/team/src.
	newMounts := []specs.Mount{{Type: "bind", Source: "/projects/team/src", Destination: "/projects/team/src"}}

	cases := []struct {
		name     string
		existing map[string][]string
		wantErr  bool
	}{
		{"read-write strict ancestor is refused", map[string][]string{other: {"/projects/team"}}, true},
		{"read-write equal mount is allowed", map[string][]string{other: {"/projects/team/src"}}, false},
		{"read-write descendant is allowed", map[string][]string{other: {"/projects/team/src/nested"}}, false},
		{"disjoint mount is allowed", map[string][]string{other: {"/projects/other"}}, false},
		{"non-orchestrator name is ignored", map[string][]string{"somebody-else": {"/projects/team"}}, false},
		{"prefix lookalike is ignored", map[string][]string{"dsh-podman-x": {"/projects/team"}}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			podman := newFakePodman()
			podman.writeMounts = tc.existing
			server := &Server{Podman: podman, Logger: silentLogger()}
			err := server.checkProjectMountConflicts(newMounts, "")
			if tc.wantErr {
				if status.Code(err) != codes.FailedPrecondition {
					t.Fatalf("expected FailedPrecondition, got %v", err)
				}
				if !strings.Contains(err.Error(), `"other"`) || !strings.Contains(err.Error(), slug) {
					t.Fatalf("conflict should name the logical container and workspace: %v", err)
				}
				if strings.Contains(err.Error(), containerNamePrefix) {
					t.Fatalf("conflict must not leak the podman name: %v", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected conflict: %v", err)
			}
		})
	}
}

// TestCheckProjectMountConflictsExcludesSelf covers a recreate: the container's
// own read-write mount must not conflict with itself.
func TestCheckProjectMountConflictsExcludesSelf(t *testing.T) {
	const slug = "11111111-1111-1111-1111-111111111111"
	self := "dsh-podman-" + slug + "-default"
	podman := newFakePodman()
	podman.writeMounts = map[string][]string{self: {"/projects/team"}}
	server := &Server{Podman: podman, Logger: silentLogger()}
	newMounts := []specs.Mount{{Type: "bind", Source: "/projects/team/src"}}
	if err := server.checkProjectMountConflicts(newMounts, self); err != nil {
		t.Fatalf("the container's own mount must be excluded: %v", err)
	}
}

// TestCheckProjectMountConflictsWithoutProjectMounts covers a container with no
// project mounts: no podman call is made, so a nil client is fine.
func TestCheckProjectMountConflictsWithoutProjectMounts(t *testing.T) {
	server := &Server{}
	if err := server.checkProjectMountConflicts([]specs.Mount{{Type: "tmpfs", Destination: "/tmp/x"}}, ""); err != nil {
		t.Fatalf("unexpected conflict: %v", err)
	}
}

// TestStartContainerRejectsReadWriteAncestorMount pins that a start whose
// project mount sits inside another container's read-write mount is refused
// before anything is removed or created.
func TestStartContainerRejectsReadWriteAncestorMount(t *testing.T) {
	root := tempRoot(t)
	if err := os.MkdirAll(filepath.Join(root, "team", "src"), 0755); err != nil {
		t.Fatal(err)
	}
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{WorkspaceSlug: testWorkspaceSlug, ProjectName: "team"}}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveImages([]state.Image{{ImageID: "arch", ImageTag: "localhost/dsh-podman/arch:latest"}}); err != nil {
		t.Fatal(err)
	}
	other := containerNamePrefix + testWorkspaceSlug + "-other"
	fake := newFakePodman()
	fake.writeMounts[other] = []string{filepath.Join(root, "team")}
	server := &Server{Store: store, Podman: fake, ProjectsRoot: root, Logger: silentLogger()}
	_, err := server.StartContainer(context.Background(), &ctl.StartContainerRequest{
		WorkspaceSlug: testWorkspaceSlug,
		Container:     "dev",
		ImageId:       "arch",
		Mounts:        []*ctl.ProjectMount{{ProjectName: "team/src", Mode: ctl.MountMode_MOUNT_MODE_READ_WRITE}},
	})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("expected FailedPrecondition, got %v", err)
	}
	if len(fake.created) != 0 || len(fake.removed) != 0 {
		t.Fatalf("a refused start must not create or remove anything: created=%v removed=%v", fake.created, fake.removed)
	}
}

// TestEnsureContainerRefusesAStaleMountPath pins the reuse path: a running
// container whose stored project path became a symlink after it was created
// (podman can restart a container on its own, re-resolving the source) is not
// handed out. Recreation cannot succeed on the invalid path, so the call fails
// rather than serving a container with a redirected mount.
func TestEnsureContainerRefusesAStaleMountPath(t *testing.T) {
	root := tempRoot(t)
	if err := os.MkdirAll(filepath.Join(root, "team"), 0755); err != nil {
		t.Fatal(err)
	}
	store := newTestStore(t)
	if err := store.SaveImages([]state.Image{{ImageID: "arch", ImageTag: "localhost/dsh-podman/arch:latest"}}); err != nil {
		t.Fatal(err)
	}
	mounts := []state.Mount{{ProjectName: "team", Mode: "read_write"}}
	if err := store.SaveWorkspaces([]state.Workspace{{
		WorkspaceSlug: testWorkspaceSlug,
		ProjectName:   "team",
		ContainerName: testDefaultContainer,
		Mounts:        mounts,
		Containers:    []state.Container{{Name: "default", PodmanName: testDefaultContainer, ImageID: "arch", Status: "running", AgentToken: "tok", Mounts: mounts}},
	}}); err != nil {
		t.Fatal(err)
	}
	fake := newFakePodman()
	fake.exists[testDefaultContainer] = true
	fake.running[testDefaultContainer] = true
	fake.agentToken[testDefaultContainer] = "tok"
	server := &Server{Store: store, Podman: fake, ProjectsRoot: root, Logger: silentLogger()}
	// Swap the project directory for a symlink that stays inside the projects
	// root, so the no-symlink walk is what refuses it.
	if err := os.MkdirAll(filepath.Join(root, "other"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(filepath.Join(root, "team")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("other", filepath.Join(root, "team")); err != nil {
		t.Fatal(err)
	}
	_, err := server.EnsureContainer(context.Background(), &ctl.EnsureContainerRequest{WorkspaceSlug: testWorkspaceSlug})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("expected InvalidArgument, got %v", err)
	}
	if !strings.Contains(err.Error(), "is a symlink") {
		t.Fatalf("stale mount message lost: %v", err)
	}
	if len(fake.recreated) != 0 {
		t.Fatalf("nothing should be recreated on an invalid path: %v", fake.recreated)
	}
}

func TestLogicalContainerName(t *testing.T) {
	const slug = "11111111-1111-1111-1111-111111111111"
	gotSlug, logical, ok := logicalContainerName(containerNamePrefix + slug + "-dev")
	if !ok || gotSlug != slug || logical != "dev" {
		t.Fatalf("logicalContainerName = %q, %q, %v", gotSlug, logical, ok)
	}
	for _, name := range []string{"", "default", "dsh-podman-x", containerNamePrefix + slug} {
		if _, _, ok := logicalContainerName(name); ok {
			t.Errorf("accepted non-orchestrator name %q", name)
		}
	}
}

// conflictFixture returns a server whose "other" container holds a read-write
// mount of team, and a workspace whose "dev" container is the mutation target
// with the given mounts.
func conflictFixture(t *testing.T, devMounts []state.Mount) *Server {
	t.Helper()
	root := tempRoot(t)
	if err := os.MkdirAll(filepath.Join(root, "team", "src"), 0755); err != nil {
		t.Fatal(err)
	}
	store := newTestStore(t)
	if err := store.SaveImages([]state.Image{{ImageID: "arch", ImageTag: "localhost/dsh-podman/arch:latest"}}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveWorkspaces([]state.Workspace{{
		WorkspaceSlug: testWorkspaceSlug,
		ProjectName:   "team",
		Containers:    []state.Container{{Name: "dev", PodmanName: containerNamePrefix + testWorkspaceSlug + "-dev", ImageID: "arch", Status: "running", Mounts: devMounts}},
	}}); err != nil {
		t.Fatal(err)
	}
	fake := newFakePodman()
	fake.writeMounts[containerNamePrefix+testWorkspaceSlug+"-other"] = []string{filepath.Join(root, "team")}
	return &Server{Store: store, Podman: fake, ProjectsRoot: root, Logger: silentLogger()}
}

func assertConflict(t *testing.T, err error) {
	t.Helper()
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("expected FailedPrecondition, got %v", err)
	}
	if !strings.Contains(err.Error(), "is inside the read-write mount") {
		t.Fatalf("conflict message lost: %v", err)
	}
}

// TestMountMutationsReportConflicts pins that the mount mutations surface a
// conflict as FailedPrecondition with its message, rather than collapsing it
// into an opaque Internal error.
func TestMountMutationsReportConflicts(t *testing.T) {
	t.Run("add", func(t *testing.T) {
		server := conflictFixture(t, nil)
		_, err := server.AddContainerMount(context.Background(), &ctl.AddContainerMountRequest{
			WorkspaceSlug: testWorkspaceSlug,
			Container:     "dev",
			Project:       "team/src",
			Mode:          ctl.MountMode_MOUNT_MODE_READ_WRITE,
		})
		assertConflict(t, err)
	})
	t.Run("update", func(t *testing.T) {
		server := conflictFixture(t, []state.Mount{{ProjectName: "team/src", Mode: "read_only"}})
		_, err := server.UpdateContainerMount(context.Background(), &ctl.UpdateContainerMountRequest{
			WorkspaceSlug: testWorkspaceSlug,
			Container:     "dev",
			Project:       "team/src",
			Mode:          ctl.MountMode_MOUNT_MODE_READ_WRITE,
		})
		assertConflict(t, err)
	})
	t.Run("recreate", func(t *testing.T) {
		server := conflictFixture(t, []state.Mount{{ProjectName: "team/src", Mode: "read_write"}})
		_, err := server.RecreateContainer(context.Background(), &ctl.RecreateContainerRequest{
			WorkspaceSlug: testWorkspaceSlug,
			Container:     "dev",
		})
		assertConflict(t, err)
	})
}

// TestCheckProjectMountConflictsBothDirections pins the reverse direction: a
// new read-write mount that contains another container's mount, read-write or
// read-only, is refused, because podman resolves that inner path again on
// every start of the other container. A read-only new mount cannot rewrite the
// inner path, so it is allowed.
func TestCheckProjectMountConflictsBothDirections(t *testing.T) {
	const slug = "11111111-1111-1111-1111-111111111111"
	other := "dsh-podman-" + slug + "-other"
	cases := []struct {
		name    string
		mode    string
		write   map[string][]string
		read    map[string][]string
		wantErr bool
	}{
		{"read-write mount over a read-write descendant is refused", "rw", map[string][]string{other: {"/projects/team/src"}}, nil, true},
		{"read-write mount over a read-only descendant is refused", "rw", nil, map[string][]string{other: {"/projects/team/src"}}, true},
		{"read-only mount over a descendant is allowed", "ro", map[string][]string{other: {"/projects/team/src"}}, nil, false},
		{"read-write equal mount is allowed", "rw", map[string][]string{other: {"/projects/team"}}, nil, false},
		{"read-write disjoint mount is allowed", "rw", map[string][]string{other: {"/projects/teammate"}}, nil, false},
		{"read-only ancestor is allowed", "rw", nil, map[string][]string{other: {"/projects"}}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			podman := newFakePodman()
			for name, sources := range tc.write {
				podman.writeMounts[name] = sources
			}
			for name, sources := range tc.read {
				podman.readMounts[name] = sources
			}
			server := &Server{Podman: podman, Logger: silentLogger()}
			newMounts := []specs.Mount{{Type: "bind", Source: "/projects/team", Destination: "/projects/team", Options: []string{tc.mode}}}
			err := server.checkProjectMountConflicts(newMounts, "")
			if tc.wantErr {
				if status.Code(err) != codes.FailedPrecondition {
					t.Fatalf("expected FailedPrecondition, got %v", err)
				}
				if strings.Contains(err.Error(), containerNamePrefix) {
					t.Fatalf("conflict must not leak the podman name: %v", err)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected conflict: %v", err)
			}
		})
	}
}

// swapToSymlinkOnStop makes the fake's Stop replace rel under root with a
// symlink to a sibling directory, standing in for a container that swaps a
// path component in its last moments before it is stopped.
func swapToSymlinkOnStop(t *testing.T, fake *fakePodman, root, rel string) {
	t.Helper()
	fake.onStop = func(string) {
		if err := os.MkdirAll(filepath.Join(root, "elsewhere"), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.RemoveAll(filepath.Join(root, rel)); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(filepath.Join(root, "elsewhere"), filepath.Join(root, rel)); err != nil {
			t.Fatal(err)
		}
	}
}

// selfNestedFixture returns a server whose "dev" container holds team
// read-write and team/src, and is running.
func selfNestedFixture(t *testing.T) (*Server, *fakePodman, string) {
	t.Helper()
	root := tempRoot(t)
	if err := os.MkdirAll(filepath.Join(root, "team", "src"), 0755); err != nil {
		t.Fatal(err)
	}
	store := newTestStore(t)
	if err := store.SaveImages([]state.Image{{ImageID: "arch", ImageTag: "localhost/dsh-podman/arch:latest"}}); err != nil {
		t.Fatal(err)
	}
	dev := containerNamePrefix + testWorkspaceSlug + "-dev"
	mounts := []state.Mount{{ProjectName: "team", Mode: "read_write"}, {ProjectName: "team/src", Mode: "read_write"}}
	if err := store.SaveWorkspaces([]state.Workspace{{
		WorkspaceSlug: testWorkspaceSlug,
		ProjectName:   "team",
		Containers:    []state.Container{{Name: "dev", PodmanName: dev, ImageID: "arch", Status: "running", AgentToken: "tok", Mounts: mounts}},
	}}); err != nil {
		t.Fatal(err)
	}
	fake := newFakePodman()
	fake.exists[dev] = true
	fake.running[dev] = true
	fake.writeMounts[dev] = []string{filepath.Join(root, "team"), filepath.Join(root, "team", "src")}
	return &Server{Store: store, Podman: fake, ProjectsRoot: root, Logger: silentLogger()}, fake, root
}

// TestRecreateRevalidatesAfterStop pins the self-exclusion case: the container
// being recreated is excluded from the conflict check, so a path component it
// swaps before it stops must be caught by resolving the mounts again after the
// stop, and nothing is created on the swapped path.
func TestRecreateRevalidatesAfterStop(t *testing.T) {
	server, fake, root := selfNestedFixture(t)
	swapToSymlinkOnStop(t, fake, root, filepath.Join("team", "src"))
	_, err := server.RecreateContainer(context.Background(), &ctl.RecreateContainerRequest{WorkspaceSlug: testWorkspaceSlug, Container: "dev"})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("expected the swapped path to be refused, got %v", err)
	}
	if len(fake.created) != 0 {
		t.Fatalf("nothing may be created on a swapped path: %v", fake.created)
	}
}

// TestStartContainerRevalidatesAfterStop pins the same for a replacing start.
func TestStartContainerRevalidatesAfterStop(t *testing.T) {
	server, fake, root := selfNestedFixture(t)
	swapToSymlinkOnStop(t, fake, root, filepath.Join("team", "src"))
	_, err := server.StartContainer(context.Background(), &ctl.StartContainerRequest{WorkspaceSlug: testWorkspaceSlug, Container: "dev", ImageId: "arch"})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("expected the swapped path to be refused, got %v", err)
	}
	if len(fake.created) != 0 {
		t.Fatalf("nothing may be created on a swapped path: %v", fake.created)
	}
}

// TestEnsureContainerRefusesANestedPair pins that a running container left
// nested under another container's read-write mount (created before the check
// was two-way) is not handed out.
func TestEnsureContainerRefusesANestedPair(t *testing.T) {
	root := tempRoot(t)
	if err := os.MkdirAll(filepath.Join(root, "team", "app"), 0755); err != nil {
		t.Fatal(err)
	}
	store := newTestStore(t)
	if err := store.SaveImages([]state.Image{{ImageID: "arch", ImageTag: "localhost/dsh-podman/arch:latest"}}); err != nil {
		t.Fatal(err)
	}
	mounts := []state.Mount{{ProjectName: "team/app", Mode: "read_write"}}
	if err := store.SaveWorkspaces([]state.Workspace{{
		WorkspaceSlug: testWorkspaceSlug,
		ProjectName:   "team/app",
		ContainerName: testDefaultContainer,
		Mounts:        mounts,
		Containers:    []state.Container{{Name: "default", PodmanName: testDefaultContainer, ImageID: "arch", Status: "running", AgentToken: "tok", Mounts: mounts}},
	}}); err != nil {
		t.Fatal(err)
	}
	fake := newFakePodman()
	fake.exists[testDefaultContainer] = true
	fake.running[testDefaultContainer] = true
	fake.agentToken[testDefaultContainer] = "tok"
	fake.writeMounts[containerNamePrefix+"11111111-1111-1111-1111-111111111111-default"] = []string{filepath.Join(root, "team")}
	server := &Server{Store: store, Podman: fake, ProjectsRoot: root, Logger: silentLogger()}
	_, err := server.EnsureContainer(context.Background(), &ctl.EnsureContainerRequest{WorkspaceSlug: testWorkspaceSlug})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("expected FailedPrecondition, got %v", err)
	}
}
