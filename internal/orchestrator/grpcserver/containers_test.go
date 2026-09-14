// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"context"
	"errors"
	"strings"
	"testing"

	ctl "github.com/Exagone313/dsh-podman/internal/genproto/dshctl/v1"
	"github.com/Exagone313/dsh-podman/internal/orchestrator/state"
	"github.com/opencontainers/runtime-spec/specs-go"
	"go.podman.io/podman/v6/pkg/specgen"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func TestListContainersStateDriven(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{WorkspaceSlug: "proj", ContainerName: "dsh-podman-proj-default", Status: "running"}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}
	response, err := server.ListContainers(context.Background(), &ctl.ListContainersRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if len(response.Containers) != 1 || response.Containers[0].ContainerName != "default" || response.Containers[0].PodmanName != "dsh-podman-proj-default" || response.Containers[0].WorkspaceSlug != "proj" || response.Containers[0].Status != "running" {
		t.Fatalf("unexpected containers: %#v", response.Containers)
	}
}

func TestListContainersSorted(t *testing.T) {
	store := newTestStore(t)
	workspaces := []state.Workspace{
		{WorkspaceSlug: "b", Containers: []state.Container{{Name: "default", PodmanName: "dsh-podman-b-default", Status: "running"}}},
		{WorkspaceSlug: "a", Containers: []state.Container{
			{Name: "dev", PodmanName: "dsh-podman-a-dev", Status: "running"},
			{Name: "default", PodmanName: "dsh-podman-a-default", Status: "running"},
		}},
	}
	if err := store.SaveWorkspaces(workspaces); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}
	response, err := server.ListContainers(context.Background(), &ctl.ListContainersRequest{})
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, container := range response.Containers {
		names = append(names, container.WorkspaceSlug+":"+container.ContainerName)
	}
	if got, want := strings.Join(names, ","), "a:default,a:dev,b:default"; got != want {
		t.Fatalf("containers not sorted: %v, want %v", got, want)
	}
}

func TestDescribeWorkspaceRejectsInvalidContainerName(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{WorkspaceSlug: "proj", ContainerName: "../escape"}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}
	_, err := server.DescribeWorkspace(context.Background(), &ctl.DescribeWorkspaceRequest{WorkspaceSlug: "proj"})
	if status.Code(err) != codes.NotFound {
		t.Fatalf("expected NotFound, got %v", err)
	}
}

func TestContainerRows(t *testing.T) {
	workspaces := []state.Workspace{{
		WorkspaceSlug: "proj",
		Mounts:        []state.Mount{{ProjectName: "team", Mode: "read_write"}},
		Containers: []state.Container{
			{Name: "default", PodmanName: "dsh-podman-proj-default", ImageID: "arch", Status: "running", CreatedAt: "now", AgentSocketPath: "/sock/default", AgentToken: "tok-default"},
			{Name: "dev", PodmanName: "dsh-podman-proj-dev", ImageID: "devimg", Status: "running", CreatedAt: "later", AgentSocketPath: "/sock/dev", AgentToken: "tok-dev"},
		},
	}}
	rows := containerRows(workspaces)
	if len(rows) != 2 {
		t.Fatalf("expected both containers, got %#v", rows)
	}
	def := rows[0]
	if def.ContainerName != "default" || def.PodmanName != "dsh-podman-proj-default" || def.WorkspaceSlug != "proj" || def.ImageId != "arch" || def.Status != "running" || def.CreatedAt != "now" || def.AgentSocketPath != "/sock/default" || def.AgentToken != "tok-default" {
		t.Fatalf("default row mismatch: %#v", def)
	}
	dev := rows[1]
	if dev.ContainerName != "dev" || dev.PodmanName != "dsh-podman-proj-dev" || dev.WorkspaceSlug != "proj" || dev.ImageId != "devimg" || dev.Status != "running" || dev.CreatedAt != "later" || dev.AgentSocketPath != "/sock/dev" || dev.AgentToken != "tok-dev" {
		t.Fatalf("named row mismatch: %#v", dev)
	}
	if len(def.Mounts) != 1 || def.Mounts[0].ProjectName != "team" || def.Mounts[0].Mode != ctl.MountMode_MOUNT_MODE_READ_WRITE {
		t.Fatalf("mounts not projected: %#v", def.Mounts)
	}
}

