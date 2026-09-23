// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"io"
	"log/slog"
	"path/filepath"
	"testing"

	"github.com/Exagone313/dsh-podman/internal/orchestrator/state"
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

// alwaysRunning is the podman run-state probe most reconcile tests want: every
// existing container is treated as running.
func alwaysRunning(string) (bool, error) { return true, nil }

// testWorkspaceSlug is a valid workspace slug: workspace ids are UUIDs, so
// tests that validate the slug (CreateWorkspace) or the stored container-name
// shape (DescribeWorkspace) use it.
const testWorkspaceSlug = "2c573001-4171-4900-904b-12a5cc02737a"

// testDefaultContainer is the default container name derived from
// testWorkspaceSlug.
const testDefaultContainer = "dsh-podman-2c573001-4171-4900-904b-12a5cc02737a-default"

// tempRoot returns a temporary directory with every symlink resolved.
//
// Mount sources are resolved before being handed to podman, so a test that
// compares a source against a path built from t.TempDir() would otherwise
// depend on whether TMPDIR is itself reached through a symlink. Use this for
// any directory standing in for the projects root. TestResolveMountSymlinkedRoot
// covers the symlinked case deliberately.
func tempRoot(t *testing.T) string {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return root
}

// fakePodman is a podmanAPI double for lifecycle tests. It records removals and
// creations and serves canned existence/run state.
type fakePodman struct {
	exists            map[string]bool
	running           map[string]bool
	agentStale        map[string]bool
	agentToken        map[string]string
	secretMissing     map[string]bool
	removed           []string
	removedPods       []string
	removedSocketDirs []string
	created           []string
	createdPaths      []string
	recreated         []string
	createErr         error
	recreateFails     int
}

func newFakePodman() *fakePodman {
	return &fakePodman{exists: map[string]bool{}, running: map[string]bool{}, agentStale: map[string]bool{}, agentToken: map[string]string{}, secretMissing: map[string]bool{}}
}

const (
	rebuildAllMidTag = "localhost/dsh-podman/mid:latest"
	rebuildAllTopTag = "localhost/dsh-podman/top:latest"
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
		{ImageID: "mid", Parent: "archlinux", PackageManager: "pacman", ImageTag: rebuildAllMidTag, BuiltAt: "old"},
		{ImageID: "top", Parent: "mid", PackageManager: "pacman", ImageTag: rebuildAllTopTag, BuiltAt: "old"},
	}
}
