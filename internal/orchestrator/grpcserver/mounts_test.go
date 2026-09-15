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
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func TestMountLabel(t *testing.T) {
	cases := []struct {
		mount state.Mount
		want  string
	}{
		{state.Mount{Kind: "tmpfs", Destination: "/scratch"}, `tmpfs at "/scratch"`},
		{state.Mount{Kind: "volume", Volume: "data", Destination: "/data"}, `volume "data" at "/data"`},
		{state.Mount{Kind: "secret", Secret: "tls", Destination: "/run/secrets/tls"}, `secret "tls" at "/run/secrets/tls"`},
		{state.Mount{ProjectName: "team/src"}, `project "team/src"`},
		{state.Mount{ProjectName: "team"}, `project "team"`},
	}
	for _, tc := range cases {
		if got := mountLabel(tc.mount); got != tc.want {
			t.Errorf("mountLabel(%#v) = %q, want %q", tc.mount, got, tc.want)
		}
	}
}

func TestContainerMountsFallback(t *testing.T) {
	ws := state.Workspace{Mounts: []state.Mount{{ProjectName: "a", Mode: "read_only"}}}
	if got := containerMounts(ws, state.Container{}); len(got) != 1 || got[0].ProjectName != "a" {
		t.Fatalf("expected workspace fallback for the default container, got %#v", got)
	}
	if got := containerMounts(ws, state.Container{Name: "default"}); len(got) != 1 || got[0].ProjectName != "a" {
		t.Fatalf("expected workspace fallback for the default container, got %#v", got)
	}
	if got := containerMounts(ws, state.Container{Name: "dev"}); got != nil {
		t.Fatalf("named containers do not inherit the workspace mounts, got %#v", got)
	}
	withOwn := state.Container{Name: "dev", Mounts: []state.Mount{{ProjectName: "b", Mode: "read_write"}}}
	got := containerMounts(ws, withOwn)
	if len(got) != 1 || got[0].ProjectName != "b" || got[0].Mode != "read_write" {
		t.Fatalf("expected container's own mounts, got %#v", got)
	}
}

func TestIsWorkspaceProjectMount(t *testing.T) {
	ws := state.Workspace{ProjectName: "team"}
	if !isWorkspaceProjectMount(ws, state.Mount{ProjectName: "team", Mode: "read_write"}) {
		t.Fatal("expected the workspace project root mount to match")
	}
	if isWorkspaceProjectMount(ws, state.Mount{ProjectName: "team/src"}) {
		t.Fatal("a project subpath is not the primary project mount")
	}
	if isWorkspaceProjectMount(ws, state.Mount{ProjectName: "other"}) {
		t.Fatal("another project must not match")
	}
	if isWorkspaceProjectMount(ws, state.Mount{Kind: "volume", Volume: "v"}) {
		t.Fatal("a non-project mount must not match")
	}
	if isWorkspaceProjectMount(state.Workspace{}, state.Mount{ProjectName: "team"}) {
		t.Fatal("a workspace without a project name must not match")
	}
}

func TestEnsureWorkspaceProjectMount(t *testing.T) {
	ws := state.Workspace{ProjectName: "team"}
	mounts := ensureWorkspaceProjectMount(nil, ws)
	if len(mounts) != 1 || mounts[0].ProjectName != "team" || mounts[0].Mode != "read_write" {
		t.Fatalf("expected the primary project mount appended read-write, got %#v", mounts)
	}
	present := []state.Mount{{ProjectName: "team", Mode: "read_only"}}
	if got := ensureWorkspaceProjectMount(present, ws); len(got) != 1 || got[0].Mode != "read_only" {
		t.Fatalf("an existing primary project mount must not be duplicated, got %#v", got)
	}
	if got := ensureWorkspaceProjectMount(nil, state.Workspace{}); got != nil {
		t.Fatalf("a workspace without a project name must be a no-op, got %#v", got)
	}
}

func TestRemoveContainerMountRefusesDefaultProjectMount(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{
		WorkspaceSlug: "proj",
		ProjectName:   "team",
		Containers: []state.Container{{
			Name:       "default",
			PodmanName: "dsh-podman-proj-default",
			Mounts:     []state.Mount{{ProjectName: "team", Mode: "read_write"}},
		}},
	}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}
	_, err := server.RemoveContainerMount(context.Background(), &ctl.RemoveContainerMountRequest{WorkspaceSlug: "proj", Container: "default", Kind: ctl.MountKind_MOUNT_KIND_PROJECT, Project: "team"})
	if status.Code(err) != codes.FailedPrecondition || !strings.Contains(err.Error(), "the default container keeps the workspace project mount") {
		t.Fatalf("expected refusal on the default container's project mount, got %v", err)
	}
}

func TestRemoveContainerMountAllowsNamedProjectMountRemoval(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{
		WorkspaceSlug: "proj",
		ProjectName:   "team",
		Containers: []state.Container{{
			Name:       "dev",
			PodmanName: "dsh-podman-proj-dev",
			Mounts:     []state.Mount{{ProjectName: "team", Mode: "read_write"}},
		}},
	}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}
	_, err := server.RemoveContainerMount(context.Background(), &ctl.RemoveContainerMountRequest{WorkspaceSlug: "proj", Container: "dev", Kind: ctl.MountKind_MOUNT_KIND_PROJECT, Project: "team"})
	if status.Code(err) != codes.FailedPrecondition || !strings.Contains(err.Error(), "podman is not configured") {
		t.Fatalf("named container removal must proceed past the default-mount refusal, got %v", err)
	}
}