func TestContainerRowsKeepsStoredStatus(t *testing.T) {
	workspaces := []state.Workspace{{
		WorkspaceSlug: "proj",
		Containers:    []state.Container{{Name: "default", PodmanName: "dsh-podman-proj-default", Status: "stopped"}},
	}}
	rows := containerRows(workspaces)
	if len(rows) != 1 || rows[0].Status != "stopped" {
		t.Fatalf("expected stored status kept, got %#v", rows)
	}
}

func TestReconcileContainersDropsDeletedNamedContainer(t *testing.T) {
	store := newTestStore(t)
	workspaces := []state.Workspace{{
		WorkspaceSlug: "proj",
		Containers: []state.Container{
			{Name: "default", PodmanName: "dsh-podman-proj-default", Status: "running"},
			{Name: "db", PodmanName: "dsh-podman-proj-db", Status: "running"},
		},
	}}
	if err := store.SaveWorkspaces(workspaces); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}
	exists := func(podmanName string) (bool, error) {
		return podmanName == "dsh-podman-proj-default", nil
	}
	reconciled, err := server.reconcileContainers(workspaces, exists, alwaysRunning)
	if err != nil {
		t.Fatal(err)
	}
	if len(reconciled) != 1 || len(reconciled[0].Containers) != 1 || reconciled[0].Containers[0].Name != "default" {
		t.Fatalf("expected only the default container to survive, got %#v", reconciled)
	}
	stored, err := store.Workspaces()
	if err != nil {
		t.Fatal(err)
	}
	if len(stored) != 1 || len(stored[0].Containers) != 1 || stored[0].Containers[0].Name != "default" {
		t.Fatalf("deleted container not removed from state, got %#v", stored)
	}
}

func TestReconcileContainersDropsWorkspaceWithoutContainers(t *testing.T) {
	store := newTestStore(t)
	workspaces := []state.Workspace{{
		WorkspaceSlug: "proj",
		Containers:    []state.Container{{Name: "default", PodmanName: "dsh-podman-proj-default", Status: "running"}},
	}}
	if err := store.SaveWorkspaces(workspaces); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}
	reconciled, err := server.reconcileContainers(workspaces, func(podmanName string) (bool, error) {
		return false, nil
	}, alwaysRunning)
	if err != nil {
		t.Fatal(err)
	}
	if len(reconciled) != 0 {
		t.Fatalf("expected the workspace to be dropped, got %#v", reconciled)
	}
	stored, err := store.Workspaces()
	if err != nil {
		t.Fatal(err)
	}
	if len(stored) != 0 {
		t.Fatalf("expected the workspace to be removed from state, got %#v", stored)
	}
}

func TestReconcileContainersKeepsWorkspaceWithNamedContainers(t *testing.T) {
	store := newTestStore(t)
	workspaces := []state.Workspace{{
		WorkspaceSlug: "proj",
		Containers: []state.Container{
			{Name: "default", PodmanName: "dsh-podman-proj-default", Status: "running"},
			{Name: "db", PodmanName: "dsh-podman-proj-db", Status: "running"},
		},
	}}
	if err := store.SaveWorkspaces(workspaces); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}
	reconciled, err := server.reconcileContainers(workspaces, func(podmanName string) (bool, error) {
		return podmanName == "dsh-podman-proj-db", nil
	}, alwaysRunning)
	if err != nil {
		t.Fatal(err)
	}
	if len(reconciled) != 1 || len(reconciled[0].Containers) != 1 || reconciled[0].Containers[0].Name != "db" {
		t.Fatalf("expected the named container to survive, got %#v", reconciled)
	}
	stored, err := store.Workspaces()
	if err != nil {
		t.Fatal(err)
	}
	if len(stored) != 1 || len(stored[0].Containers) != 1 || stored[0].Containers[0].Name != "db" {
		t.Fatalf("expected only the named container in state, got %#v", stored)
	}
}

