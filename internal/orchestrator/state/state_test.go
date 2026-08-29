// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package state

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestStateRoundTrip(t *testing.T) {
	store, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	images := []Image{{ImageID: "arch", BaseImage: "archlinux", Packages: []string{"git"}, ImageTag: "tag", BuiltAt: "now"}}
	if err := store.SaveImages(images); err != nil {
		t.Fatal(err)
	}
	got, err := store.Images()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].ImageID != "arch" || got[0].Packages[0] != "git" {
		t.Fatalf("round trip mismatch: %#v", got)
	}
}

func TestWorkspacesRoundTrip(t *testing.T) {
	store, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	workspaces := []Workspace{{
		WorkspaceSlug:   "proj",
		ContainerName:   "dsh-workspace-proj",
		ImageID:         "arch",
		Mounts:          []Mount{{ProjectName: "proj", Mode: "read_write"}},
		Status:          "running",
		AgentSocketPath: "/run/dsh-podman/dsh-workspace-proj/guest.sock",
		AgentToken:      "secret",
		CreatedAt:       "now",
	}}
	if err := store.SaveWorkspaces(workspaces); err != nil {
		t.Fatal(err)
	}
	got, err := store.Workspaces()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].ContainerName != "dsh-workspace-proj" || got[0].Mounts[0].Mode != "read_write" || got[0].AgentToken != "secret" {
		t.Fatalf("round trip mismatch: %#v", got)
	}
}

func TestLegacyWorkspaceMigratesDefaultContainer(t *testing.T) {
	store, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	legacy := Workspace{WorkspaceSlug: "proj", ContainerName: "dsh-workspace-proj", ImageID: "arch", Status: "running", AgentSocketPath: "/run/dsh-podman/dsh-workspace-proj/guest.sock", AgentToken: "secret", CreatedAt: "now"}
	if err := store.SaveWorkspaces([]Workspace{legacy}); err != nil {
		t.Fatal(err)
	}
	got, err := store.Workspaces()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || len(got[0].Containers) != 1 || got[0].Containers[0].Name != "default" {
		t.Fatalf("legacy workspace did not migrate a default container: %#v", got)
	}
	container := got[0].Containers[0]
	if container.PodmanName != "dsh-workspace-proj" || container.ImageID != "arch" || container.Status != "running" || container.AgentSocketPath != legacy.AgentSocketPath || container.AgentToken != "secret" || container.CreatedAt != "now" {
		t.Fatalf("migrated default container projection mismatch: %#v", container)
	}
}

func TestWorkspacesWithNamedContainersRoundTrip(t *testing.T) {
	store, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	workspaces := []Workspace{{
		WorkspaceSlug: "proj",
		Mounts:        []Mount{{ProjectName: "team", Mode: "read_write"}},
		Containers: []Container{
			{Name: "default", PodmanName: "dsh-workspace-proj", ImageID: "arch", Status: "running", CreatedAt: "now", AgentSocketPath: "/run/dsh-podman/dsh-workspace-proj/guest.sock", AgentToken: "secret"},
			{Name: "dev", PodmanName: "dsh-workspace-proj-dev", ImageID: "devimg", Status: "running", CreatedAt: "later", AgentSocketPath: "/run/dsh-podman/dsh-workspace-proj-dev/guest.sock", AgentToken: "devtok"},
		},
	}}
	if err := store.SaveWorkspaces(workspaces); err != nil {
		t.Fatal(err)
	}
	got, err := store.Workspaces()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || len(got[0].Containers) != 2 {
		t.Fatalf("named containers did not survive round trip: %#v", got)
	}
	if got[0].Containers[0].Name != "default" || got[0].Containers[0].PodmanName != "dsh-workspace-proj" {
		t.Fatalf("default container mismatch: %#v", got[0].Containers[0])
	}
	if got[0].Containers[1].Name != "dev" || got[0].Containers[1].PodmanName != "dsh-workspace-proj-dev" || got[0].Containers[1].ImageID != "devimg" || got[0].Containers[1].AgentToken != "devtok" {
		t.Fatalf("named container mismatch: %#v", got[0].Containers[1])
	}
}