func TestMountFromProto(t *testing.T) {
	mount, err := mountFromProto(&ctl.ProjectMount{ProjectName: "team/src", Destination: "/x", Mode: ctl.MountMode_MOUNT_MODE_READ_WRITE})
	if err != nil {
		t.Fatal(err)
	}
	if mount.ProjectName != "team/src" || mount.Mode != "read_write" || mount.Destination != "/x" {
		t.Fatalf("unexpected mount: %#v", mount)
	}
	ro, err := mountFromProto(&ctl.ProjectMount{ProjectName: "team", Mode: ctl.MountMode_MOUNT_MODE_READ_ONLY})
	if err != nil || ro.Mode != "read_only" {
		t.Fatalf("expected read_only, got %q %v", ro.Mode, err)
	}
}

// TestMountFromProtoRejectsUnknown pins down that unrecognised enum values are
// reported rather than coerced: an unknown kind must not become a project
// mount, and an unspecified mode must not become a silent read_only.
func TestMountFromProtoRejectsUnknown(t *testing.T) {
	if _, err := mountFromProto(&ctl.ProjectMount{ProjectName: "team", Kind: ctl.MountKind(99), Mode: ctl.MountMode_MOUNT_MODE_READ_ONLY}); err == nil {
		t.Error("accepted an unknown mount kind")
	}
	if _, err := mountFromProto(&ctl.ProjectMount{ProjectName: "team", Mode: ctl.MountMode(99)}); err == nil {
		t.Error("accepted an unknown mount mode")
	}
	if _, err := mountFromProto(&ctl.ProjectMount{ProjectName: "team"}); err == nil {
		t.Error("accepted an unspecified mount mode")
	}
	// Secret mounts are the one kind that carries no mode.
	secret, err := mountFromProto(&ctl.ProjectMount{Kind: ctl.MountKind_MOUNT_KIND_SECRET, Secret: "tls", Destination: "/run/secrets/tls"})
	if err != nil || secret.Kind != "secret" || secret.Secret != "tls" {
		t.Fatalf("secret mount rejected: %#v %v", secret, err)
	}
	if _, err := stateMounts([]*ctl.ProjectMount{
		{ProjectName: "team", Mode: ctl.MountMode_MOUNT_MODE_READ_ONLY},
		{ProjectName: "other", Kind: ctl.MountKind(99)},
	}); err == nil {
		t.Error("stateMounts accepted a list containing an invalid mount")
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
	root := tempRoot(t)
	hostRoot := filepath.Join(t.TempDir(), "host")
	if err := os.MkdirAll(filepath.Join(root, "team", "src"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(hostRoot, "team", "src"), 0755); err != nil {
		t.Fatal(err)
	}
	host, dest, err := resolveMount(root, "", state.Mount{ProjectName: "team/src", Mode: "read_only"})
	if err != nil {
		t.Fatal(err)
	}
	if host != filepath.Join(root, "team", "src") || dest != filepath.Join(root, "team", "src") {
		t.Fatalf("unexpected resolve: %q %q", host, dest)
	}
	// Project mounts never take a caller-supplied destination.
	for _, dest := range []string{
		filepath.Join(root, "custom", "mount"),
		filepath.Join(root, "team", "code"),
	} {
		_, _, err := resolveMount(root, "", state.Mount{ProjectName: "team/src", Destination: dest})
		if err == nil {
			t.Errorf("accepted a project mount destination %q", dest)
		}
	}
	if _, _, err := resolveMount(root, "", state.Mount{ProjectName: "team/src", Destination: filepath.Join(root, "custom", "mount")}); err == nil || !strings.Contains(err.Error(), "will be mounted at "+filepath.Join(root, "team", "src")) {
		t.Fatalf("rejection should name the fixed destination, got %v", err)
	}
	for _, path := range []string{"..", "../x", "/abs", "a/../b", "a//b", "a/b/", "."} {
		if _, _, err := resolveMount(root, "", state.Mount{ProjectName: path}); err == nil {
			t.Errorf("accepted invalid project path %q", path)
		}
	}
	for _, dest := range []string{"relative", "/outside", "/workspaces2/x", "/workspaces/../x", "/workspaces/team/../src/"} {
		if _, _, err := resolveMount(root, "", state.Mount{ProjectName: "team/src", Destination: dest}); err == nil {
			t.Errorf("accepted invalid destination %q", dest)
		}
	}
	if _, _, err := resolveMount(root, "", state.Mount{ProjectName: "team/missing"}); err == nil {
		t.Fatal("accepted a missing project path")
	}
	if _, _, err := resolveMount(root, "", state.Mount{ProjectName: "nope"}); err == nil {
		t.Fatal("accepted a missing project")
	}
}

// TestResolveMountSymlinkedRoot covers a projects root that is itself reached
// through a symlink, as it is when TMPDIR or a home directory is symlinked.
// The source handed to podman is resolved, while the container-side
// destination keeps the configured path.
func TestResolveMountSymlinkedRoot(t *testing.T) {
	real := tempRoot(t)
	if err := os.MkdirAll(filepath.Join(real, "team", "src"), 0755); err != nil {
		t.Fatal(err)
	}
	linked := filepath.Join(tempRoot(t), "projects")
	if err := os.Symlink(real, linked); err != nil {
		t.Fatal(err)
	}

	// Without a host projects root the resolved path is used directly.
	host, dest, err := resolveMount(linked, "", state.Mount{ProjectName: "team/src"})
	if err != nil {
		t.Fatal(err)
	}
	if host != filepath.Join(real, "team", "src") {
		t.Errorf("source not resolved: %q", host)
	}
	if dest != filepath.Join(linked, "team", "src") {
		t.Errorf("destination should keep the configured root: %q", dest)
	}

	// With one, the resolved path is re-expressed against it.
	host, _, err = resolveMount(linked, "/host/projects", state.Mount{ProjectName: "team/src"})
	if err != nil {
		t.Fatal(err)
	}
	if host != filepath.Join("/host/projects", "team", "src") {
		t.Errorf("source not re-expressed against the host root: %q", host)
	}
}

// TestResolveMountSymlinks covers the symlinks a writable project can contain.
// Links leaving the projects root must be refused; links staying inside it
// resolve, since mounting another project directory is supported.
func TestResolveMountSymlinks(t *testing.T) {
	root := tempRoot(t)
	outside := tempRoot(t)
	hostRoot := "/host/projects"
	for _, dir := range []string{
		filepath.Join(root, "team", "src"),
		filepath.Join(root, "other", "shared"),
		filepath.Join(outside, "secrets"),
	} {
		if err := os.MkdirAll(dir, 0755); err != nil {
			t.Fatal(err)
		}
	}
	links := map[string]string{
		"team/escape":   filepath.Join(outside, "secrets"),
		"team/slash":    "/",
		"team/inside":   filepath.Join("..", "other", "shared"),
		"team/absolute": filepath.Join(root, "other", "shared"),
		"team/loop":     filepath.Join(root, "team", "loop"),
	}
	for name, target := range links {
		if err := os.Symlink(target, filepath.Join(root, filepath.FromSlash(name))); err != nil {
			t.Fatal(err)
		}
	}
	// "absolute" points inside the projects root but through an absolute
	// target. Resolution is confined with openat2(RESOLVE_BENEATH), which
	// refuses absolute symlinks outright, so it is rejected too: that is the
	// shape a planted link takes, and naming the other project directly is
	// the supported way to mount it.
	for _, path := range []string{"escape", "slash", "loop", "absolute"} {
		if _, _, err := resolveMount(root, hostRoot, state.Mount{ProjectName: "team/" + path}); err == nil {
			t.Errorf("accepted symlinked project path %q", path)
		}
	}
	// A relative symlink that stays inside the projects root resolves to its
	// target, and the host source is re-expressed against the host root.
	host, dest, err := resolveMount(root, hostRoot, state.Mount{ProjectName: "team/inside"})
	if err != nil {
		t.Fatalf("rejected an internal symlink: %v", err)
	}
	if host != filepath.Join(hostRoot, "other", "shared") {
		t.Errorf("host source not resolved: %q", host)
	}
	// The container-side path keeps the requested shape.
	if dest != filepath.Join(root, "team", "inside") {
		t.Errorf("destination should mirror the request: %q", dest)
	}
	// A symlinked project entry is refused the same way.
	if err := os.Symlink(filepath.Join(outside, "secrets"), filepath.Join(root, "linked")); err != nil {
		t.Fatal(err)
	}
	if _, _, err := resolveMount(root, hostRoot, state.Mount{ProjectName: "linked"}); err == nil {
		t.Error("accepted a symlinked project")
	}
}

func TestPodmanMountsProjectPathAndDestination(t *testing.T) {
	root := tempRoot(t)
	if err := os.MkdirAll(filepath.Join(root, "team", "src"), 0755); err != nil {
		t.Fatal(err)
	}
	server := &Server{ProjectsRoot: root, Logger: silentLogger()}
	mounts, err := server.podmanMounts([]state.Mount{{ProjectName: "team/src", Mode: "read_write"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(mounts) != 1 || mounts[0].Type != "bind" || mounts[0].Source != filepath.Join(root, "team", "src") || mounts[0].Destination != filepath.Join(root, "team", "src") || len(mounts[0].Options) != 1 || mounts[0].Options[0] != "rw" {
		t.Fatalf("unexpected podman mount: %#v", mounts)
	}
	if _, err := server.podmanMounts([]state.Mount{{ProjectName: "../x"}}); status.Code(err) != codes.InvalidArgument {
		t.Fatalf("expected InvalidArgument for project path, got %v", err)
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
			Mounts: []state.Mount{{ProjectName: "devp/src/lib", Mode: "read_write", Destination: "/workspaces/devp/src/lib"}},
		}},
	}
	row := containerProto(ws, ws.Containers[0])
	if len(row.Mounts) != 1 || row.Mounts[0].ProjectName != "devp/src/lib" || row.Mounts[0].Mode != ctl.MountMode_MOUNT_MODE_READ_WRITE || row.Mounts[0].Destination != "/workspaces/devp/src/lib" {
		t.Fatalf("container mounts not projected: %#v", row.Mounts)
	}
	fallback := containerProto(ws, state.Container{Name: "default"})
	if len(fallback.Mounts) != 1 || fallback.Mounts[0].ProjectName != "ws" || fallback.Mounts[0].Mode != ctl.MountMode_MOUNT_MODE_READ_ONLY {
		t.Fatalf("workspace fallback not projected: %#v", fallback.Mounts)
	}
}

func TestAddContainerMount(t *testing.T) {
	root := tempRoot(t)
	if err := os.MkdirAll(filepath.Join(root, "team", "src"), 0755); err != nil {
		t.Fatal(err)
	}
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{
		WorkspaceSlug: "proj",
		Mounts:        []state.Mount{{ProjectName: "team", Mode: "read_write"}},
		Containers: []state.Container{
			{Name: "default", PodmanName: "dsh-podman-proj-default", ImageID: "arch", Status: "running"},
			{Name: "dev", PodmanName: "dsh-podman-proj-dev", ImageID: "arch", Status: "running", Mounts: []state.Mount{{ProjectName: "team", Mode: "read_write"}}},
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
	_, err = server.AddContainerMount(context.Background(), &ctl.AddContainerMountRequest{WorkspaceSlug: "proj", Container: "dev", Project: "../x", Mode: ctl.MountMode_MOUNT_MODE_READ_ONLY})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("invalid project path: expected InvalidArgument, got %v", err)
	}
	_, err = server.AddContainerMount(context.Background(), &ctl.AddContainerMountRequest{WorkspaceSlug: "proj", Container: "dev", Project: "team/src", Destination: "/outside", Mode: ctl.MountMode_MOUNT_MODE_READ_ONLY})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("invalid destination: expected InvalidArgument, got %v", err)
	}
	_, err = server.AddContainerMount(context.Background(), &ctl.AddContainerMountRequest{WorkspaceSlug: "proj", Container: "dev", Project: "team", Mode: ctl.MountMode_MOUNT_MODE_UNSPECIFIED})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("invalid mode: expected InvalidArgument, got %v", err)
	}

	_, err = server.AddContainerMount(context.Background(), &ctl.AddContainerMountRequest{WorkspaceSlug: "proj", Container: "dev", Project: "team/src", Mode: ctl.MountMode_MOUNT_MODE_READ_ONLY})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("valid add to named container: expected FailedPrecondition, got %v", err)
	}
	_, err = server.AddContainerMount(context.Background(), &ctl.AddContainerMountRequest{WorkspaceSlug: "proj", Container: "default", Project: "team/src", Destination: filepath.Join(root, "team", "other"), Mode: ctl.MountMode_MOUNT_MODE_READ_ONLY})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("project mount with a destination: expected InvalidArgument, got %v", err)
	}

	_, err = server.AddContainerMount(context.Background(), &ctl.AddContainerMountRequest{WorkspaceSlug: "proj", Container: "dev", Project: "team", Mode: ctl.MountMode_MOUNT_MODE_READ_ONLY})
	if status.Code(err) != codes.AlreadyExists {
		t.Fatalf("duplicate mount: expected AlreadyExists, got %v", err)
	}
}

