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
	mounts := guestAgentMounts("/run/sockets/proj", "/run/dsh-podman", "proj", "", "/bin/dsh-podman-guest-agent")
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
	mounts := guestAgentMounts("/run/sockets/proj", "/run/dsh-podman", "proj", "/opt/dsh/dsh-podman-guest-agent", "/bin/dsh-podman-guest-agent")
	if len(mounts) != 2 {
		t.Fatalf("expected a binary and socket mount, got %#v", mounts)
	}
	binary := mounts[0]
	if binary.Type != "bind" || binary.Source != "/opt/dsh/dsh-podman-guest-agent" || binary.Destination != "/bin/dsh-podman-guest-agent" {
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
	mounts := guestAgentMounts("/run/sockets/proj", "/run/dsh-podman", "proj", "/opt/dsh/bin", "dsh-podman-guest-agent")
	if len(mounts) != 2 {
		t.Fatalf("unexpected mounts: %#v", mounts)
	}
	if mounts[0].Source != "/opt/dsh/bin" || mounts[0].Destination != "dsh-podman-guest-agent" {
		t.Fatalf("unexpected binary mount: %#v", mounts[0])
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

func TestGuestAgentMountsSourceCopied(t *testing.T) {
	original := []specs.Mount{{Type: "bind", Source: "/proj", Destination: "/projects/proj"}}
	generated := guestAgentMounts("/run/sockets/proj", "/run/dsh-podman", "proj", "", "dsh-podman-guest-agent")
	combined := append(original, generated...)
	original[0].Source = "mutated"
	if combined[0].Source != "/proj" {
		t.Fatalf("source mounts mutated: %#v", combined)
	}
}
