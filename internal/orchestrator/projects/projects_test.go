// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package projects

import (
	"os"
	"path/filepath"
	"testing"
)

func TestListDirectories(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "zeta"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "team", "test-dh"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "file"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	got, err := List(root)
	if err != nil || len(got) != 3 || got[0].Name != "team" || got[1].Name != "team/test-dh" || got[2].Name != "zeta" {
		t.Fatalf("got %#v, %v", got, err)
	}
	if got[0].HostPath == "" || !filepath.IsAbs(got[0].HostPath) {
		t.Fatalf("host path not absolute: %#v", got[0])
	}
}

func TestListEmptyRoot(t *testing.T) {
	got, err := List(t.TempDir())
	if err != nil || len(got) != 0 {
		t.Fatalf("got %#v, %v", got, err)
	}
}

func TestListMissingRoot(t *testing.T) {
	if _, err := List(filepath.Join(t.TempDir(), "nope")); err == nil {
		t.Fatal("expected error for missing root")
	}
}

func TestListSorted(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{"beta", "alpha", "gamma"} {
		if err := os.Mkdir(filepath.Join(root, name), 0755); err != nil {
			t.Fatal(err)
		}
	}
	got, err := List(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 || got[0].Name != "alpha" || got[1].Name != "beta" || got[2].Name != "gamma" {
		t.Fatalf("unexpected order: %#v", got)
	}
}

func TestListSkipsFilesAtRoot(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "README"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	got, err := List(root)
	if err != nil || len(got) != 0 {
		t.Fatalf("got %#v, %v", got, err)
	}
}