func TestRemoveContainerMount(t *testing.T) {
	root := tempRoot(t)
	if err := os.MkdirAll(filepath.Join(root, "team", "src"), 0755); err != nil {
		t.Fatal(err)
	}
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{
		WorkspaceSlug: "proj",
		Mounts:        []state.Mount{{ProjectName: "team", Mode: "read_write"}},
		Containers: []state.Container{
			{Name: "default", PodmanName: "dsh-podman-proj-default", ImageID: "arch", Status: "running"},
			{Name: "dev", PodmanName: "dsh-podman-proj-dev", ImageID: "arch", Status: "running", Mounts: []state.Mount{{ProjectName: "team/src", Mode: "read_only"}, {ProjectName: "team", Mode: "read_write"}}},
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
	_, err = server.RemoveContainerMount(context.Background(), &ctl.RemoveContainerMountRequest{WorkspaceSlug: "proj", Container: "dev", Project: "team/nope"})
	if status.Code(err) != codes.NotFound {
		t.Fatalf("unknown mount: expected NotFound, got %v", err)
	}
	_, err = server.RemoveContainerMount(context.Background(), &ctl.RemoveContainerMountRequest{WorkspaceSlug: "proj", Container: "dev", Project: "team/src"})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("matching mount removal: expected FailedPrecondition, got %v", err)
	}
	_, err = server.RemoveContainerMount(context.Background(), &ctl.RemoveContainerMountRequest{WorkspaceSlug: "proj", Container: "default", Project: "team"})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("workspace-seeded mount removal: expected FailedPrecondition, got %v", err)
	}
}

