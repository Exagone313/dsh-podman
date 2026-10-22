// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"io"
	"log/slog"
	"path/filepath"
	"testing"
	"time"

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

// staleCreatedAt is a fixed past timestamp stored before an operation that
// replaces a container, so a test can assert the record was refreshed.
const staleCreatedAt = "2000-01-01T00:00:00Z"

// podmanCreatedAt is the creation time fakePodman reports for a container, so
// a test can assert the record stores podman's value rather than the local
// clock.
const podmanCreatedAt = "2026-10-22T10:00:00Z"

// requirePodmanCreatedAt fails unless createdAt is exactly the timestamp the
// fake podman reported.
func requirePodmanCreatedAt(t *testing.T, createdAt string) {
	t.Helper()
	if createdAt != podmanCreatedAt {
		t.Fatalf("created_at = %q, want podman's %q", createdAt, podmanCreatedAt)
	}
}

// requireFreshCreatedAt fails unless createdAt is later than staleCreatedAt,
// pinning the local-clock fallback used when podman's inspect fails.
func requireFreshCreatedAt(t *testing.T, createdAt string) {
	t.Helper()
	got, err := time.Parse(time.RFC3339, createdAt)
	if err != nil {
		t.Fatalf("created_at %q is not RFC 3339: %v", createdAt, err)
	}
	stale, err := time.Parse(time.RFC3339, staleCreatedAt)
	if err != nil {
		t.Fatal(err)
	}
	if !got.After(stale) {
		t.Fatalf("created_at was not refreshed after a recreate: %q", createdAt)
	}
}

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
	envSecrets        []map[string]string
	recreated         []string
	createErr         error
	recreateFails     int
	// ptcCreates records every CreatePTC call, so a test can assert the
	// reserved PTC container's image, name, and credential.
	ptcCreates []ptcCreate
	// ptcErr, when set, makes CreatePTC fail.
	ptcErr error
	// images is the image-presence map ImageExists consults; an unrecorded
	// name counts as present, keeping callers that do not care about image
	// availability on the double's old unconditional answer.
	images map[string]bool
	// imageLabels serves ImageLabels, keyed by image tag. A tag absent from
	// the map has no labels, which the PTC image path treats as stale.
	imageLabels map[string]map[string]string
	// pulled records every image name ImagePull was asked to pull.
	pulled []string
	// pullErr, when set, makes ImagePull fail; the failed name is still
	// recorded in pulled, so a test can assert the attempt happened.
	pullErr error
	// writeMounts and readMounts are the read-write and read-only bind-mount
	// maps ListContainerBindMounts serves, keyed by podman name. They are
	// seeded directly by tests that need an existing conflicting mount; creates
	// do not record into them, so tests that only exercise creation see no
	// conflicts.
	writeMounts map[string][]string
	readMounts  map[string][]string
	// onStop, when set, runs as Stop is called: it stands in for what the
	// stopping container's processes did last.
	onStop func(name string)
	// creationTime is the timestamp ContainerCreated reports; empty means
	// podmanCreatedAt. creationErr, when set, makes the inspect fail so the
	// local-clock fallback can be exercised.
	creationTime string
	creationErr  error
}

func newFakePodman() *fakePodman {
	return &fakePodman{exists: map[string]bool{}, running: map[string]bool{}, agentStale: map[string]bool{}, agentToken: map[string]string{}, secretMissing: map[string]bool{}, writeMounts: map[string][]string{}, readMounts: map[string][]string{}, imageLabels: map[string]map[string]string{}}
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
