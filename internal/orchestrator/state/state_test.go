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
