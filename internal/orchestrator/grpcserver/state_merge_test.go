// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"context"
	"testing"

	ctl "github.com/Exagone313/dsh-podman/internal/genproto/dshctl/v1"
	"github.com/Exagone313/dsh-podman/internal/orchestrator/state"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func mergeTestWorkspace() state.Workspace {
	return state.Workspace{
		WorkspaceSlug: "proj",
		Containers: []state.Container{
			{Name: "default", PodmanName: "dsh-podman-proj-default", ImageID: "arch", Status: "running", Env: map[string]string{"A": "1"}},
			{Name: "dev", PodmanName: "dsh-podman-proj-dev", ImageID: "arch", Status: "running", Env: map[string]string{"B": "1"}},
		},
	}
}

// TestUpsertContainerPreservesConcurrentChanges is the regression test for the
// lost update: the caller mutates a record after a multi-second podman
// recreate, and the write must merge that record into the state as it currently
// stands instead of writing back the stale whole-workspace snapshot.
func TestUpsertContainerPreservesConcurrentChanges(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{mergeTestWorkspace()}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}

	// The caller's snapshot, read before its podman work.
	workspace, err := workspaceBySlug(store, "proj")
	if err != nil {
		t.Fatal(err)
	}
	record, ok := containerByLogical(&workspace, "default")
	if !ok {
		t.Fatal("default container missing")
	}
	updated := *record

	// A concurrent writer changes the *other* container in the meantime.
	if err := store.UpdateWorkspaces(func(all []state.Workspace) ([]state.Workspace, error) {
		all[0].Containers[1].Env = map[string]string{"B": "2"}
		return all, nil
	}); err != nil {
		t.Fatal(err)
	}

	// The stale caller now persists its own record.
	updated.Env = map[string]string{"A": "2"}
	if _, err := server.upsertContainer(workspace, updated); err != nil {
		t.Fatal(err)
	}

	stored, err := store.Workspaces()
	if err != nil {
		t.Fatal(err)
	}
	byName := map[string]state.Container{}
	for _, container := range stored[0].Containers {
		byName[container.Name] = container
	}
	if got := byName["dev"].Env["B"]; got != "2" {
		t.Fatalf("concurrent change to the other container was lost: %#v", byName["dev"].Env)
	}
	if got := byName["default"].Env["A"]; got != "2" {
		t.Fatalf("the caller's own record was not persisted: %#v", byName["default"].Env)
	}
}

// TestReconcileContainersPreservesAConcurrentWrite pins the same property on
// the reconciliation path, which runs podman lookups before it writes.
func TestReconcileContainersPreservesAConcurrentWrite(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{mergeTestWorkspace()}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}
	workspaces, err := store.Workspaces()
	if err != nil {
		t.Fatal(err)
	}

	// The lookup for the container that gets dropped doubles as the concurrent
	// writer: it changes the other container after the snapshot was read.
	exists := func(name string) (bool, error) {
		if name == "dsh-podman-proj-default" {
			if err := store.UpdateWorkspaces(func(all []state.Workspace) ([]state.Workspace, error) {
				all[0].Containers[1].Env = map[string]string{"B": "2"}
				return all, nil
			}); err != nil {
				return false, err
			}
			return false, nil
		}
		return true, nil
	}
	running := func(string) (bool, error) { return true, nil }

	if _, err := server.reconcileContainers(workspaces, exists, running); err != nil {
		t.Fatal(err)
	}
	stored, err := store.Workspaces()
	if err != nil {
		t.Fatal(err)
	}
	if len(stored) != 1 || len(stored[0].Containers) != 1 {
		t.Fatalf("reconciliation left %#v", stored)
	}
	dev := stored[0].Containers[0]
	if dev.Name != "dev" {
		t.Fatalf("expected the dev container to survive, got %q", dev.Name)
	}
	if got := dev.Env["B"]; got != "2" {
		t.Fatalf("concurrent write was lost: %#v", dev.Env)
	}
}

// TestApplyContainerDecisions covers the verdict application directly: drop,
// refresh, and leave-untouched.
func TestApplyContainerDecisions(t *testing.T) {
	all := []state.Workspace{{
		WorkspaceSlug: "proj",
		Containers: []state.Container{
			{Name: "default", PodmanName: "p-default", Status: "running"},
			{Name: "dev", PodmanName: "p-dev", Status: "running"},
			{Name: "web", PodmanName: "p-web", Status: "running"},
		},
	}}
	out := applyContainerDecisions(all, map[string]containerDecision{
		"p-default": {drop: true},
		"p-dev":     {status: "stopped"},
	})
	if len(out) != 1 || len(out[0].Containers) != 2 {
		t.Fatalf("unexpected result: %#v", out)
	}
	kept := map[string]state.Container{}
	for _, container := range out[0].Containers {
		kept[container.Name] = container
	}
	if kept["dev"].Status != "stopped" {
		t.Fatalf("verdict not applied: %#v", kept["dev"])
	}
	if kept["web"].Status != "running" {
		t.Fatalf("container with no verdict must be untouched: %#v", kept["web"])
	}
	// A workspace whose every container is dropped disappears entirely.
	dropped := applyContainerDecisions(all, map[string]containerDecision{
		"p-default": {drop: true},
		"p-dev":     {drop: true},
		"p-web":     {drop: true},
	})
	if len(dropped) != 0 {
		t.Fatalf("empty workspace must be dropped: %#v", dropped)
	}
}

// TestDefaultContainerIsNotFabricated pins that a workspace whose default
// container is gone but which still has a named one reports the default as
// missing instead of silently acting on an unrelated container.
func TestDefaultContainerIsNotFabricated(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{
		WorkspaceSlug: "proj",
		Containers: []state.Container{
			{Name: "db", PodmanName: "dsh-podman-proj-db", ImageID: "arch", Status: "running"},
		},
	}}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveImages([]state.Image{{ImageID: "arch", ImageTag: "localhost/dsh-podman/arch:latest"}}); err != nil {
		t.Fatal(err)
	}
	fake := newFakePodman()
	server := &Server{Store: store, Podman: fake, Logger: silentLogger()}

	if _, err := server.EnsureContainer(context.Background(), &ctl.EnsureContainerRequest{WorkspaceSlug: "proj"}); status.Code(err) != codes.NotFound {
		t.Fatalf("expected NotFound for the missing default, got %v", err)
	}
	if len(fake.recreated) != 0 {
		t.Fatalf("must not touch an unrelated container: %#v", fake.recreated)
	}
	// The named container still resolves.
	if _, err := server.EnsureContainer(context.Background(), &ctl.EnsureContainerRequest{WorkspaceSlug: "proj", Container: "db"}); err != nil {
		t.Fatalf("named container must still resolve: %v", err)
	}
}