// TestRemoveContainerMountIdentifiers covers how a removal request names its
// mount: a handle-free request is rejected, a name that selects exactly one
// mount is enough, and a wrong destination is reported with the mounts that do
// exist.
func TestRemoveContainerMountIdentifiers(t *testing.T) {
	root := tempRoot(t)
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{
		WorkspaceSlug: "proj",
		Containers: []state.Container{{
			Name: "dev", PodmanName: "dsh-podman-proj-dev", ImageID: "arch", Status: "running",
			Mounts: []state.Mount{
				{Kind: "volume", Volume: "data", Destination: "/data", Mode: "read_write"},
				{Kind: "secret", Secret: "tls", Destination: "/run/secrets/tls"},
				{Kind: "tmpfs", Destination: "/scratch", Mode: "read_write"},
			},
		}},
	}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, ProjectsRoot: root, VolumePrefix: "dsh-podman-", SecretPrefix: "dsh-podman-", Logger: silentLogger()}

	for _, name := range []struct {
		label   string
		request *ctl.RemoveContainerMountRequest
	}{
		{"secret without a handle", &ctl.RemoveContainerMountRequest{WorkspaceSlug: "proj", Container: "dev", Kind: ctl.MountKind_MOUNT_KIND_SECRET}},
		{"tmpfs without a destination", &ctl.RemoveContainerMountRequest{WorkspaceSlug: "proj", Container: "dev", Kind: ctl.MountKind_MOUNT_KIND_TMPFS}},
		{"project without a project", &ctl.RemoveContainerMountRequest{WorkspaceSlug: "proj", Container: "dev"}},
	} {
		_, err := server.RemoveContainerMount(context.Background(), name.request)
		if status.Code(err) != codes.InvalidArgument {
			t.Errorf("%s: expected InvalidArgument, got %v", name.label, err)
		}
	}

	// A name that identifies exactly one mount is enough, and the destination
	// alone identifies a volume too.
	for _, name := range []struct {
		label   string
		request *ctl.RemoveContainerMountRequest
	}{
		{"secret by name", &ctl.RemoveContainerMountRequest{WorkspaceSlug: "proj", Container: "dev", Kind: ctl.MountKind_MOUNT_KIND_SECRET, Secret: "tls"}},
		{"volume by name", &ctl.RemoveContainerMountRequest{WorkspaceSlug: "proj", Container: "dev", Kind: ctl.MountKind_MOUNT_KIND_VOLUME, Volume: "data"}},
		{"volume by destination", &ctl.RemoveContainerMountRequest{WorkspaceSlug: "proj", Container: "dev", Kind: ctl.MountKind_MOUNT_KIND_VOLUME, Destination: "/data"}},
		{"tmpfs by destination", &ctl.RemoveContainerMountRequest{WorkspaceSlug: "proj", Container: "dev", Kind: ctl.MountKind_MOUNT_KIND_TMPFS, Destination: "/scratch"}},
	} {
		_, err := server.RemoveContainerMount(context.Background(), name.request)
		// The match succeeded; the call then stops at the nil podman client.
		if status.Code(err) != codes.FailedPrecondition {
			t.Errorf("%s: expected FailedPrecondition, got %v", name.label, err)
		}
	}

	_, err := server.RemoveContainerMount(context.Background(), &ctl.RemoveContainerMountRequest{WorkspaceSlug: "proj", Container: "dev", Kind: ctl.MountKind_MOUNT_KIND_TMPFS, Destination: "/nope"})
	if status.Code(err) != codes.NotFound {
		t.Fatalf("unknown tmpfs: expected NotFound, got %v", err)
	}
	if got := status.Convert(err).Message(); got != `mount not found: tmpfs at "/nope"; the container mounts tmpfs at "/scratch"` {
		t.Fatalf("tmpfs not-found message: %q", got)
	}
}