func TestMissingStateIsEmpty(t *testing.T) {
	store, _ := New(t.TempDir())
	if got, err := store.Workspaces(); err != nil || len(got) != 0 {
		t.Fatalf("workspaces got %#v, %v", got, err)
	}
	if got, err := store.Images(); err != nil || len(got) != 0 {
		t.Fatalf("images got %#v, %v", got, err)
	}
}

func TestUpdateImagesAppends(t *testing.T) {
	store, _ := New(t.TempDir())
	err := store.UpdateImages(func(current []Image) ([]Image, error) {
		return append(current, Image{ImageID: "arch", ImageTag: "t1"}), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	err = store.UpdateImages(func(current []Image) ([]Image, error) {
		return append(current, Image{ImageID: "dev", ImageTag: "t2"}), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	got, err := store.Images()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].ImageID != "arch" || got[1].ImageID != "dev" {
		t.Fatalf("unexpected images: %#v", got)
	}
}

func TestUpdateImagesRollbackOnError(t *testing.T) {
	store, _ := New(t.TempDir())
	if err := store.SaveImages([]Image{{ImageID: "arch"}}); err != nil {
		t.Fatal(err)
	}
	boom := errors.New("boom")
	if err := store.UpdateImages(func(current []Image) ([]Image, error) { return nil, boom }); !errors.Is(err, boom) {
		t.Fatalf("expected boom, got %v", err)
	}
	got, err := store.Images()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("failed update was persisted: %#v", got)
	}
}

func TestUpdateWorkspacesReplaces(t *testing.T) {
	store, _ := New(t.TempDir())
	if err := store.SaveWorkspaces([]Workspace{{WorkspaceSlug: "a", Status: "running"}}); err != nil {
		t.Fatal(err)
	}
	err := store.UpdateWorkspaces(func(current []Workspace) ([]Workspace, error) {
		current[0].Status = "stopped"
		return current, nil
	})
	if err != nil {
		t.Fatal(err)
	}
	got, err := store.Workspaces()
	if err != nil {
		t.Fatal(err)
	}
	if got[0].Status != "stopped" {
		t.Fatalf("workspace not updated: %#v", got)
	}
}

func TestCorruptFileReturnsError(t *testing.T) {
	dir := t.TempDir()
	store, _ := New(dir)
	if err := os.WriteFile(filepath.Join(dir, "images.toml"), []byte("not [valid toml"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Images(); err == nil {
		t.Fatal("expected error for corrupt state file")
	}
}

func TestNewCreatesDirectory(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "nested", "state")
	store, err := New(dir)
	if err != nil {
		t.Fatal(err)
	}
	info, statErr := os.Stat(store.dir)
	if statErr != nil || !info.IsDir() {
		t.Fatalf("state directory not created: %v", statErr)
	}
}

func TestContainerMountsRoundTrip(t *testing.T) {
	store, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	workspaces := []Workspace{{
		WorkspaceSlug: "proj",
		Mounts:        []Mount{{ProjectName: "team", Mode: "read_write"}},
		Containers: []Container{{
			Name:       "default",
			PodmanName: "dsh-workspace-proj",
			ImageID:    "arch",
			Status:     "running",
			Mounts:     []Mount{{ProjectName: "team", Mode: "read_only", Path: "src/lib", Destination: "/workspaces/team/src/lib"}},
		}},
	}}
	if err := store.SaveWorkspaces(workspaces); err != nil {
		t.Fatal(err)
	}
	got, err := store.Workspaces()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || len(got[0].Containers) != 1 {
		t.Fatalf("round trip mismatch: %#v", got)
	}
	mounts := got[0].Containers[0].Mounts
	if len(mounts) != 1 || mounts[0].ProjectName != "team" || mounts[0].Mode != "read_only" || mounts[0].Path != "src/lib" || mounts[0].Destination != "/workspaces/team/src/lib" {
		t.Fatalf("container mounts did not survive round trip: %#v", mounts)
	}
}