func TestReconcileContainersKeepsOnLookupError(t *testing.T) {
	store := newTestStore(t)
	workspaces := []state.Workspace{{
		WorkspaceSlug: "proj",
		Containers:    []state.Container{{Name: "default", PodmanName: "dsh-podman-proj-default", Status: "running"}},
	}}
	if err := store.SaveWorkspaces(workspaces); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}
	reconciled, err := server.reconcileContainers(workspaces, func(podmanName string) (bool, error) {
		return false, errors.New("podman lookup failed")
	}, alwaysRunning)
	if err != nil {
		t.Fatal(err)
	}
	if len(reconciled) != 1 || len(reconciled[0].Containers) != 1 {
		t.Fatalf("lookup errors must not drop records, got %#v", reconciled)
	}
	stored, err := store.Workspaces()
	if err != nil {
		t.Fatal(err)
	}
	if len(stored) != 1 || len(stored[0].Containers) != 1 {
		t.Fatalf("state must be untouched on lookup errors, got %#v", stored)
	}
}

func TestReconcileContainersNoChangeDoesNotWrite(t *testing.T) {
	store := newTestStore(t)
	workspaces := []state.Workspace{{
		WorkspaceSlug: "proj",
		Containers:    []state.Container{{Name: "default", PodmanName: "dsh-podman-proj-default", Status: "running"}},
	}}
	if err := store.SaveWorkspaces(workspaces); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}
	reconciled, err := server.reconcileContainers(workspaces, func(podmanName string) (bool, error) {
		return true, nil
	}, alwaysRunning)
	if err != nil {
		t.Fatal(err)
	}
	if len(reconciled) != 1 || len(reconciled[0].Containers) != 1 {
		t.Fatalf("expected the container to survive, got %#v", reconciled)
	}
	stored, err := store.Workspaces()
	if err != nil {
		t.Fatal(err)
	}
	if len(stored) != 1 || stored[0].Containers[0].Status != "running" {
		t.Fatalf("state must be unchanged, got %#v", stored)
	}
}

func TestReconcileContainersRefreshesStoppedStatus(t *testing.T) {
	store := newTestStore(t)
	workspaces := []state.Workspace{{
		WorkspaceSlug: "proj",
		Containers:    []state.Container{{Name: "default", PodmanName: "dsh-podman-proj-default", Status: "running"}},
	}}
	if err := store.SaveWorkspaces(workspaces); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}
	reconciled, err := server.reconcileContainers(
		workspaces,
		func(string) (bool, error) { return true, nil },
		func(string) (bool, error) { return false, nil },
	)
	if err != nil {
		t.Fatal(err)
	}
	if reconciled[0].Containers[0].Status != "stopped" {
		t.Fatalf("expected stopped, got %q", reconciled[0].Containers[0].Status)
	}
	stored, err := store.Workspaces()
	if err != nil {
		t.Fatal(err)
	}
	if stored[0].Containers[0].Status != "stopped" || stored[0].Status != "stopped" {
		t.Fatalf("state not refreshed: %#v", stored)
	}
}

