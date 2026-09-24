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
	"go.podman.io/podman/v6/pkg/specgen"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func (f *fakePodman) SecretExists(name string) (bool, error) {
	return !f.secretMissing[name], nil
}

func (f *fakePodman) SecretCreate(string, string) error { return nil }

func (f *fakePodman) SecretList() ([]string, error) { return nil, nil }

func (f *fakePodman) SecretRemove(string) error { return nil }

func TestRemoveSecretInUse(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{
		WorkspaceSlug: "ws",
		Containers: []state.Container{{
			Name:   "default",
			Mounts: []state.Mount{{Kind: "secret", Secret: "dbpass", Destination: "/run/secrets/db"}},
		}},
	}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}
	_, err := server.RemoveSecret(context.Background(), &ctl.RemoveSecretRequest{Name: "dbpass"})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("mounted secret: expected FailedPrecondition, got %v", err)
	}
	if !strings.Contains(err.Error(), `secret "dbpass" is mounted in workspace "ws" container "default"`) {
		t.Fatalf("unexpected error message: %v", err)
	}
}

func TestRemoveSecretInUseAsEnvironment(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{
		WorkspaceSlug: "ws",
		Containers: []state.Container{{
			Name:      "default",
			SecretEnv: map[string]string{"DB_PASS": "dbpass"},
		}},
	}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}
	_, err := server.RemoveSecret(context.Background(), &ctl.RemoveSecretRequest{Name: "dbpass"})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("env-attached secret: expected FailedPrecondition, got %v", err)
	}
	if !strings.Contains(err.Error(), `secret "dbpass" is attached to the environment of workspace "ws" container "default"`) {
		t.Fatalf("unexpected error message: %v", err)
	}
}

// TestRemoveSecretReconcilesDeadContainers pins that a container deleted
// outside dsh-podman no longer keeps its secret in use: the dead record is
// reconciled away before the usage check.
func TestRemoveSecretReconcilesDeadContainers(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{
		WorkspaceSlug: "ws",
		Containers: []state.Container{{
			Name:       "default",
			PodmanName: "dsh-podman-ws-default",
			SecretEnv:  map[string]string{"DB_PASS": "dbpass"},
		}},
	}}); err != nil {
		t.Fatal(err)
	}
	fake := newFakePodman()
	server := &Server{Store: store, Podman: fake, SecretPrefix: "dsh-podman-", Logger: silentLogger()}
	if _, err := server.RemoveSecret(context.Background(), &ctl.RemoveSecretRequest{Name: "dbpass"}); err != nil {
		t.Fatalf("a dead container must not keep the secret in use: %v", err)
	}
	stored, err := store.Workspaces()
	if err != nil {
		t.Fatal(err)
	}
	if len(stored) != 0 {
		t.Fatalf("expected the dead record to be reconciled away, got %#v", stored)
	}
}

func TestRemoveSecretNotInUseStillRequiresPodman(t *testing.T) {
	server := &Server{Store: newTestStore(t), Logger: silentLogger()}
	_, err := server.RemoveSecret(context.Background(), &ctl.RemoveSecretRequest{Name: "dbpass"})
	if status.Code(err) != codes.FailedPrecondition || !strings.Contains(err.Error(), "podman is not configured") {
		t.Fatalf("expected podman precondition, got %v", err)
	}
}

func TestValidateSecretEnv(t *testing.T) {
	for _, secretEnv := range []map[string]string{
		{"DSH_PODMAN_X": "sec1"},
		{"": "v"},
		{"a=b": "v"},
		{"a\x00b": "v"},
		{"FOO": "bad name"},
		{"FOO": "sec with spaces"},
	} {
		if err := validateSecretEnv(secretEnv); err == nil {
			t.Errorf("accepted invalid secret env %#v", secretEnv)
		}
	}
	if err := validateSecretEnv(map[string]string{"VALKEY_PASSWORD": "valkey-tls", "TOKEN": "token"}); err != nil {
		t.Fatalf("rejected valid secret env: %v", err)
	}
	if err := validateSecretEnv(nil); err != nil {
		t.Fatalf("rejected nil secret env: %v", err)
	}
}

