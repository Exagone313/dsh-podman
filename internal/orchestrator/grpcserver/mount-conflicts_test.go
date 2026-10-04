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

// ListContainerWriteMounts serves the seeded read-write bind mounts, filtered
// by name prefix, mirroring the real client's list-and-inspect shape.
func (f *fakePodman) ListContainerWriteMounts(namePrefix string) (map[string][]string, error) {
	result := map[string][]string{}
	for name, sources := range f.writeMounts {
		if strings.HasPrefix(name, namePrefix) {
			result[name] = append([]string(nil), sources...)
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
	// Swap the project directory for a symlink after the container was created.
	if err := os.RemoveAll(filepath.Join(root, "team")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "elsewhere"), filepath.Join(root, "team")); err != nil {
		t.Fatal(err)
	}
	if _, err := server.EnsureContainer(context.Background(), &ctl.EnsureContainerRequest{WorkspaceSlug: testWorkspaceSlug}); err == nil {
		t.Fatal("expected the swapped mount path to be refused")
	}
	if len(fake.recreated) != 0 {
		t.Fatalf("nothing should be recreated on an invalid path: %v", fake.recreated)
	}
}
