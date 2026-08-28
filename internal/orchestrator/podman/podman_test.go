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
	mounts := guestAgentMounts("/run/sockets/proj", "/run/dsh-sockets", "proj", "", "/bin/dsh-podman-guest-agent")
	if len(mounts) != 1 {
		t.Fatalf("expected a single socket mount, got %#v", mounts)
	}
	mount := mounts[0]
	if mount.Type != "bind" || mount.Source != "/run/sockets/proj" || mount.Destination != filepath.Join("/run/dsh-sockets", "proj") {
		t.Fatalf("unexpected socket mount: %#v", mount)
	}
	for _, option := range mount.Options {
		if option != "rw" && option != "bind" {
			t.Fatalf("unexpected socket mount option: %#v", mount.Options)
		}
	}
}

func TestGuestAgentMountsWithHostBinary(t *testing.T) {
	mounts := guestAgentMounts("/run/sockets/proj", "/run/dsh-sockets", "proj", "/opt/dsh/dsh-podman-guest-agent", "/bin/dsh-podman-guest-agent")
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
	if socket.Source != "/run/sockets/proj" || socket.Destination != "/run/dsh-sockets/proj" {
		t.Fatalf("unexpected socket mount: %#v", socket)
	}
}

func TestGuestAgentMountsBareBinaryName(t *testing.T) {
	mounts := guestAgentMounts("/run/sockets/proj", "/run/dsh-sockets", "proj", "/opt/dsh/bin", "dsh-podman-guest-agent")
	if len(mounts) != 2 {
		t.Fatalf("unexpected mounts: %#v", mounts)
	}
	if mounts[0].Source != "/opt/dsh/bin" || mounts[0].Destination != "dsh-podman-guest-agent" {
		t.Fatalf("unexpected binary mount: %#v", mounts[0])
	}
}

func TestGuestAgentMountsSourceCopied(t *testing.T) {
	original := []specs.Mount{{Type: "bind", Source: "/proj", Destination: "/projects/proj"}}
	generated := guestAgentMounts("/run/sockets/proj", "/run/dsh-sockets", "proj", "", "dsh-podman-guest-agent")
	combined := append(original, generated...)
	original[0].Source = "mutated"
	if combined[0].Source != "/proj" {
		t.Fatalf("source mounts mutated: %#v", combined)
	}
}
