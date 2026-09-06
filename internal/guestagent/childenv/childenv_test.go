// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package childenv

import (
	"slices"
	"strings"
	"testing"
)

func TestBuildDropsReservedVariables(t *testing.T) {
	t.Setenv("DSH_PODMAN_GUEST_TOKEN", "super-secret")
	t.Setenv("DSH_PODMAN_GUEST_SOCKET", "/run/dsh-podman/x/guest.sock")
	t.Setenv("DSH_PODMAN_PROJECTS_ROOT", "/projects")
	t.Setenv("DSH_PODMANX", "no-underscore-is-still-reserved")
	t.Setenv("PATH", "/usr/bin")

	got := Build(nil)
	for _, entry := range got {
		if strings.HasPrefix(entry, Reserved) {
			t.Errorf("reserved variable leaked: %q", entry)
		}
	}
	if !slices.Contains(got, "PATH=/usr/bin") {
		t.Errorf("ordinary variables should be inherited: %q", got)
	}
}

func TestBuildAppendsExtra(t *testing.T) {
	t.Setenv("PATH", "/usr/bin")
	got := Build(map[string]string{"B": "2", "A": "1"})
	if !slices.Contains(got, "A=1") || !slices.Contains(got, "B=2") {
		t.Fatalf("extra variables missing: %q", got)
	}
	// Extra keys are appended in a stable order.
	if slices.Index(got, "A=1") > slices.Index(got, "B=2") {
		t.Errorf("extra variables are not sorted: %q", got)
	}
}

// TestBuildDropsReservedExtra covers a caller trying to reintroduce the
// namespace through the env map it supplies.
func TestBuildDropsReservedExtra(t *testing.T) {
	got := Build(map[string]string{"DSH_PODMAN_GUEST_TOKEN": "forged", "KEEP": "1"})
	for _, entry := range got {
		if strings.HasPrefix(entry, Reserved) {
			t.Errorf("reserved variable accepted from extra: %q", entry)
		}
	}
	if !slices.Contains(got, "KEEP=1") {
		t.Errorf("ordinary extra dropped: %q", got)
	}
}