func TestStartContainerMountsValidation(t *testing.T) {
	root := tempRoot(t)
	if err := os.MkdirAll(filepath.Join(root, "team", "src"), 0755); err != nil {
		t.Fatal(err)
	}
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{WorkspaceSlug: "proj", ContainerName: "dsh-podman-proj-default"}}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveImages([]state.Image{{ImageID: "arch", ImageTag: "localhost/dsh-podman/arch:latest"}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, ProjectsRoot: root, Logger: silentLogger()}
	_, err := server.StartContainer(context.Background(), &ctl.StartContainerRequest{WorkspaceSlug: "proj", Container: "dev", Mounts: []*ctl.ProjectMount{{ProjectName: "../x"}}})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("invalid mount: expected InvalidArgument, got %v", err)
	}
	_, err = server.StartContainer(context.Background(), &ctl.StartContainerRequest{WorkspaceSlug: "proj", Container: "dev", ImageId: "arch", Mounts: []*ctl.ProjectMount{{ProjectName: "team/src", Mode: ctl.MountMode_MOUNT_MODE_READ_WRITE}}})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("valid mounts: expected FailedPrecondition, got %v", err)
	}
}

func TestRecreateContainerMountsValidation(t *testing.T) {
	root := tempRoot(t)
	if err := os.MkdirAll(filepath.Join(root, "team", "src"), 0755); err != nil {
		t.Fatal(err)
	}
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{WorkspaceSlug: "proj", Mounts: []state.Mount{{ProjectName: "team", Mode: "read_only"}}, Containers: []state.Container{{Name: "dev", PodmanName: "dsh-podman-proj-dev", ImageID: "arch"}}}}); err != nil {
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
	_, err = server.RecreateContainer(context.Background(), &ctl.RecreateContainerRequest{WorkspaceSlug: "proj", Container: "dev", ImageId: "arch", Mounts: []*ctl.ProjectMount{{ProjectName: "team/src", Mode: ctl.MountMode_MOUNT_MODE_READ_ONLY}}})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("valid mounts: expected FailedPrecondition, got %v", err)
	}
}

