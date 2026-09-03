// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package podman

import (
	"path/filepath"
	"testing"

	"github.com/opencontainers/runtime-spec/specs-go"
)

func TestGuestAgentMountsWithoutHostBinary(t *testing.T) {
	mounts := guestAgentMounts("/run/sockets/proj", "/run/dsh-podman", "proj", "", "/opt/dsh-podman/guest-agent/bin/dsh-podman-guest-agent")
	if len(mounts) != 1 {
		t.Fatalf("expected a single socket mount, got %#v", mounts)
	}
	mount := mounts[0]
	if mount.Type != "bind" || mount.Source != "/run/sockets/proj" || mount.Destination != filepath.Join("/run/dsh-podman", "proj") {
		t.Fatalf("unexpected socket mount: %#v", mount)
	}
	for _, option := range mount.Options {
		if option != "rw" && option != "bind" {
			t.Fatalf("unexpected socket mount option: %#v", mount.Options)
		}
	}
}

func TestGuestAgentMountsWithHostBinary(t *testing.T) {
	binaryDest := "/opt/dsh-podman/guest-agent/bin/dsh-podman-guest-agent"
	mounts := guestAgentMounts("/run/sockets/proj", "/run/dsh-podman", "proj", "/opt/dsh/dsh-podman-guest-agent", binaryDest)
	if len(mounts) != 2 {
		t.Fatalf("expected a binary and socket mount, got %#v", mounts)
	}
	binary := mounts[0]
	if binary.Type != "bind" || binary.Source != "/opt/dsh/dsh-podman-guest-agent" || binary.Destination != binaryDest {
		t.Fatalf("unexpected binary mount: %#v", binary)
	}
	hasRo := false
	for _, option := range binary.Options {
		if option == "ro" {
			hasRo = true
		}
	}
	if !hasRo {
		t.Fatalf("binary mount is not read-only: %#v", binary.Options)
	}
	socket := mounts[1]
	if socket.Source != "/run/sockets/proj" || socket.Destination != "/run/dsh-podman/proj" {
		t.Fatalf("unexpected socket mount: %#v", socket)
	}
}

func TestGuestAgentMountsBareBinaryName(t *testing.T) {
	binaryDest := "/opt/dsh-podman/guest-agent/bin/dsh-podman-guest-agent"
	mounts := guestAgentMounts("/run/sockets/proj", "/run/dsh-podman", "proj", "/opt/dsh/bin", binaryDest)
	if len(mounts) != 2 {
		t.Fatalf("unexpected mounts: %#v", mounts)
	}
	if mounts[0].Source != "/opt/dsh/bin" || mounts[0].Destination != binaryDest {
		t.Fatalf("unexpected binary mount: %#v", mounts[0])
	}
}

func TestGuestAgentImageVolume(t *testing.T) {
	if volume := guestAgentImageVolume("", "/opt/x"); volume != nil {
		t.Fatalf("empty image should yield no image volume, got %#v", volume)
	}
	volume := guestAgentImageVolume("img:tag", "/opt/x")
	if volume == nil {
		t.Fatal("expected an image volume")
	}
	if volume.Source != "img:tag" || volume.Destination != "/opt/x" || volume.ReadWrite {
		t.Fatalf("unexpected image volume: %#v", volume)
	}
}

func TestGuestAgentSourcesConfigured(t *testing.T) {
	if err := guestAgentSourcesConfigured("", ""); err == nil {
		t.Fatal("expected an error when no guest agent source is configured")
	}
	for _, hostBinary := range []string{"", "/opt/dsh/dsh-podman-guest-agent"} {
		for _, image := range []string{"", "localhost/dsh-podman-guest-agent:latest"} {
			if hostBinary == "" && image == "" {
				continue
			}
			if err := guestAgentSourcesConfigured(hostBinary, image); err != nil {
				t.Fatalf("unexpected error for host=%q image=%q: %v", hostBinary, image, err)
			}
		}
	}
}

func TestClassifyMounts(t *testing.T) {
	mounts := []specs.Mount{
		{Type: "bind", Source: "/host/proj", Destination: "/projects/proj", Options: []string{"ro"}},
		{Type: "tmpfs", Destination: "/dev/shm", Options: []string{"rw"}},
		{Type: "volume", Source: "dsh-podman-valkey-data", Destination: "/data", Options: []string{"rw"}},
		{Type: "volume", Source: "dsh-podman-logs", Destination: "/var/log", Options: []string{"ro"}},
	}
	oci, volumes := classifyMounts(mounts)
	if len(oci) != 2 {
		t.Fatalf("expected 2 OCI mounts, got %d: %#v", len(oci), oci)
	}
	if oci[0].Type != "bind" || oci[1].Type != "tmpfs" {
		t.Fatalf("unexpected OCI mounts: %#v", oci)
	}
	if len(volumes) != 2 {
		t.Fatalf("expected 2 named volumes, got %d: %#v", len(volumes), volumes)
	}
	if volumes[0].Name != "dsh-podman-valkey-data" || volumes[0].Dest != "/data" || len(volumes[0].Options) != 1 || volumes[0].Options[0] != "rw" {
		t.Fatalf("unexpected first named volume: %#v", volumes[0])
	}
	if volumes[1].Name != "dsh-podman-logs" || volumes[1].Dest != "/var/log" || len(volumes[1].Options) != 1 || volumes[1].Options[0] != "ro" {
		t.Fatalf("unexpected second named volume: %#v", volumes[1])
	}
}

func TestContainerEnv(t *testing.T) {
	env := containerEnv("/run/dsh-podman", "dsh-workspace-proj", "/workspaces", "tok", map[string]string{"FOO": "bar", "DSH_PODMAN_X": "should-be-skipped", "DSH_PODMAN_GUEST_TOKEN": "must-not-override"})
	if env["DSH_PODMAN_GUEST_TOKEN"] != "tok" {
		t.Fatalf("guest token must be the orchestrator value, got %q", env["DSH_PODMAN_GUEST_TOKEN"])
	}
	if env["DSH_PODMAN_GUEST_SOCKET"] != filepath.Join("/run/dsh-podman", "dsh-workspace-proj", "guest.sock") {
		t.Fatalf("unexpected guest socket: %q", env["DSH_PODMAN_GUEST_SOCKET"])
	}
	if env["DSH_PODMAN_PROJECTS_ROOT"] != "/workspaces" {
		t.Fatalf("unexpected projects root: %q", env["DSH_PODMAN_PROJECTS_ROOT"])
	}
	if env["FOO"] != "bar" {
		t.Fatalf("user env not merged: %#v", env)
	}
	if _, ok := env["DSH_PODMAN_X"]; ok {
		t.Fatalf("reserved user key must be skipped: %#v", env)
	}
	if len(env) != 4 {
		t.Fatalf("unexpected env size: %#v", env)
	}
}

func TestGuestAgentMountsSourceCopied(t *testing.T) {
	original := []specs.Mount{{Type: "bind", Source: "/proj", Destination: "/projects/proj"}}
	generated := guestAgentMounts("/run/sockets/proj", "/run/dsh-podman", "proj", "", "/opt/dsh-podman/guest-agent/bin/dsh-podman-guest-agent")
	combined := append(original, generated...)
	original[0].Source = "mutated"
	if combined[0].Source != "/proj" {
		t.Fatalf("source mounts mutated: %#v", combined)
	}
}
