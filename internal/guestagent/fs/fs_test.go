// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package fs

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// tempDir returns a canonicalized temporary directory, matching how Resolve
// evaluates host roots, so the tests are robust when TMPDIR points through a
// symlink (e.g. /tmp -> /run/user/<uid>).
func tempDir(t *testing.T) string {
	t.Helper()
	dir, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestNewRejectsRelativeMounts(t *testing.T) {
	for _, mount := range []Mount{{Virtual: "workspace", Host: "/tmp"}, {Virtual: "/workspace", Host: "tmp"}} {
		if _, err := New([]Mount{mount}); err == nil {
			t.Errorf("accepted relative mount %#v", mount)
		}
	}
}

func TestResolveRejectsRelativePaths(t *testing.T) {
	root := t.TempDir()
	w, err := New([]Mount{{Virtual: "/workspace", Host: root}})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := w.Resolve("workspace/file", false); err == nil {
		t.Fatal("accepted relative path")
	}
}

func TestResolveRejectsWriteToReadOnlyMount(t *testing.T) {
	root := t.TempDir()
	w, err := New([]Mount{{Virtual: "/workspace", Host: root, ReadOnly: true}})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := w.Resolve("/workspace/file", true); err == nil {
		t.Fatal("accepted write to read-only mount")
	}
	if _, readonly, err := w.Resolve("/workspace/file", false); err != nil || !readonly {
		t.Fatalf("read-only mount not reported: %v %v", readonly, err)
	}
}

func TestResolveRejectsUnsafePaths(t *testing.T) {
	root, outside := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret"), []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "link")); err != nil {
		t.Fatal(err)
	}
	w, _ := New([]Mount{{Virtual: "/workspace", Host: root}})
	for _, path := range []string{"/workspace/../secret", "/workspace/link/secret", "/etc/passwd", "/workspace/missing/../../secret"} {
		if _, _, err := w.Resolve(path, false); err == nil {
			t.Errorf("accepted unsafe path %q", path)
		}
	}
}

func TestResolveAllowsMount(t *testing.T) {
	root := tempDir(t)
	w, _ := New([]Mount{{Virtual: "/workspace", Host: root}})
	path, _, err := w.Resolve("/workspace/file", true)
	if err != nil || path != filepath.Join(root, "file") {
		t.Fatalf("resolved %q: %v", path, err)
	}
}

func TestResolveRejectsWriteToMountRoot(t *testing.T) {
	root := tempDir(t)
	w, _ := New([]Mount{{Virtual: "/workspace", Host: root}})
	for _, path := range []string{"/workspace", "/workspace/"} {
		if _, _, err := w.Resolve(path, true); err == nil {
			t.Errorf("accepted write to mount root %q", path)
		}
	}
	if path, _, err := w.Resolve("/workspace", false); err != nil || path != root {
		t.Fatalf("read of mount root failed: %q %v", path, err)
	}
}

func TestResolveAllowsNonExistentPathWithinMount(t *testing.T) {
	root := tempDir(t)
	w, _ := New([]Mount{{Virtual: "/workspace", Host: root}})
	path, _, err := w.Resolve("/workspace/new/dir/file", true)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(path, root+string(filepath.Separator)) {
		t.Fatalf("resolved path %q escapes mount root %q", path, root)
	}
}

func TestResolveRejectsOutsideConfiguredMounts(t *testing.T) {
	root := t.TempDir()
	w, _ := New([]Mount{{Virtual: "/workspace", Host: root}})
	if _, _, err := w.Resolve("/elsewhere/file", true); err == nil {
		t.Fatal("accepted path outside configured mounts")
	}
}

func TestResolveAcrossMultipleMounts(t *testing.T) {
	projects, data := tempDir(t), tempDir(t)
	w, err := New([]Mount{
		{Virtual: "/projects", Host: projects},
		{Virtual: "/data", Host: data, ReadOnly: true},
		{Virtual: "/scratch", Host: t.TempDir()},
	})
	if err != nil {
		t.Fatal(err)
	}
	if path, _, err := w.Resolve("/projects/team/file", true); err != nil {
		t.Fatalf("write to project mount failed: %v", err)
	} else if !strings.HasPrefix(path, projects+string(filepath.Separator)) {
		t.Fatalf("resolved %q outside projects mount %q", path, projects)
	}
	if _, _, err := w.Resolve("/scratch/tmp", true); err != nil {
		t.Fatalf("write to tmpfs mount failed: %v", err)
	}
	if _, _, err := w.Resolve("/data/file", true); err == nil {
		t.Fatal("accepted write to read-only volume mount")
	}
	if path, readonly, err := w.Resolve("/data/file", false); err != nil || !readonly {
		t.Fatalf("read-only volume mount not reported: %v %v", readonly, err)
	} else if !strings.HasPrefix(path, data+string(filepath.Separator)) {
		t.Fatalf("resolved %q outside volume mount %q", path, data)
	}
	if _, _, err := w.Resolve("/etc/passwd", false); err == nil {
		t.Fatal("accepted path outside every configured mount")
	}
}

func TestResolveDetectsSymlinkedHostRoot(t *testing.T) {
	realRoot, host := t.TempDir(), t.TempDir()
	if err := os.Symlink(realRoot, filepath.Join(host, "projects")); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(realRoot, "team"), 0755); err != nil {
		t.Fatal(err)
	}
	w, err := New([]Mount{{Virtual: "/workspace", Host: filepath.Join(host, "projects")}})
	if err != nil {
		t.Fatal(err)
	}
	path, _, err := w.Resolve("/workspace/team", false)
	if err != nil {
		t.Fatal(err)
	}
	if resolved, evalErr := filepath.EvalSymlinks(filepath.Join(host, "projects")); evalErr != nil {
		t.Fatal(evalErr)
	} else if path != resolved && !strings.HasPrefix(path, resolved+string(filepath.Separator)) {
		t.Fatalf("resolved %q is outside evaluated mount root %q", path, resolved)
	}
}

func TestResolveEntryDoesNotFollowFinalSymlink(t *testing.T) {
	root := tempDir(t)
	target := filepath.Join(root, "target")
	if err := os.WriteFile(target, []byte("data"), 0600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "link")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	w, err := New([]Mount{{Virtual: "/workspace", Host: root}})
	if err != nil {
		t.Fatal(err)
	}
	if resolved, _, err := w.Resolve("/workspace/link", false); err != nil {
		t.Fatal(err)
	} else if resolved != target {
		t.Fatalf("Resolve followed to %q, want %q", resolved, target)
	}
	entry, err := w.ResolveEntry("/workspace/link")
	if err != nil {
		t.Fatal(err)
	}
	if entry != link {
		t.Fatalf("ResolveEntry returned %q, want %q", entry, link)
	}
	if info, err := os.Lstat(entry); err != nil {
		t.Fatal(err)
	} else if info.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("ResolveEntry returned a non-symlink entry %q", entry)
	}
}