func TestContainerNameHelpers(t *testing.T) {
	for _, valid := range []string{"dev", "web", "api-2", "x"} {
		if !validContainerName(valid) {
			t.Errorf("rejected valid container name %q", valid)
		}
	}
	for _, invalid := range []string{"", "default", "Dev", "dev_1", "-dev", "a-b-c-d-e-f-g-h-i-j-k-l-m-n-o-p-q-r-s-t-u-v-w-x-y-z-0"} {
		if validContainerName(invalid) {
			t.Errorf("accepted invalid container name %q", invalid)
		}
	}
	if got := podmanContainerName("proj", ""); got != "dsh-podman-proj-default" {
		t.Fatalf("default podman name mismatch: %q", got)
	}
	if got := podmanContainerName("proj", "default"); got != "dsh-podman-proj-default" {
		t.Fatalf("default podman name mismatch: %q", got)
	}
	if got := podmanContainerName("proj", "dev"); got != "dsh-podman-proj-dev" {
		t.Fatalf("named podman name mismatch: %q", got)
	}
	if got := podNameFor("proj"); got != "dsh-podman-proj" {
		t.Fatalf("pod name mismatch: %q", got)
	}
}

func TestPodNameNeverCollidesWithContainerName(t *testing.T) {
	slugs := []string{"proj", "a-b_c.1", "default", "x"}
	logicals := []string{"", "default", "dev", "a1", "x-y"}
	for _, slug := range slugs {
		pod := podNameFor(slug)
		if !strings.HasPrefix(pod, "dsh-podman-") {
			t.Fatalf("unexpected pod name %q", pod)
		}
		for _, logical := range logicals {
			container := podmanContainerName(slug, logical)
			if container == pod {
				t.Fatalf("container name %q collides with pod name %q", container, pod)
			}
		}
	}
}

func TestContainerByLogical(t *testing.T) {
	workspace := state.Workspace{Containers: []state.Container{
		{Name: "default", PodmanName: "dsh-podman-proj-default"},
		{Name: "dev", PodmanName: "dsh-podman-proj-dev"},
	}}
	for _, name := range []string{"", "default"} {
		container, ok := containerByLogical(&workspace, name)
		if !ok || container.Name != "default" {
			t.Fatalf("name %q: expected default container, got %#v, %v", name, container, ok)
		}
	}
	container, ok := containerByLogical(&workspace, "dev")
	if !ok || container.PodmanName != "dsh-podman-proj-dev" {
		t.Fatalf("expected dev container, got %#v, %v", container, ok)
	}
	if _, ok := containerByLogical(&workspace, "nope"); ok {
		t.Fatal("unexpectedly found unknown container")
	}
}

func TestStartContainerRejectsInvalidName(t *testing.T) {
	server := &Server{Logger: silentLogger()}
	for _, name := range []string{"Dev", "dev_1", "-dev", "bad name"} {
		_, err := server.StartContainer(context.Background(), &ctl.StartContainerRequest{WorkspaceSlug: "proj", Container: name})
		if status.Code(err) != codes.InvalidArgument {
			t.Errorf("container %q: expected InvalidArgument, got %v", name, err)
		}
	}
}

func TestStartContainerAcceptsDefault(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{WorkspaceSlug: "proj"}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}
	_, err := server.StartContainer(context.Background(), &ctl.StartContainerRequest{WorkspaceSlug: "proj", Container: "default"})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("default container must pass validation, expected FailedPrecondition (podman not configured), got %v", err)
	}
}

func (f *fakePodman) ContainerExists(name string) (bool, error) { return f.exists[name], nil }

func (f *fakePodman) ContainerRunning(name string) (bool, error) { return f.running[name], nil }

func (f *fakePodman) RecreateWorkspace(pod, name, image, token string, mounts []specs.Mount, secrets []specgen.Secret, envSecrets map[string]string, env map[string]string) error {
	f.recreated = append(f.recreated, name)
	if f.recreateFails > 0 {
		f.recreateFails--
		return errors.New("recreate failed")
	}
	return f.CreateWorkspace(pod, name, image, token, mounts, secrets, envSecrets, env)
}

func (f *fakePodman) Stop(name string) error { f.running[name] = false; return nil }

