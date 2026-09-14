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

	got := Build(NewPaths(), nil)
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
	got := Build(NewPaths(), map[string]string{"B": "2", "A": "1"})
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
	got := Build(NewPaths(), map[string]string{"DSH_PODMAN_GUEST_TOKEN": "forged", "KEEP": "1"})
	for _, entry := range got {
		if strings.HasPrefix(entry, Reserved) {
			t.Errorf("reserved variable accepted from extra: %q", entry)
		}
	}
	if !slices.Contains(got, "KEEP=1") {
		t.Errorf("ordinary extra dropped: %q", got)
	}
}

// TestBuildAppliesUnset covers the harness's `undefined` environment
// tombstones: an ambient variable the caller named is removed from the child.
func TestBuildAppliesUnset(t *testing.T) {
	t.Setenv("PATH", "/usr/bin")
	t.Setenv("DROP_ME", "1")
	got := Build(NewPaths(), nil, "DROP_ME")
	if slices.Contains(got, "DROP_ME=1") {
		t.Errorf("unset variable survived: %q", got)
	}
	if !slices.Contains(got, "PATH=/usr/bin") {
		t.Errorf("unrelated variable dropped: %q", got)
	}
}

// TestBuildExtraWinsOverUnset covers a key named in both the tombstone list
// and the explicit map: the deliberate value must win.
func TestBuildExtraWinsOverUnset(t *testing.T) {
	t.Setenv("KEEP", "ambient")
	got := Build(NewPaths(), map[string]string{"KEEP": "explicit"}, "KEEP")
	if !slices.Contains(got, "KEEP=explicit") {
		t.Fatalf("explicit value did not win over the tombstone: %q", got)
	}
	if slices.Contains(got, "KEEP=ambient") {
		t.Errorf("ambient value survived the tombstone: %q", got)
	}
}

func TestBuildIsolatedKeepsOnlyBaselineAndExtra(t *testing.T) {
	t.Setenv("PATH", "/usr/bin")
	t.Setenv("HOME", "/root")
	t.Setenv("INHERITED", "yes")
	t.Setenv("DSH_PODMAN_GUEST_TOKEN", "super-secret")

	got := BuildIsolated(NewPaths(), map[string]string{"FOO": "bar"})
	for _, want := range []string{"PATH=/usr/bin", "HOME=/root", "FOO=bar"} {
		if !slices.Contains(got, want) {
			t.Errorf("missing %q in %q", want, got)
		}
	}
	for _, entry := range got {
		if strings.HasPrefix(entry, "INHERITED=") || strings.HasPrefix(entry, Reserved) {
			t.Errorf("unexpected variable %q in %q", entry, got)
		}
	}
}

func TestBuildIsolatedExtraOverridesBaseline(t *testing.T) {
	t.Setenv("PATH", "/usr/bin")
	t.Setenv("HOME", "/root")
	got := BuildIsolated(NewPaths(), map[string]string{"PATH": "/custom"})
	if !slices.Contains(got, "PATH=/custom") {
		t.Fatalf("caller PATH did not override baseline: %q", got)
	}
	if slices.Contains(got, "PATH=/usr/bin") {
		t.Errorf("baseline PATH survived the override: %q", got)
	}
}

func TestSetDeduplicatesAndKeepsOrder(t *testing.T) {
	paths := NewPaths()
	stored := paths.Set([]string{"/a", "/b", "/a", ""})
	if !slices.Equal(stored, []string{"/a", "/b"}) {
		t.Fatalf("unexpected stored paths: %q", stored)
	}
	if !slices.Equal(paths.List(), []string{"/a", "/b"}) {
		t.Fatalf("unexpected list: %q", paths.List())
	}
	if got := NewPaths().List(); len(got) != 0 {
		t.Fatalf("a fresh store must be empty: %q", got)
	}
}

func TestBuildPrependsPathAdditions(t *testing.T) {
	t.Setenv("PATH", "/usr/bin")
	paths := NewPaths()
	paths.Set([]string{"/opt/bin", "/usr/local/bin"})
	got := Build(paths, nil)
	if !slices.Contains(got, "PATH=/opt/bin:/usr/local/bin:/usr/bin") {
		t.Fatalf("additions not prepended: %q", got)
	}
}

// TestBuildAdditionsPrependToCallerPath covers a caller that set PATH itself:
// the additions still take priority.
func TestBuildAdditionsPrependToCallerPath(t *testing.T) {
	t.Setenv("PATH", "/usr/bin")
	paths := NewPaths()
	paths.Set([]string{"/opt/bin"})
	got := Build(paths, map[string]string{"PATH": "/custom"})
	if !slices.Contains(got, "PATH=/opt/bin:/custom") {
		t.Fatalf("additions not prepended to the caller PATH: %q", got)
	}
}

func TestBuildIsolatedPrependsPathAdditions(t *testing.T) {
	t.Setenv("PATH", "/usr/bin")
	t.Setenv("HOME", "/root")
	paths := NewPaths()
	paths.Set([]string{"/opt/bin"})
	got := BuildIsolated(paths, map[string]string{"FOO": "bar"})
	if !slices.Contains(got, "PATH=/opt/bin:/usr/bin") {
		t.Fatalf("additions not prepended to the baseline PATH: %q", got)
	}
}

// TestNilPathsIsSafe pins that a manager constructed without a store still
// builds an environment (read paths must tolerate a nil store).
func TestNilPathsIsSafe(t *testing.T) {
	t.Setenv("PATH", "/usr/bin")
	if got := Build(nil, nil); !slices.Contains(got, "PATH=/usr/bin") {
		t.Fatalf("nil store changed the environment: %q", got)
	}
}