func TestStartContainerRejectsReservedSecretEnv(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{WorkspaceSlug: "proj", ContainerName: "dsh-podman-proj-default"}}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveImages([]state.Image{{ImageID: "arch", ImageTag: "localhost/dsh-podman/arch:latest"}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}
	_, err := server.StartContainer(context.Background(), &ctl.StartContainerRequest{WorkspaceSlug: "proj", Container: "dev", ImageId: "arch", SecretEnv: map[string]string{"DSH_PODMAN_X": "sec"}})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("expected InvalidArgument, got %v", err)
	}
}

func TestStartContainerRejectsInvalidSecretName(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{WorkspaceSlug: "proj", ContainerName: "dsh-podman-proj-default"}}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveImages([]state.Image{{ImageID: "arch", ImageTag: "localhost/dsh-podman/arch:latest"}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}
	_, err := server.StartContainer(context.Background(), &ctl.StartContainerRequest{WorkspaceSlug: "proj", Container: "dev", ImageId: "arch", SecretEnv: map[string]string{"TOKEN": "bad name"}})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("expected InvalidArgument, got %v", err)
	}
}

func TestCreateWorkspaceRejectsReservedSecretEnv(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveImages([]state.Image{{ImageID: "devimg", ImageTag: "t1"}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}
	_, err := server.CreateWorkspace(context.Background(), &ctl.CreateWorkspaceRequest{WorkspaceSlug: testWorkspaceSlug, ImageId: "devimg", SecretEnv: map[string]string{"DSH_PODMAN_X": "sec"}})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("expected InvalidArgument, got %v", err)
	}
}

func TestCreateWorkspaceRejectsInvalidSecretName(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveImages([]state.Image{{ImageID: "devimg", ImageTag: "t1"}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}
	_, err := server.CreateWorkspace(context.Background(), &ctl.CreateWorkspaceRequest{WorkspaceSlug: testWorkspaceSlug, ImageId: "devimg", SecretEnv: map[string]string{"TOKEN": "bad name"}})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("expected InvalidArgument, got %v", err)
	}
}

// TestAddContainerMountSecret covers secret mounts, which carry a destination
// and a secret name but no mount mode.
func TestAddContainerMountSecret(t *testing.T) {
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
	server := &Server{Store: store, ProjectsRoot: root, VolumePrefix: "dsh-podman-", SecretPrefix: "dsh-podman-", Logger: silentLogger()}

	// An unspecified mode is accepted: secret mounts have no mode. Reaching
	// FailedPrecondition means validation passed and podman was missing.
	_, err := server.AddContainerMount(context.Background(), &ctl.AddContainerMountRequest{WorkspaceSlug: "proj", Container: "dev", Kind: ctl.MountKind_MOUNT_KIND_SECRET, Secret: "tls", Destination: "/run/secrets/tls"})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("valid secret add: expected FailedPrecondition, got %v", err)
	}
	_, err = server.AddContainerMount(context.Background(), &ctl.AddContainerMountRequest{WorkspaceSlug: "proj", Container: "dev", Kind: ctl.MountKind_MOUNT_KIND_SECRET, Secret: "bad/name", Destination: "/run/secrets/tls"})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("invalid secret name: expected InvalidArgument, got %v", err)
	}
	_, err = server.AddContainerMount(context.Background(), &ctl.AddContainerMountRequest{WorkspaceSlug: "proj", Container: "dev", Kind: ctl.MountKind_MOUNT_KIND_SECRET, Secret: "tls"})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("missing destination: expected InvalidArgument, got %v", err)
	}
	_, err = server.AddContainerMount(context.Background(), &ctl.AddContainerMountRequest{WorkspaceSlug: "proj", Container: "dev", Kind: ctl.MountKind_MOUNT_KIND_SECRET, Secret: "tls", Destination: filepath.Join(root, "x")})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("secret under projects root: expected InvalidArgument, got %v", err)
	}
}