func TestStartContainerRequiresPodman(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{WorkspaceSlug: "proj", ContainerName: "dsh-podman-proj-default"}}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveImages([]state.Image{{ImageID: "arch", ImageTag: "localhost/dsh-podman/arch:latest"}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}
	_, err := server.StartContainer(context.Background(), &ctl.StartContainerRequest{WorkspaceSlug: "proj", Container: "dev", ImageId: "arch"})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("expected FailedPrecondition, got %v", err)
	}
}

func TestStartContainerRemovesUntrackedContainer(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{WorkspaceSlug: "proj"}}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveImages([]state.Image{{ImageID: "arch", ImageTag: "localhost/dsh-podman/arch:latest"}}); err != nil {
		t.Fatal(err)
	}
	fake := newFakePodman()
	fake.exists["dsh-podman-proj-dev"] = true
	server := &Server{Store: store, Podman: fake, Logger: silentLogger()}
	if _, err := server.StartContainer(context.Background(), &ctl.StartContainerRequest{WorkspaceSlug: "proj", Container: "dev", ImageId: "arch"}); err != nil {
		t.Fatal(err)
	}
	if len(fake.removed) != 1 || fake.removed[0] != "dsh-podman-proj-dev" {
		t.Fatalf("expected the untracked container to be removed, got %v", fake.removed)
	}
	if len(fake.created) != 1 || fake.created[0] != "dsh-podman-proj-dev" {
		t.Fatalf("expected the container to be created, got %v", fake.created)
	}
}

func TestStartContainerCleansUpFailedCreate(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{WorkspaceSlug: "proj"}}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveImages([]state.Image{{ImageID: "arch", ImageTag: "localhost/dsh-podman/arch:latest"}}); err != nil {
		t.Fatal(err)
	}
	fake := newFakePodman()
	fake.createErr = errors.New("boom")
	server := &Server{Store: store, Podman: fake, Logger: silentLogger()}
	_, err := server.StartContainer(context.Background(), &ctl.StartContainerRequest{WorkspaceSlug: "proj", Container: "dev", ImageId: "arch"})
	if status.Code(err) != codes.Internal {
		t.Fatalf("expected Internal, got %v", err)
	}
	if len(fake.removed) == 0 || fake.removed[len(fake.removed)-1] != "dsh-podman-proj-dev" {
		t.Fatalf("expected cleanup removal after failed create, got %v", fake.removed)
	}
}

func TestRemoveContainerRemovesOrphan(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{WorkspaceSlug: "proj"}}); err != nil {
		t.Fatal(err)
	}
	fake := newFakePodman()
	fake.exists["dsh-podman-proj-dev"] = true
	server := &Server{Store: store, Podman: fake, Logger: silentLogger()}
	if _, err := server.RemoveContainer(context.Background(), &ctl.RemoveContainerRequest{WorkspaceSlug: "proj", Container: "dev"}); err != nil {
		t.Fatal(err)
	}
	if len(fake.removed) != 1 || fake.removed[0] != "dsh-podman-proj-dev" {
		t.Fatalf("expected the orphan to be removed, got %v", fake.removed)
	}
}

func TestRemoveContainerOrphanNotFound(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{WorkspaceSlug: "proj"}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Podman: newFakePodman(), Logger: silentLogger()}
	_, err := server.RemoveContainer(context.Background(), &ctl.RemoveContainerRequest{WorkspaceSlug: "proj", Container: "dev"})
	if status.Code(err) != codes.NotFound {
		t.Fatalf("expected NotFound, got %v", err)
	}
}

func TestRemoveContainerRejectsInvalidName(t *testing.T) {
	server := &Server{Logger: silentLogger()}
	for _, name := range []string{"Dev", "dev_1", "-dev", "bad name"} {
		_, err := server.RemoveContainer(context.Background(), &ctl.RemoveContainerRequest{WorkspaceSlug: "proj", Container: name})
		if status.Code(err) != codes.InvalidArgument {
			t.Errorf("container %q: expected InvalidArgument, got %v", name, err)
		}
	}
}

