// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"context"
	"strings"
	"testing"

	ctl "github.com/Exagone313/dsh-podman/internal/genproto/dshctl/v1"
	"github.com/Exagone313/dsh-podman/internal/orchestrator/state"
	"google.golang.org/grpc"
)

func TestToProto(t *testing.T) {
	workspace := state.Workspace{
		WorkspaceSlug: "proj", ContainerName: "dsh-workspace-proj", ImageID: "arch", Status: "running",
		AgentSocketPath: "/sock", AgentToken: "tok", CreatedAt: "now",
		Mounts: []state.Mount{{ProjectName: "a", Mode: "read_only"}, {ProjectName: "b", Mode: "read_write"}},
	}
	proto := toProto(workspace)
	if proto.WorkspaceSlug != "proj" || proto.ContainerName != "dsh-workspace-proj" || proto.AgentToken != "tok" {
		t.Fatalf("unexpected proto: %#v", proto)
	}
	if len(proto.Mounts) != 2 || proto.Mounts[0].Mode != ctl.MountMode_MOUNT_MODE_READ_ONLY || proto.Mounts[1].Mode != ctl.MountMode_MOUNT_MODE_READ_WRITE {
		t.Fatalf("mount modes not mapped: %#v", proto.Mounts)
	}
}

func TestUnaryLoggerPassesThrough(t *testing.T) {
	interceptor := UnaryLogger(silentLogger())
	called := false
	handler := func(ctx context.Context, req any) (any, error) { called = true; return "value", nil }
	result, err := interceptor(context.Background(), nil, &grpc.UnaryServerInfo{FullMethod: "/test/Method"}, handler)
	if err != nil || result != "value" || !called {
		t.Fatalf("interceptor did not pass through: %v %v %v", result, err, called)
	}
}

func (f *fakePodman) Remove(name string) error {
	f.removed = append(f.removed, name)
	delete(f.exists, name)
	delete(f.running, name)
	return nil
}

func (f *fakePodman) RemovePod(string) error { return nil }

func TestLifecycleErrorsNameTheirResource(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{WorkspaceSlug: "proj"}}); err != nil {
		t.Fatal(err)
	}
	fake := newFakePodman()
	fake.secretMissing["dsh-podman-nope"] = true
	server := &Server{Store: store, Podman: fake, SecretPrefix: "dsh-podman-", VolumePrefix: "dsh-podman-", Logger: silentLogger()}
	cases := []struct {
		name string
		call func() error
		want string
	}{
		{"RemoveVolume", func() error {
			_, err := server.RemoveVolume(context.Background(), &ctl.RemoveVolumeRequest{Name: "nope"})
			return err
		}, `volume "nope" not found`},
		{"RemoveSecret", func() error {
			_, err := server.RemoveSecret(context.Background(), &ctl.RemoveSecretRequest{Name: "nope"})
			return err
		}, `secret "nope" not found`},
		{"CreateVolumeInvalidName", func() error {
			_, err := server.CreateVolume(context.Background(), &ctl.CreateVolumeRequest{Name: "bad name"})
			return err
		}, `invalid volume name "bad name"`},
		{"CreateSecretInvalidName", func() error {
			_, err := server.CreateSecret(context.Background(), &ctl.CreateSecretRequest{Name: "bad name"})
			return err
		}, `invalid secret name "bad name"`},
		{"GetImage", func() error {
			_, err := server.GetImage(context.Background(), &ctl.GetImageRequest{ImageId: "nope"})
			return err
		}, `image "nope" not found`},
		{"ResolveImageTag", func() error {
			_, err := server.resolveImageTag("nope")
			return err
		}, `image "nope" not found`},
		{"WorkspaceBySlug", func() error {
			_, err := workspaceBySlug(store, "nope")
			return err
		}, `workspace "nope" not found`},
		{"MountKindFromProto", func() error {
			_, err := mountKindFromProto(ctl.MountKind(99))
			return err
		}, `invalid mount kind "99"`},
		{"MountModeFromProto", func() error {
			_, err := mountModeFromProto(ctl.MountMode(99))
			return err
		}, `invalid mount mode "99"`},
		{"NonProjectDestination", func() error {
			return server.nonProjectDestination("relative/path")
		}, `invalid mount destination "relative/path"`},
	}
	for _, tc := range cases {
		err := tc.call()
		if err == nil || !strings.Contains(err.Error(), tc.want) {
			t.Errorf("%s: error = %v, want containing %q", tc.name, err, tc.want)
		}
	}
}

func TestValidateEnv(t *testing.T) {
	for _, env := range []map[string]string{
		{"DSH_PODMAN_X": "1"},
		{"": "v"},
		{"a=b": "v"},
		{"a\x00b": "v"},
		{"a": "b\x00c"},
	} {
		if err := validateEnv(env); err == nil {
			t.Errorf("accepted invalid env %#v", env)
		}
	}
	if err := validateEnv(map[string]string{"FOO": "bar", "BAZ": "qux"}); err != nil {
		t.Fatalf("rejected valid env: %v", err)
	}
	if err := validateEnv(nil); err != nil {
		t.Fatalf("rejected nil env: %v", err)
	}
}

func TestEnsureAgentToken(t *testing.T) {
	server := &Server{Logger: silentLogger()}

	// A stored token is reused, so recreates keep clients (the plugin's cached
	// workspace binding) authenticated against the same credential.
	record := state.Container{AgentToken: "stored-token"}
	token, err := server.ensureAgentToken(&record)
	if err != nil {
		t.Fatal(err)
	}
	if token != "stored-token" {
		t.Fatalf("expected the stored token to be reused, got %q", token)
	}

	// A record without a token (a never-started container) gets a fresh one,
	// which is written back so the upsert persists it.
	record = state.Container{}
	token, err = server.ensureAgentToken(&record)
	if err != nil {
		t.Fatal(err)
	}
	if token == "" {
		t.Fatal("expected a minted token")
	}
	if record.AgentToken != token {
		t.Fatalf("minted token not written back: %q", record.AgentToken)
	}
}

func TestValidateEnvKey(t *testing.T) {
	for _, key := range []string{"DSH_PODMAN_X", "", "A=B", "a\x00b"} {
		if err := validateEnvKey(key); err == nil {
			t.Errorf("accepted invalid env key %q", key)
		}
	}
	if err := validateEnvKey("FOO"); err != nil {
		t.Fatalf("rejected valid env key FOO: %v", err)
	}
}

func TestSkipDependents(t *testing.T) {
	_, dependents := rebuildGraph(rebuildAllImagesFixtures())
	cases := []struct {
		failed string
		want   []string
	}{
		{failed: "mid", want: []string{"mid", "top"}},
		{failed: "top", want: []string{"top"}},
		{failed: "independent", want: []string{"independent"}},
	}
	for _, tc := range cases {
		if got := skipDependents(dependents, tc.failed); !sameStrings(got, tc.want) {
			t.Fatalf("skipDependents(%q) = %#v, want %#v", tc.failed, got, tc.want)
		}
	}
}