func TestAddContainerMountDuplicateSecret(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{
		WorkspaceSlug: "proj",
		Containers: []state.Container{{
			Name: "dev", PodmanName: "dsh-podman-proj-dev", ImageID: "arch", Status: "running",
			Mounts: []state.Mount{{Kind: "secret", Secret: "tls", Destination: "/run/secrets/tls"}},
		}},
	}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, ProjectsRoot: tempRoot(t), SecretPrefix: "dsh-podman-", Logger: silentLogger()}
	_, err := server.AddContainerMount(context.Background(), &ctl.AddContainerMountRequest{WorkspaceSlug: "proj", Container: "dev", Kind: ctl.MountKind_MOUNT_KIND_SECRET, Secret: "other", Destination: "/run/secrets/tls"})
	if status.Code(err) != codes.AlreadyExists {
		t.Fatalf("duplicate secret destination: expected AlreadyExists, got %v", err)
	}
}

// TestRemoveContainerMountSecret covers removing a secret mount, which was
// previously impossible: a secret mount could be created but never detached.
func TestRemoveContainerMountSecret(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{
		WorkspaceSlug: "proj",
		Containers: []state.Container{{
			Name: "dev", PodmanName: "dsh-podman-proj-dev", ImageID: "arch", Status: "running",
			Mounts: []state.Mount{{Kind: "secret", Secret: "tls", Destination: "/run/secrets/tls"}},
		}},
	}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, ProjectsRoot: tempRoot(t), SecretPrefix: "dsh-podman-", Logger: silentLogger()}

	_, err := server.RemoveContainerMount(context.Background(), &ctl.RemoveContainerMountRequest{WorkspaceSlug: "proj", Container: "dev", Kind: ctl.MountKind_MOUNT_KIND_SECRET, Destination: "/run/secrets/other"})
	if status.Code(err) != codes.NotFound {
		t.Fatalf("missing secret mount: expected NotFound, got %v", err)
	}
	_, err = server.RemoveContainerMount(context.Background(), &ctl.RemoveContainerMountRequest{WorkspaceSlug: "proj", Container: "dev", Kind: ctl.MountKind_MOUNT_KIND_SECRET, Destination: "/run/secrets/tls", Secret: "wrong"})
	if status.Code(err) != codes.NotFound {
		t.Fatalf("mismatched secret name: expected NotFound, got %v", err)
	}
	_, err = server.RemoveContainerMount(context.Background(), &ctl.RemoveContainerMountRequest{WorkspaceSlug: "proj", Container: "dev", Kind: ctl.MountKind_MOUNT_KIND_SECRET, Destination: "/run/secrets/tls"})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("matching secret removal: expected FailedPrecondition, got %v", err)
	}
	_, err = server.RemoveContainerMount(context.Background(), &ctl.RemoveContainerMountRequest{WorkspaceSlug: "proj", Container: "dev", Kind: ctl.MountKind_MOUNT_KIND_SECRET, Destination: "/run/secrets/tls", Secret: "tls"})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("matching secret removal by name: expected FailedPrecondition, got %v", err)
	}
	// A secret name that identifies exactly one mount is enough on its own.
	_, err = server.RemoveContainerMount(context.Background(), &ctl.RemoveContainerMountRequest{WorkspaceSlug: "proj", Container: "dev", Kind: ctl.MountKind_MOUNT_KIND_SECRET, Secret: "tls"})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("secret removal by name alone: expected FailedPrecondition, got %v", err)
	}
}