func TestCreateWorkspacePreservesDefaultContainerMounts(t *testing.T) {
	root := tempRoot(t)
	if err := os.MkdirAll(filepath.Join(root, "team", "src"), 0755); err != nil {
		t.Fatal(err)
	}
	store := newTestStore(t)
	if err := store.SaveImages([]state.Image{{ImageID: "devimg", ImageTag: "t1"}}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveWorkspaces([]state.Workspace{{
		WorkspaceSlug: testWorkspaceSlug,
		ContainerName: testDefaultContainer,
		ImageID:       "devimg",
		Containers: []state.Container{{
			Name:       "default",
			PodmanName: testDefaultContainer,
			ImageID:    "devimg",
			Mounts:     []state.Mount{{ProjectName: "team/src", Mode: "read_only"}},
		}},
	}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, ProjectsRoot: root, Logger: silentLogger()}
	_, err := server.CreateWorkspace(context.Background(), &ctl.CreateWorkspaceRequest{WorkspaceSlug: testWorkspaceSlug, ProjectName: "team", ImageId: "devimg", Mounts: []*ctl.ProjectMount{{ProjectName: "team/nope", Mode: ctl.MountMode_MOUNT_MODE_READ_ONLY}}})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("preserved default container mounts should win over invalid request mounts, expected FailedPrecondition, got %v", err)
	}
}

func TestNonProjectDestination(t *testing.T) {
	root := filepath.Join(t.TempDir(), "projects")
	server := &Server{ProjectsRoot: root, Logger: silentLogger()}
	if err := server.nonProjectDestination("/scratch/work"); err != nil {
		t.Fatalf("valid destination rejected: %v", err)
	}
	for _, destination := range []string{"relative", "/a/../b", "/a/", root, filepath.Join(root, "x"), filepath.Join(root, "x", "y")} {
		if err := server.nonProjectDestination(destination); err == nil {
			t.Errorf("accepted invalid destination %q", destination)
		}
	}
}

// TestNonProjectDestinationReservedPaths covers the paths a mount must not
// shadow beyond the projects root: the guest socket directory, the guest agent
// mount, which the container executes its entry point from, and /tmp, which
// podman mounts as the writable tmpfs the guest file API and the output spill
// rely on.
func TestNonProjectDestinationReservedPaths(t *testing.T) {
	server := &Server{
		ProjectsRoot:    "/projects",
		SocketsRoot:     "/run/dsh-podman",
		GuestAgentMount: "/opt/dsh-podman/guest-agent",
		Logger:          silentLogger(),
	}
	rejected := []string{
		"/run/dsh-podman",
		"/run/dsh-podman/dsh-podman-x-default",
		"/opt/dsh-podman/guest-agent",
		"/opt/dsh-podman/guest-agent/bin",
		"/tmp",
		"/tmp/dsh-podman",
		"/tmp/dsh-podman/spill.stdout",
		// Ancestors hide every reserved path beneath them.
		"/",
		"/run",
		"/opt",
		"/opt/dsh-podman",
		"/projects",
	}
	for _, destination := range rejected {
		if err := server.nonProjectDestination(destination); err == nil {
			t.Errorf("accepted reserved destination %q", destination)
		}
	}
	for _, destination := range []string{"/data", "/var/cache", "/run/other", "/opt/tools", "/tmp2", "/var/tmp"} {
		if err := server.nonProjectDestination(destination); err != nil {
			t.Errorf("rejected usable destination %q: %v", destination, err)
		}
	}
	// An unset reserved path must not reject everything.
	empty := &Server{ProjectsRoot: "/projects", Logger: silentLogger()}
	if err := empty.nonProjectDestination("/run/dsh-podman"); err != nil {
		t.Errorf("unset reserved paths should be skipped: %v", err)
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

func TestAddContainerMountRestoresOnFailedRecreate(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{
		WorkspaceSlug: "proj",
		Containers: []state.Container{
			{Name: "dev", PodmanName: "dsh-podman-proj-dev", ImageID: "arch", Status: "running"},
		},
	}}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveImages([]state.Image{{ImageID: "arch", ImageTag: "localhost/dsh-podman/arch:latest"}}); err != nil {
		t.Fatal(err)
	}
	fake := newFakePodman()
	fake.exists["dsh-podman-proj-dev"] = true
	fake.recreateFails = 1
	server := &Server{Store: store, Podman: fake, Logger: silentLogger()}
	_, err := server.AddContainerMount(context.Background(), &ctl.AddContainerMountRequest{
		WorkspaceSlug: "proj", Container: "dev", Kind: ctl.MountKind_MOUNT_KIND_TMPFS, Destination: "/mnt/data", Mode: ctl.MountMode_MOUNT_MODE_READ_WRITE,
	})
	if status.Code(err) != codes.Internal {
		t.Fatalf("expected Internal, got %v", err)
	}
	if len(fake.recreated) != 2 {
		t.Fatalf("expected the failed recreate and a restore, got %v", fake.recreated)
	}
	if !fake.exists["dsh-podman-proj-dev"] {
		t.Fatalf("the replaced container was not restored")
	}
	stored, err := store.Workspaces()
	if err != nil {
		t.Fatal(err)
	}
	if len(stored[0].Containers[0].Mounts) != 0 {
		t.Fatalf("the failed mutation must not be persisted: %#v", stored[0].Containers[0].Mounts)
	}
}

// TestToProtoReportsDefaultContainerMounts pins the workspace projection to the
// default container's mounts, not the workspace-level fallback: a mode change
// applied to the default container (RecreateContainer) must not be masked by a
// stale workspace list.
func TestToProtoReportsDefaultContainerMounts(t *testing.T) {
	workspace := state.Workspace{
		WorkspaceSlug: "proj",
		ProjectName:   "team",
		Mounts:        []state.Mount{{ProjectName: "team", Mode: "read_write"}},
		Containers: []state.Container{{
			Name:   "default",
			Mounts: []state.Mount{{ProjectName: "team", Mode: "read_only"}},
		}},
	}
	proto := toProto(workspace)
	if len(proto.GetMounts()) != 1 || proto.GetMounts()[0].GetMode() != ctl.MountMode_MOUNT_MODE_READ_ONLY {
		t.Fatalf("toProto must report the default container's mounts, got %v", proto.GetMounts())
	}
	// With no default container the workspace-level list is the only source.
	fallback := toProto(state.Workspace{
		WorkspaceSlug: "proj",
		ProjectName:   "team",
		Mounts:        []state.Mount{{ProjectName: "team", Mode: "read_only"}},
	})
	if len(fallback.GetMounts()) != 1 || fallback.GetMounts()[0].GetMode() != ctl.MountMode_MOUNT_MODE_READ_ONLY {
		t.Fatalf("toProto must fall back to the workspace mounts, got %v", fallback.GetMounts())
	}
}

// TestRecreateContainerReportsDefaultProjectReadOnly recreates the default
// container with its primary project mount read-only and asserts the returned
// workspace and the stored record agree.
func TestRecreateContainerReportsDefaultProjectReadOnly(t *testing.T) {
	root := tempRoot(t)
	if err := os.MkdirAll(filepath.Join(root, "team"), 0755); err != nil {
		t.Fatal(err)
	}
	store := newTestStore(t)
	if err := store.SaveImages([]state.Image{{ImageID: "arch", ImageTag: "localhost/dsh-podman/arch:latest"}}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveWorkspaces([]state.Workspace{{
		WorkspaceSlug: "proj",
		ProjectName:   "team",
		Mounts:        []state.Mount{{ProjectName: "team", Mode: "read_write"}},
		Containers: []state.Container{{
			Name: "default", PodmanName: "dsh-podman-proj-default", ImageID: "arch", Status: "running",
			Mounts: []state.Mount{{ProjectName: "team", Mode: "read_write"}},
		}},
	}}); err != nil {
		t.Fatal(err)
	}
	fake := newFakePodman()
	fake.exists["dsh-podman-proj-default"] = true
	server := &Server{Store: store, Podman: fake, ProjectsRoot: root, Logger: silentLogger()}

	workspace, err := server.RecreateContainer(context.Background(), &ctl.RecreateContainerRequest{
		WorkspaceSlug: "proj", Container: "default",
		Mounts: []*ctl.ProjectMount{{ProjectName: "team", Mode: ctl.MountMode_MOUNT_MODE_READ_ONLY}},
	})
	if err != nil {
		t.Fatalf("recreate failed: %v", err)
	}
	if len(workspace.GetMounts()) != 1 || workspace.GetMounts()[0].GetMode() != ctl.MountMode_MOUNT_MODE_READ_ONLY {
		t.Fatalf("the returned workspace must report the read-only mount, got %v", workspace.GetMounts())
	}
	stored, err := store.Workspaces()
	if err != nil {
		t.Fatal(err)
	}
	container, ok := containerByLogical(&stored[0], "default")
	if !ok || len(container.Mounts) != 1 || container.Mounts[0].Mode != "read_only" {
		t.Fatalf("the stored default container must be read-only, got %#v", container)
	}
}

// TestAddContainerMountRejectsExistingPrimaryWithDifferentMode guards the strict
// add contract: re-adding an existing mount is rejected rather than silently
// changing its mode. Changing a mode is UpdateContainerMount's job.
func TestAddContainerMountRejectsExistingPrimaryWithDifferentMode(t *testing.T) {
	root := tempRoot(t)
	if err := os.MkdirAll(filepath.Join(root, "team"), 0755); err != nil {
		t.Fatal(err)
	}
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{
		WorkspaceSlug: "proj",
		ProjectName:   "team",
		Mounts:        []state.Mount{{ProjectName: "team", Mode: "read_write"}},
		Containers: []state.Container{{
			Name: "default", PodmanName: "dsh-podman-proj-default", ImageID: "arch", Status: "running",
			Mounts: []state.Mount{{ProjectName: "team", Mode: "read_write"}},
		}},
	}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, ProjectsRoot: root, Logger: silentLogger()}
	_, err := server.AddContainerMount(context.Background(), &ctl.AddContainerMountRequest{
		WorkspaceSlug: "proj", Container: "default", Project: "team", Mode: ctl.MountMode_MOUNT_MODE_READ_ONLY,
	})
	if status.Code(err) != codes.AlreadyExists {
		t.Fatalf("re-adding the primary must be rejected, got %v", err)
	}
	stored, err := store.Workspaces()
	if err != nil {
		t.Fatal(err)
	}
	container, ok := containerByLogical(&stored[0], "default")
	if !ok || len(container.Mounts) != 1 || container.Mounts[0].Mode != "read_write" {
		t.Fatalf("the rejected add must not change the stored mode, got %#v", container)
	}
}

// updateMountFixture stores a workspace whose default container carries mounts,
// returning a server with podman available.
func updateMountFixture(t *testing.T, root string, mounts []state.Mount) (*Server, *fakePodman, *state.Store) {
	t.Helper()
	store := newTestStore(t)
	if err := store.SaveImages([]state.Image{{ImageID: "arch", ImageTag: "localhost/dsh-podman/arch:latest"}}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveWorkspaces([]state.Workspace{{
		WorkspaceSlug: "proj",
		ProjectName:   "team",
		Mounts:        mounts,
		Containers: []state.Container{{
			Name: "default", PodmanName: "dsh-podman-proj-default", ImageID: "arch", Status: "running",
			Mounts: mounts,
		}},
	}}); err != nil {
		t.Fatal(err)
	}
	fake := newFakePodman()
	fake.exists["dsh-podman-proj-default"] = true
	return &Server{Store: store, Podman: fake, ProjectsRoot: root, Logger: silentLogger()}, fake, store
}

func TestUpdateContainerMountChangesMode(t *testing.T) {
	root := tempRoot(t)
	if err := os.MkdirAll(filepath.Join(root, "team"), 0755); err != nil {
		t.Fatal(err)
	}
	server, fake, store := updateMountFixture(t, root, []state.Mount{{ProjectName: "team", Mode: "read_write"}})
	container, err := server.UpdateContainerMount(context.Background(), &ctl.UpdateContainerMountRequest{
		WorkspaceSlug: "proj", Container: "default", Kind: ctl.MountKind_MOUNT_KIND_PROJECT, Project: "team", Mode: ctl.MountMode_MOUNT_MODE_READ_ONLY,
	})
	if err != nil {
		t.Fatalf("update failed: %v", err)
	}
	if len(container.GetMounts()) != 1 || container.GetMounts()[0].GetMode() != ctl.MountMode_MOUNT_MODE_READ_ONLY {
		t.Fatalf("the returned container must be read-only, got %v", container.GetMounts())
	}
	if len(fake.recreated) != 1 {
		t.Fatalf("expected one recreate, got %v", fake.recreated)
	}
	stored, err := store.Workspaces()
	if err != nil {
		t.Fatal(err)
	}
	record, ok := containerByLogical(&stored[0], "default")
	if !ok || len(record.Mounts) != 1 || record.Mounts[0].Mode != "read_only" {
		t.Fatalf("the stored default container must be read-only, got %#v", record)
	}
}

func TestUpdateContainerMountRejectsModeLessKinds(t *testing.T) {
	server, _, _ := updateMountFixture(t, tempRoot(t), []state.Mount{{ProjectName: "team", Mode: "read_write"}})
	for _, kind := range []ctl.MountKind{ctl.MountKind_MOUNT_KIND_TMPFS, ctl.MountKind_MOUNT_KIND_SECRET} {
		_, err := server.UpdateContainerMount(context.Background(), &ctl.UpdateContainerMountRequest{WorkspaceSlug: "proj", Container: "default", Kind: kind, Mode: ctl.MountMode_MOUNT_MODE_READ_ONLY})
		if status.Code(err) != codes.InvalidArgument {
			t.Fatalf("kind %v: expected InvalidArgument, got %v", kind, err)
		}
	}
	_, err := server.UpdateContainerMount(context.Background(), &ctl.UpdateContainerMountRequest{WorkspaceSlug: "proj", Container: "default", Kind: ctl.MountKind_MOUNT_KIND_PROJECT, Project: "team"})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("missing mode: expected InvalidArgument, got %v", err)
	}
}

func TestUpdateContainerMountRejectsUnchangedMode(t *testing.T) {
	server, fake, _ := updateMountFixture(t, tempRoot(t), []state.Mount{{ProjectName: "team", Mode: "read_only"}})
	_, err := server.UpdateContainerMount(context.Background(), &ctl.UpdateContainerMountRequest{
		WorkspaceSlug: "proj", Container: "default", Kind: ctl.MountKind_MOUNT_KIND_PROJECT, Project: "team", Mode: ctl.MountMode_MOUNT_MODE_READ_ONLY,
	})
	if status.Code(err) != codes.AlreadyExists {
		t.Fatalf("unchanged mode: expected AlreadyExists, got %v", err)
	}
	if len(fake.recreated) != 0 {
		t.Fatalf("an unchanged mode must not recreate, got %v", fake.recreated)
	}
}

func TestUpdateContainerMountSelectorErrors(t *testing.T) {
	server, _, _ := updateMountFixture(t, tempRoot(t), []state.Mount{
		{ProjectName: "team", Mode: "read_write"},
		{Kind: "volume", Volume: "data", Destination: "/a", Mode: "read_write"},
		{Kind: "volume", Volume: "data", Destination: "/b", Mode: "read_write"},
	})
	_, err := server.UpdateContainerMount(context.Background(), &ctl.UpdateContainerMountRequest{WorkspaceSlug: "proj", Container: "default", Kind: ctl.MountKind_MOUNT_KIND_PROJECT, Mode: ctl.MountMode_MOUNT_MODE_READ_ONLY})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("handle-free project: expected InvalidArgument, got %v", err)
	}
	_, err = server.UpdateContainerMount(context.Background(), &ctl.UpdateContainerMountRequest{WorkspaceSlug: "proj", Container: "default", Kind: ctl.MountKind_MOUNT_KIND_PROJECT, Project: "nope", Mode: ctl.MountMode_MOUNT_MODE_READ_ONLY})
	if status.Code(err) != codes.NotFound {
		t.Fatalf("unknown project: expected NotFound, got %v", err)
	}
	_, err = server.UpdateContainerMount(context.Background(), &ctl.UpdateContainerMountRequest{WorkspaceSlug: "proj", Container: "default", Kind: ctl.MountKind_MOUNT_KIND_VOLUME, Volume: "data", Mode: ctl.MountMode_MOUNT_MODE_READ_ONLY})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("ambiguous volume: expected InvalidArgument, got %v", err)
	}
}