func TestRemoveContainerAcceptsDefault(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{WorkspaceSlug: "proj", ContainerName: "dsh-podman-proj-default", Containers: []state.Container{{Name: "default", PodmanName: "dsh-podman-proj-default"}}}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}
	_, err := server.RemoveContainer(context.Background(), &ctl.RemoveContainerRequest{WorkspaceSlug: "proj", Container: "default"})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("default container must pass validation, expected FailedPrecondition (podman not configured), got %v", err)
	}
}

func TestRemoveContainerUnknownContainer(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{WorkspaceSlug: "proj", ContainerName: "dsh-podman-proj-default"}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}
	_, err := server.RemoveContainer(context.Background(), &ctl.RemoveContainerRequest{WorkspaceSlug: "proj", Container: "dev"})
	if status.Code(err) != codes.NotFound {
		t.Fatalf("expected NotFound, got %v", err)
	}
}

func TestContainerNotFoundNamesTheContainer(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{WorkspaceSlug: "proj"}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}
	cases := []struct {
		name string
		call func() error
	}{
		{"AddContainerMount", func() error {
			_, err := server.AddContainerMount(context.Background(), &ctl.AddContainerMountRequest{WorkspaceSlug: "proj", Container: "nope", Kind: ctl.MountKind_MOUNT_KIND_TMPFS, Destination: "/tmp/x", Mode: ctl.MountMode_MOUNT_MODE_READ_WRITE})
			return err
		}},
		{"RemoveContainerMount", func() error {
			_, err := server.RemoveContainerMount(context.Background(), &ctl.RemoveContainerMountRequest{WorkspaceSlug: "proj", Container: "nope", Kind: ctl.MountKind_MOUNT_KIND_TMPFS, Destination: "/tmp/x"})
			return err
		}},
		{"AddContainerSecret", func() error {
			_, err := server.AddContainerSecret(context.Background(), &ctl.AddContainerSecretRequest{WorkspaceSlug: "proj", Container: "nope", Env: "FOO", Secret: "data"})
			return err
		}},
		{"RemoveContainerSecret", func() error {
			_, err := server.RemoveContainerSecret(context.Background(), &ctl.RemoveContainerSecretRequest{WorkspaceSlug: "proj", Container: "nope", Env: "FOO"})
			return err
		}},
		{"RemoveContainer", func() error {
			_, err := server.RemoveContainer(context.Background(), &ctl.RemoveContainerRequest{WorkspaceSlug: "proj", Container: "nope"})
			return err
		}},
		{"RecreateContainer", func() error {
			_, err := server.RecreateContainer(context.Background(), &ctl.RecreateContainerRequest{WorkspaceSlug: "proj", Container: "nope"})
			return err
		}},
	}
	for _, tc := range cases {
		err := tc.call()
		if status.Code(err) != codes.NotFound {
			t.Errorf("%s: expected NotFound, got %v", tc.name, err)
			continue
		}
		if !strings.Contains(err.Error(), `container "nope" not found in workspace "proj"`) {
			t.Errorf("%s: message = %q", tc.name, err.Error())
		}
	}
}

func TestStartContainerAcceptsShortName(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveImages([]state.Image{{ImageID: "valkey", ImageTag: "localhost/dsh-podman/valkey:latest"}}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveWorkspaces([]state.Workspace{{WorkspaceSlug: "proj"}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}
	_, err := server.StartContainer(context.Background(), &ctl.StartContainerRequest{
		WorkspaceSlug: "proj",
		Container:     "valkey-ctr",
		ImageId:       "valkey",
	})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("short name should resolve past image lookup, expected FailedPrecondition (podman not configured), got %v", err)
	}
}

func TestRemoveContainerRequiresPodman(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{WorkspaceSlug: "proj", ContainerName: "dsh-podman-proj-default", Containers: []state.Container{{Name: "dev", PodmanName: "dsh-podman-proj-dev", Status: "running"}}}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}
	_, err := server.RemoveContainer(context.Background(), &ctl.RemoveContainerRequest{WorkspaceSlug: "proj", Container: "dev"})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("expected FailedPrecondition, got %v", err)
	}
}