// TestRemoveContainerMountSecretAmbiguous covers a secret mounted at two
// destinations: the name alone is rejected, naming the destinations to pass.
func TestRemoveContainerMountSecretAmbiguous(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{
		WorkspaceSlug: "proj",
		Containers: []state.Container{{
			Name: "dev", PodmanName: "dsh-podman-proj-dev", ImageID: "arch", Status: "running",
			Mounts: []state.Mount{
				{Kind: "secret", Secret: "tls", Destination: "/run/secrets/a"},
				{Kind: "secret", Secret: "tls", Destination: "/run/secrets/b"},
			},
		}},
	}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, ProjectsRoot: tempRoot(t), SecretPrefix: "dsh-podman-", Logger: silentLogger()}

	_, err := server.RemoveContainerMount(context.Background(), &ctl.RemoveContainerMountRequest{WorkspaceSlug: "proj", Container: "dev", Kind: ctl.MountKind_MOUNT_KIND_SECRET, Secret: "tls"})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("ambiguous secret: expected InvalidArgument, got %v", err)
	}
	if got := status.Convert(err).Message(); got != `ambiguous mount: secret "tls" matches "/run/secrets/a", "/run/secrets/b"; pass destination` {
		t.Fatalf("ambiguous message: %q", got)
	}
	// A wrong destination reports the mounts that do exist.
	_, err = server.RemoveContainerMount(context.Background(), &ctl.RemoveContainerMountRequest{WorkspaceSlug: "proj", Container: "dev", Kind: ctl.MountKind_MOUNT_KIND_SECRET, Secret: "tls", Destination: "/run/secrets/wrong"})
	if status.Code(err) != codes.NotFound {
		t.Fatalf("wrong secret destination: expected NotFound, got %v", err)
	}
	if got := status.Convert(err).Message(); got != `mount not found: secret "tls" at "/run/secrets/wrong"; the container mounts secret "tls" at "/run/secrets/a", secret "tls" at "/run/secrets/b"` {
		t.Fatalf("secret not-found message: %q", got)
	}
	// The destination still selects one of them.
	_, err = server.RemoveContainerMount(context.Background(), &ctl.RemoveContainerMountRequest{WorkspaceSlug: "proj", Container: "dev", Kind: ctl.MountKind_MOUNT_KIND_SECRET, Secret: "tls", Destination: "/run/secrets/b"})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("secret by destination: expected FailedPrecondition, got %v", err)
	}
}