func TestUpdateContainerMountRestoresOnFailedRecreate(t *testing.T) {
	root := tempRoot(t)
	if err := os.MkdirAll(filepath.Join(root, "team"), 0755); err != nil {
		t.Fatal(err)
	}
	server, fake, store := updateMountFixture(t, root, []state.Mount{{ProjectName: "team", Mode: "read_write"}})
	fake.recreateFails = 1
	_, err := server.UpdateContainerMount(context.Background(), &ctl.UpdateContainerMountRequest{
		WorkspaceSlug: "proj", Container: "default", Kind: ctl.MountKind_MOUNT_KIND_PROJECT, Project: "team", Mode: ctl.MountMode_MOUNT_MODE_READ_ONLY,
	})
	if status.Code(err) != codes.Internal {
		t.Fatalf("expected Internal, got %v", err)
	}
	if len(fake.recreated) != 2 {
		t.Fatalf("expected the failed recreate and a restore, got %v", fake.recreated)
	}
	stored, err := store.Workspaces()
	if err != nil {
		t.Fatal(err)
	}
	record, ok := containerByLogical(&stored[0], "default")
	if !ok || len(record.Mounts) != 1 || record.Mounts[0].Mode != "read_write" {
		t.Fatalf("the failed update must not be persisted, got %#v", record)
	}
}