func TestRemoveContainerMissingWorkspace(t *testing.T) {
	server := &Server{Store: newTestStore(t), Logger: silentLogger()}
	_, err := server.RemoveContainer(context.Background(), &ctl.RemoveContainerRequest{WorkspaceSlug: "nope", Container: "dev"})
	if status.Code(err) != codes.NotFound {
		t.Fatalf("expected NotFound, got %v", err)
	}
}

func TestStartContainerRejectsReservedEnv(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{WorkspaceSlug: "proj", ContainerName: "dsh-podman-proj-default"}}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveImages([]state.Image{{ImageID: "arch", ImageTag: "localhost/dsh-podman/arch:latest"}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}
	_, err := server.StartContainer(context.Background(), &ctl.StartContainerRequest{WorkspaceSlug: "proj", Container: "dev", ImageId: "arch", Env: map[string]string{"DSH_PODMAN_X": "1"}})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("expected InvalidArgument, got %v", err)
	}
}

func TestRecreateContainerRejectsReservedEnv(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{WorkspaceSlug: "proj", Containers: []state.Container{{Name: "dev", PodmanName: "dsh-podman-proj-dev", ImageID: "arch"}}}}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveImages([]state.Image{{ImageID: "arch", ImageTag: "localhost/dsh-podman/arch:latest"}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}
	_, err := server.RecreateContainer(context.Background(), &ctl.RecreateContainerRequest{WorkspaceSlug: "proj", Container: "dev", ImageId: "arch", Env: map[string]string{"DSH_PODMAN_X": "1"}})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("expected InvalidArgument, got %v", err)
	}
}

func TestStopContainerDaemonsUnreachable(t *testing.T) {
	server := &Server{Logger: silentLogger()}
	server.stopContainerDaemons(context.Background(), state.Container{AgentSocketPath: "/nonexistent/guest.sock", AgentToken: "tok"})
}

func TestStopContainerDaemonsMissingSocketOrToken(t *testing.T) {
	server := &Server{Logger: silentLogger()}
	server.stopContainerDaemons(context.Background(), state.Container{PodmanName: "dsh-podman-proj-default"})
	server.stopContainerDaemons(context.Background(), state.Container{PodmanName: "dsh-podman-proj-default", AgentSocketPath: "/nonexistent/guest.sock"})
	server.stopContainerDaemons(context.Background(), state.Container{PodmanName: "dsh-podman-proj-default", AgentToken: "tok"})
}

func TestRecreateContainerStopsDaemons(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveImages([]state.Image{{ImageID: "arch", ImageTag: "t1"}}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveWorkspaces([]state.Workspace{{
		WorkspaceSlug: "proj",
		Containers: []state.Container{{
			Name: "default", PodmanName: "dsh-podman-proj-default", ImageID: "arch", Status: "running",
		}},
	}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}

	_, err := server.RecreateContainer(context.Background(), &ctl.RecreateContainerRequest{WorkspaceSlug: "proj", Container: "Bad", ImageId: "arch"})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("invalid container name: expected InvalidArgument, got %v", err)
	}
	_, err = server.RecreateContainer(context.Background(), &ctl.RecreateContainerRequest{WorkspaceSlug: "nope", ImageId: "arch"})
	if status.Code(err) != codes.NotFound {
		t.Fatalf("unknown workspace: expected NotFound, got %v", err)
	}
	_, err = server.RecreateContainer(context.Background(), &ctl.RecreateContainerRequest{WorkspaceSlug: "proj", ImageId: "arch"})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("nil Podman: expected FailedPrecondition, got %v", err)
	}
}