func TestPodmanSecrets(t *testing.T) {
	root := tempRoot(t)
	server := &Server{ProjectsRoot: root, SecretPrefix: "dsh-podman-", Logger: silentLogger()}

	secrets, err := server.podmanSecrets([]state.Mount{{Kind: "secret", Secret: "valkey-tls", Destination: "/run/secrets/tls"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(secrets) != 1 || secrets[0] != (specgen.Secret{Source: "dsh-podman-valkey-tls", Target: "/run/secrets/tls"}) {
		t.Fatalf("unexpected secret: %#v", secrets)
	}

	for _, mount := range []state.Mount{
		{Kind: "secret", Secret: "data", Destination: root},
		{Kind: "secret", Secret: "data", Destination: filepath.Join(root, "x")},
	} {
		if _, err := server.podmanSecrets([]state.Mount{mount}); status.Code(err) != codes.InvalidArgument {
			t.Errorf("mount %#v under projects root: expected InvalidArgument, got %v", mount, err)
		}
	}
	for _, name := range []string{"", "-bad", "a/b", "a b", strings.Repeat("a", 65)} {
		if _, err := server.podmanSecrets([]state.Mount{{Kind: "secret", Secret: name, Destination: "/run/secrets/x"}}); status.Code(err) != codes.InvalidArgument {
			t.Errorf("invalid secret name %q: expected InvalidArgument, got %v", name, err)
		}
	}
	if _, err := server.podmanSecrets([]state.Mount{{Kind: "secret", Secret: "data"}}); status.Code(err) != codes.InvalidArgument {
		t.Fatalf("missing destination: expected InvalidArgument, got %v", err)
	}
	if _, err := server.podmanSecrets([]state.Mount{{Kind: "bogus", Secret: "data", Destination: "/x"}}); err != nil {
		t.Fatalf("non-secret mounts should be skipped, got %v", err)
	}
}

func TestContainerEnvSecrets(t *testing.T) {
	server := &Server{SecretPrefix: "dsh-podman-"}
	got := server.containerEnvSecrets(map[string]string{"VALKEY_TOKEN": "valkey-token"})
	if len(got) != 1 || got["VALKEY_TOKEN"] != "dsh-podman-valkey-token" {
		t.Fatalf("unexpected env secrets: %#v", got)
	}
	if got := server.containerEnvSecrets(nil); got != nil {
		t.Fatalf("expected nil for empty input, got %#v", got)
	}
}

func TestRandomSecret(t *testing.T) {
	value, err := randomSecret(0, "")
	if err != nil {
		t.Fatal(err)
	}
	if len(value) != 32 {
		t.Fatalf("expected 32 chars, got %d", len(value))
	}
	for _, c := range value {
		if !strings.ContainsRune(secretAlphabets["alphanumeric"], c) {
			t.Fatalf("alphanumeric charset violated: %q", c)
		}
	}
	value, err = randomSecret(16, "hex")
	if err != nil {
		t.Fatal(err)
	}
	if len(value) != 16 {
		t.Fatalf("expected 16 chars, got %d", len(value))
	}
	for _, c := range value {
		if !strings.ContainsRune(secretAlphabets["hex"], c) {
			t.Fatalf("hex charset violated: %q", c)
		}
	}
	value, err = randomSecret(20, "base64url")
	if err != nil {
		t.Fatal(err)
	}
	if len(value) != 20 {
		t.Fatalf("expected 20 chars, got %d", len(value))
	}
	for _, c := range value {
		if !strings.ContainsRune(secretAlphabets["base64url"], c) {
			t.Fatalf("base64url charset violated: %q", c)
		}
	}
	if value, err := randomSecret(2000, ""); err == nil {
		t.Fatalf("expected error for length 2000, got %q", value)
	}
	if value, err := randomSecret(0, "bogus"); err == nil {
		t.Fatalf("expected error for bad charset, got %q", value)
	}
}

func TestSecretRPCsRequirePodman(t *testing.T) {
	server := &Server{Store: newTestStore(t), Logger: silentLogger()}
	if _, err := server.ListSecrets(context.Background(), &ctl.ListSecretsRequest{}); status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("ListSecrets: expected FailedPrecondition, got %v", err)
	}
	if _, err := server.CreateSecret(context.Background(), &ctl.CreateSecretRequest{Name: "data"}); status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("CreateSecret: expected FailedPrecondition, got %v", err)
	}
	if _, err := server.WriteSecretValue(context.Background(), &ctl.WriteSecretValueRequest{Name: "data", Value: "v"}); status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("WriteSecretValue: expected FailedPrecondition, got %v", err)
	}
	if _, err := server.RemoveSecret(context.Background(), &ctl.RemoveSecretRequest{Name: "data"}); status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("RemoveSecret: expected FailedPrecondition, got %v", err)
	}
}

func TestCreateSecretRejectsInvalidName(t *testing.T) {
	server := &Server{Logger: silentLogger()}
	for _, name := range []string{"", "-bad", "a/b", "a b", strings.Repeat("a", 65)} {
		if _, err := server.CreateSecret(context.Background(), &ctl.CreateSecretRequest{Name: name}); status.Code(err) != codes.InvalidArgument {
			t.Errorf("name %q: expected InvalidArgument, got %v", name, err)
		}
	}
	for _, name := range []string{"data", "a_b.c-1", "x1", "UPPER", strings.Repeat("a", 64)} {
		if _, err := server.CreateSecret(context.Background(), &ctl.CreateSecretRequest{Name: name}); status.Code(err) != codes.FailedPrecondition {
			t.Errorf("valid name %q: expected FailedPrecondition (nil Podman), got %v", name, err)
		}
	}
	for _, charset := range []string{"bogus", "UPPER"} {
		if _, err := server.CreateSecret(context.Background(), &ctl.CreateSecretRequest{Name: "data", Charset: charset}); status.Code(err) != codes.InvalidArgument {
			t.Errorf("charset %q: expected InvalidArgument, got %v", charset, err)
		}
	}
	if _, err := server.CreateSecret(context.Background(), &ctl.CreateSecretRequest{Name: "data", Length: 2000}); status.Code(err) != codes.InvalidArgument {
		t.Fatalf("length 2000: expected InvalidArgument, got %v", err)
	}
}

