// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	ctl "github.com/Exagone313/dsh-podman/internal/genproto/dshctl/v1"
	"github.com/Exagone313/dsh-podman/internal/orchestrator/state"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func (f *fakePodman) VolumeExists(string) (bool, error) { return false, nil }

func (f *fakePodman) VolumeCreate(string) error { return nil }

func (f *fakePodman) VolumeList() ([]string, error) { return nil, nil }

func (f *fakePodman) VolumeRemove(string) error { return nil }

func TestRemoveVolumeInUse(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{
		WorkspaceSlug: "ws",
		Containers: []state.Container{{
			Name:   "default",
			Mounts: []state.Mount{{Kind: "volume", Volume: "data", Destination: "/data", Mode: "read_write"}},
		}},
	}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}
	_, err := server.RemoveVolume(context.Background(), &ctl.RemoveVolumeRequest{Name: "data"})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("expected FailedPrecondition, got %v", err)
	}
	if !strings.Contains(err.Error(), `volume "data" is mounted in workspace "ws" container "default"`) {
		t.Fatalf("unexpected error message: %v", err)
	}
}

func TestRemoveVolumeInUseOnNamedContainer(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{
		WorkspaceSlug: "ws",
		Containers: []state.Container{{
			Name:   "db",
			Mounts: []state.Mount{{Kind: "volume", Volume: "data", Destination: "/data"}},
		}},
	}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}
	_, err := server.RemoveVolume(context.Background(), &ctl.RemoveVolumeRequest{Name: "data"})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("expected FailedPrecondition, got %v", err)
	}
	if !strings.Contains(err.Error(), `container "db"`) {
		t.Fatalf("unexpected error message: %v", err)
	}
}

func TestRemoveVolumeInUseViaWorkspaceMounts(t *testing.T) {
	// A container without its own mounts falls back to the workspace's default
	// mounts, which must count as usage too.
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{
		WorkspaceSlug: "ws",
		Mounts:        []state.Mount{{Kind: "volume", Volume: "data", Destination: "/data"}},
		Containers:    []state.Container{{Name: "default"}},
	}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}
	_, err := server.RemoveVolume(context.Background(), &ctl.RemoveVolumeRequest{Name: "data"})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("expected FailedPrecondition, got %v", err)
	}
}

func TestRemoveVolumeNotInUseStillRequiresPodman(t *testing.T) {
	server := &Server{Store: newTestStore(t), Logger: silentLogger()}
	_, err := server.RemoveVolume(context.Background(), &ctl.RemoveVolumeRequest{Name: "data"})
	if status.Code(err) != codes.FailedPrecondition || !strings.Contains(err.Error(), "podman is not configured") {
		t.Fatalf("expected podman precondition, got %v", err)
	}
}