func TestAddContainerSecretRejectsReservedEnv(t *testing.T) {
	root := tempRoot(t)
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{
		WorkspaceSlug: "proj",
		Containers: []state.Container{
			{Name: "default", PodmanName: "dsh-podman-proj-default", ImageID: "arch", Status: "running"},
			{Name: "dev", PodmanName: "dsh-podman-proj-dev", ImageID: "arch", Status: "running", SecretEnv: map[string]string{"FOO": "existing"}},
		},
	}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, ProjectsRoot: root, SecretPrefix: "dsh-podman-", Logger: silentLogger()}

	_, err := server.AddContainerSecret(context.Background(), &ctl.AddContainerSecretRequest{WorkspaceSlug: "proj", Container: "dev", Env: "DSH_PODMAN_X", Secret: "data"})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("reserved env: expected InvalidArgument, got %v", err)
	}
	_, err = server.AddContainerSecret(context.Background(), &ctl.AddContainerSecretRequest{WorkspaceSlug: "proj", Container: "nope", Env: "FOO", Secret: "data"})
	if status.Code(err) != codes.NotFound {
		t.Fatalf("unknown container: expected NotFound, got %v", err)
	}
	_, err = server.AddContainerSecret(context.Background(), &ctl.AddContainerSecretRequest{WorkspaceSlug: "nope", Container: "dev", Env: "FOO", Secret: "data"})
	if status.Code(err) != codes.NotFound {
		t.Fatalf("unknown workspace: expected NotFound, got %v", err)
	}
	_, err = server.AddContainerSecret(context.Background(), &ctl.AddContainerSecretRequest{WorkspaceSlug: "proj", Container: "dev", Env: "FOO", Secret: "data"})
	if status.Code(err) != codes.AlreadyExists {
		t.Fatalf("duplicate env: expected AlreadyExists, got %v", err)
	}
	_, err = server.AddContainerSecret(context.Background(), &ctl.AddContainerSecretRequest{WorkspaceSlug: "proj", Container: "dev", Env: "BAR", Secret: "data"})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("valid add: expected FailedPrecondition, got %v", err)
	}
	_, err = server.AddContainerSecret(context.Background(), &ctl.AddContainerSecretRequest{WorkspaceSlug: "proj", Container: "dev", Env: "BAR", Secret: "-bad"})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("invalid secret name: expected InvalidArgument, got %v", err)
	}
}

func TestAddContainerSecretRejectsUnknownSecret(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{
		WorkspaceSlug: "proj",
		Containers: []state.Container{
			{Name: "default", PodmanName: "dsh-podman-proj-default", ImageID: "arch", Status: "running", SecretEnv: map[string]string{"FOO": "known"}},
		},
	}}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveImages([]state.Image{{ImageID: "arch", ImageTag: "localhost/dsh-podman/arch:latest"}}); err != nil {
		t.Fatal(err)
	}
	fake := newFakePodman()
	fake.secretMissing["dsh-podman-nope"] = true
	server := &Server{Store: store, Podman: fake, SecretPrefix: "dsh-podman-", Logger: silentLogger()}
	_, err := server.AddContainerSecret(context.Background(), &ctl.AddContainerSecretRequest{WorkspaceSlug: "proj", Container: "default", Env: "BAR", Secret: "nope"})
	if status.Code(err) != codes.NotFound {
		t.Fatalf("expected NotFound, got %v", err)
	}
	if len(fake.recreated) != 0 {
		t.Fatalf("a rejected secret must not recreate the container: %v", fake.recreated)
	}
	stored, err := store.Workspaces()
	if err != nil {
		t.Fatal(err)
	}
	if got := stored[0].Containers[0].SecretEnv; len(got) != 1 || got["FOO"] != "known" {
		t.Fatalf("existing bindings changed: %#v", got)
	}
}

func TestRemoveContainerSecret(t *testing.T) {
	root := tempRoot(t)
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{
		WorkspaceSlug: "proj",
		Containers: []state.Container{
			{Name: "default", PodmanName: "dsh-podman-proj-default", ImageID: "arch", Status: "running"},
			{Name: "dev", PodmanName: "dsh-podman-proj-dev", ImageID: "arch", Status: "running", SecretEnv: map[string]string{"FOO": "existing"}},
		},
	}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, ProjectsRoot: root, SecretPrefix: "dsh-podman-", Logger: silentLogger()}

	_, err := server.RemoveContainerSecret(context.Background(), &ctl.RemoveContainerSecretRequest{WorkspaceSlug: "proj", Container: "dev", Env: "DSH_PODMAN_X"})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("reserved env: expected InvalidArgument, got %v", err)
	}
	_, err = server.RemoveContainerSecret(context.Background(), &ctl.RemoveContainerSecretRequest{WorkspaceSlug: "proj", Container: "dev", Env: "MISSING"})
	if status.Code(err) != codes.NotFound {
		t.Fatalf("unknown env: expected NotFound, got %v", err)
	}
	_, err = server.RemoveContainerSecret(context.Background(), &ctl.RemoveContainerSecretRequest{WorkspaceSlug: "proj", Container: "nope", Env: "FOO"})
	if status.Code(err) != codes.NotFound {
		t.Fatalf("unknown container: expected NotFound, got %v", err)
	}
	_, err = server.RemoveContainerSecret(context.Background(), &ctl.RemoveContainerSecretRequest{WorkspaceSlug: "proj", Container: "dev", Env: "FOO"})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("valid removal: expected FailedPrecondition, got %v", err)
	}
}

func TestRemoveContainerSecretMissingBindingMessage(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{
		WorkspaceSlug: "proj",
		Containers: []state.Container{
			{Name: "default", PodmanName: "dsh-podman-proj-default", ImageID: "arch", Status: "running"},
		},
	}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}
	_, err := server.RemoveContainerSecret(context.Background(), &ctl.RemoveContainerSecretRequest{WorkspaceSlug: "proj", Container: "default", Env: "PROBE_ENV"})
	if status.Code(err) != codes.NotFound {
		t.Fatalf("expected NotFound, got %v", err)
	}
	if !strings.Contains(err.Error(), "not bound to any secret") {
		t.Fatalf("misleading message: %v", err)
	}
}

func TestSecretKindMapping(t *testing.T) {
	if kind, err := mountKindFromProto(ctl.MountKind_MOUNT_KIND_SECRET); err != nil || kind != "secret" {
		t.Fatalf("secret kind: got %q %v", kind, err)
	}
	if kind := mountKindToProto("secret"); kind != ctl.MountKind_MOUNT_KIND_SECRET {
		t.Fatalf("secret kind projection: got %v", kind)
	}
	m, err := mountFromProto(&ctl.ProjectMount{Kind: ctl.MountKind_MOUNT_KIND_SECRET, Secret: "valkey-tls", Destination: "/run/secrets/tls"})
	if err != nil || m.Kind != "secret" || m.Secret != "valkey-tls" || m.Destination != "/run/secrets/tls" {
		t.Fatalf("secret mount not mapped: %#v %v", m, err)
	}
}

func TestContainerProtoProjectsSecretEnvAndMount(t *testing.T) {
	ws := state.Workspace{
		WorkspaceSlug: "proj",
		Containers: []state.Container{{
			Name:      "dev",
			SecretEnv: map[string]string{"VALKEY_TOKEN": "valkey-token"},
			Mounts:    []state.Mount{{Kind: "secret", Secret: "valkey-tls", Destination: "/run/secrets/tls"}},
		}},
	}
	row := containerProto(ws, ws.Containers[0])
	if len(row.SecretEnv) != 1 || row.SecretEnv["VALKEY_TOKEN"] != "valkey-token" {
		t.Fatalf("secret env not projected: %#v", row.SecretEnv)
	}
	if len(row.Mounts) != 1 || row.Mounts[0].Kind != ctl.MountKind_MOUNT_KIND_SECRET || row.Mounts[0].Secret != "valkey-tls" || row.Mounts[0].Destination != "/run/secrets/tls" {
		t.Fatalf("secret mount not projected: %#v", row.Mounts)
	}
}