func TestPodmanMountsTmpfsAndVolume(t *testing.T) {
	root := tempRoot(t)
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

func TestVolumeRPCsRequirePodman(t *testing.T) {
	server := &Server{Store: newTestStore(t), Logger: silentLogger()}
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
	root := tempRoot(t)
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{
		WorkspaceSlug: "proj",
		Containers: []state.Container{
			{Name: "dev", PodmanName: "dsh-podman-proj-dev", ImageID: "arch", Status: "running"},
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
	root := tempRoot(t)
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{
		WorkspaceSlug: "proj",
		Containers: []state.Container{{
			Name: "dev", PodmanName: "dsh-podman-proj-dev", ImageID: "arch", Status: "running",
			Mounts: []state.Mount{{Kind: "volume", Volume: "data", Destination: "/data", Mode: "read_write"}, {Kind: "tmpfs", Destination: "/tmp/x", Mode: "read_write"}},
		}},
	}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, ProjectsRoot: root, VolumePrefix: "dsh-podman-", Logger: silentLogger()}
	_, err := server.AddContainerMount(context.Background(), &ctl.AddContainerMountRequest{WorkspaceSlug: "proj", Container: "dev", Kind: ctl.MountKind_MOUNT_KIND_VOLUME, Volume: "data", Destination: "/data", Mode: ctl.MountMode_MOUNT_MODE_READ_WRITE})
	if status.Code(err) != codes.AlreadyExists {
		t.Fatalf("duplicate volume: expected AlreadyExists, got %v", err)
	}
	_, err = server.AddContainerMount(context.Background(), &ctl.AddContainerMountRequest{WorkspaceSlug: "proj", Container: "dev", Kind: ctl.MountKind_MOUNT_KIND_TMPFS, Destination: "/tmp/x", Mode: ctl.MountMode_MOUNT_MODE_READ_WRITE})
	if status.Code(err) != codes.AlreadyExists {
		t.Fatalf("duplicate tmpfs: expected AlreadyExists, got %v", err)
	}
}

func TestRemoveContainerMountVolume(t *testing.T) {
	root := tempRoot(t)
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{
		WorkspaceSlug: "proj",
		Containers: []state.Container{{
			Name: "dev", PodmanName: "dsh-podman-proj-dev", ImageID: "arch", Status: "running",
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
	_, err = server.RemoveContainerMount(context.Background(), &ctl.RemoveContainerMountRequest{WorkspaceSlug: "proj", Container: "dev", Kind: ctl.MountKind_MOUNT_KIND_VOLUME, Destination: "/data"})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("volume removal by destination: expected FailedPrecondition, got %v", err)
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

// TestRemoveContainerMountVolumeAmbiguous covers a volume mounted at two
// destinations: the name alone is rejected, naming the destinations to pass.
func TestRemoveContainerMountVolumeAmbiguous(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{
		WorkspaceSlug: "proj",
		Containers: []state.Container{{
			Name: "dev", PodmanName: "dsh-podman-proj-dev", ImageID: "arch", Status: "running",
			Mounts: []state.Mount{
				{Kind: "volume", Volume: "data", Destination: "/a", Mode: "read_write"},
				{Kind: "volume", Volume: "data", Destination: "/b", Mode: "read_write"},
			},
		}},
	}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, ProjectsRoot: tempRoot(t), VolumePrefix: "dsh-podman-", Logger: silentLogger()}

	_, err := server.RemoveContainerMount(context.Background(), &ctl.RemoveContainerMountRequest{WorkspaceSlug: "proj", Container: "dev", Kind: ctl.MountKind_MOUNT_KIND_VOLUME, Volume: "data"})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("ambiguous volume: expected InvalidArgument, got %v", err)
	}
	if got := status.Convert(err).Message(); got != `ambiguous mount: volume "data" matches "/a", "/b"; pass destination` {
		t.Fatalf("ambiguous message: %q", got)
	}
	_, err = server.RemoveContainerMount(context.Background(), &ctl.RemoveContainerMountRequest{WorkspaceSlug: "proj", Container: "dev", Kind: ctl.MountKind_MOUNT_KIND_VOLUME, Destination: "/b"})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("volume by destination: expected FailedPrecondition, got %v", err)
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
		m, err := mountFromProto(&ctl.ProjectMount{Kind: kind, Mode: ctl.MountMode_MOUNT_MODE_READ_ONLY})
		if err != nil || m.Kind != "" {
			t.Fatalf("kind %v should map to empty, got %q %v", kind, m.Kind, err)
		}
	}
	m, err := mountFromProto(&ctl.ProjectMount{Kind: ctl.MountKind_MOUNT_KIND_TMPFS, Mode: ctl.MountMode_MOUNT_MODE_READ_WRITE})
	if err != nil || m.Kind != "tmpfs" {
		t.Fatalf("tmpfs kind not mapped, got %q %v", m.Kind, err)
	}
	m, err = mountFromProto(&ctl.ProjectMount{Kind: ctl.MountKind_MOUNT_KIND_VOLUME, Volume: "data", Mode: ctl.MountMode_MOUNT_MODE_READ_WRITE})
	if err != nil || m.Kind != "volume" || m.Volume != "data" || m.Mode != "read_write" {
		t.Fatalf("volume mount not mapped: %#v %v", m, err)
	}
}

func TestAddContainerMountAllowsSameVolumeAtDifferentDestination(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{
		WorkspaceSlug: "proj",
		Containers: []state.Container{
			{Name: "dev", PodmanName: "dsh-podman-proj-dev", ImageID: "arch", Status: "running", Mounts: []state.Mount{{Kind: "volume", Volume: "vol", Destination: "/mnt/a", Mode: "read_write"}}},
		},
	}}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveImages([]state.Image{{ImageID: "arch", ImageTag: "localhost/dsh-podman/arch:latest"}}); err != nil {
		t.Fatal(err)
	}
	fake := newFakePodman()
	fake.exists["dsh-podman-proj-dev"] = true
	server := &Server{Store: store, Podman: fake, Logger: silentLogger()}
	if _, err := server.AddContainerMount(context.Background(), &ctl.AddContainerMountRequest{
		WorkspaceSlug: "proj", Container: "dev", Kind: ctl.MountKind_MOUNT_KIND_VOLUME, Volume: "vol", Destination: "/mnt/b", Mode: ctl.MountMode_MOUNT_MODE_READ_ONLY,
	}); err != nil {
		t.Fatalf("a distinct destination must be accepted: %v", err)
	}
	stored, err := store.Workspaces()
	if err != nil {
		t.Fatal(err)
	}
	if len(stored[0].Containers[0].Mounts) != 2 {
		t.Fatalf("expected two mounts, got %#v", stored[0].Containers[0].Mounts)
	}
}

func TestAddContainerMountRejectsSameVolumeAtSameDestination(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{
		WorkspaceSlug: "proj",
		Containers: []state.Container{
			{Name: "dev", PodmanName: "dsh-podman-proj-dev", ImageID: "arch", Status: "running", Mounts: []state.Mount{{Kind: "volume", Volume: "vol", Destination: "/mnt/a", Mode: "read_write"}}},
		},
	}}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveImages([]state.Image{{ImageID: "arch", ImageTag: "localhost/dsh-podman/arch:latest"}}); err != nil {
		t.Fatal(err)
	}
	fake := newFakePodman()
	fake.exists["dsh-podman-proj-dev"] = true
	server := &Server{Store: store, Podman: fake, Logger: silentLogger()}
	_, err := server.AddContainerMount(context.Background(), &ctl.AddContainerMountRequest{
		WorkspaceSlug: "proj", Container: "dev", Kind: ctl.MountKind_MOUNT_KIND_VOLUME, Volume: "vol", Destination: "/mnt/a", Mode: ctl.MountMode_MOUNT_MODE_READ_ONLY,
	})
	if status.Code(err) != codes.AlreadyExists {
		t.Fatalf("expected AlreadyExists, got %v", err)
	}
}