func TestPodmanMountsSkipsSecretKinds(t *testing.T) {
	root := tempRoot(t)
	if err := os.MkdirAll(filepath.Join(root, "team"), 0755); err != nil {
		t.Fatal(err)
	}
	server := &Server{ProjectsRoot: root, SecretPrefix: "dsh-podman-", Logger: silentLogger()}
	mounts, err := server.podmanMounts([]state.Mount{
		{ProjectName: "team", Mode: "read_only"},
		{Kind: "secret", Secret: "data", Destination: "/run/secrets/x"},
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(mounts) != 1 || mounts[0].Type != "bind" || mounts[0].Source != filepath.Join(root, "team") {
		t.Fatalf("secret mount leaked into OCI mounts: %#v", mounts)
	}
}

// TestRecreateContainerReplacesSecretEnv is the regression test for a
// recreate request carrying secret_env: the proto field must reach the stored
// record and the prefixed env secrets handed to podman, instead of being
// silently dropped by the loader.
func TestRecreateContainerReplacesSecretEnv(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveImages([]state.Image{{ImageID: "arch", ImageTag: "localhost/dsh-podman/arch:latest"}}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveWorkspaces([]state.Workspace{{
		WorkspaceSlug: "proj",
		Containers: []state.Container{{
			Name: "default", PodmanName: "dsh-podman-proj-default", ImageID: "arch", Status: "running",
			SecretEnv: map[string]string{"OLD": "old"},
		}},
	}}); err != nil {
		t.Fatal(err)
	}
	fake := newFakePodman()
	server := &Server{Store: store, Podman: fake, SecretPrefix: "dsh-podman-", Logger: silentLogger()}

	if _, err := server.RecreateContainer(context.Background(), &ctl.RecreateContainerRequest{
		WorkspaceSlug: "proj",
		Container:     "default",
		ImageId:       "arch",
		SecretEnv:     map[string]string{"TOKEN": "known"},
	}); err != nil {
		t.Fatalf("recreate with secret env: %v", err)
	}
	stored, err := store.Workspaces()
	if err != nil {
		t.Fatal(err)
	}
	got := stored[0].Containers[0].SecretEnv
	if len(got) != 1 || got["TOKEN"] != "known" {
		t.Fatalf("secret env not replaced: %#v", got)
	}
	if len(fake.envSecrets) != 1 || fake.envSecrets[0]["TOKEN"] != "dsh-podman-known" {
		t.Fatalf("prefixed env secrets not passed to podman: %#v", fake.envSecrets)
	}
}

// TestRecreateContainerKeepsSecretEnvWhenOmitted pins that an omitted
// secret_env keeps the container's existing bindings.
func TestRecreateContainerKeepsSecretEnvWhenOmitted(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveImages([]state.Image{{ImageID: "arch", ImageTag: "localhost/dsh-podman/arch:latest"}}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveWorkspaces([]state.Workspace{{
		WorkspaceSlug: "proj",
		Containers: []state.Container{{
			Name: "default", PodmanName: "dsh-podman-proj-default", ImageID: "arch", Status: "running",
			SecretEnv: map[string]string{"KEEP": "kept"},
		}},
	}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Podman: newFakePodman(), SecretPrefix: "dsh-podman-", Logger: silentLogger()}

	if _, err := server.RecreateContainer(context.Background(), &ctl.RecreateContainerRequest{
		WorkspaceSlug: "proj",
		Container:     "default",
		ImageId:       "arch",
	}); err != nil {
		t.Fatalf("recreate without secret env: %v", err)
	}
	stored, err := store.Workspaces()
	if err != nil {
		t.Fatal(err)
	}
	got := stored[0].Containers[0].SecretEnv
	if len(got) != 1 || got["KEEP"] != "kept" {
		t.Fatalf("omitted secret env must be kept: %#v", got)
	}
}
