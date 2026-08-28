package fs

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResolveRejectsUnsafePaths(t *testing.T) {
	root, outside := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret"), []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(root, "link")); err != nil {
		t.Fatal(err)
	}
	w, _ := New([]Mount{{Virtual: "/workspace", Host: root}})
	for _, path := range []string{"/workspace/../secret", "/workspace/link/secret", "/etc/passwd"} {
		if _, _, err := w.Resolve(path, false); err == nil {
			t.Errorf("accepted unsafe path %q", path)
		}
	}
}
func TestResolveAllowsMount(t *testing.T) {
	root := t.TempDir()
	w, _ := New([]Mount{{Virtual: "/workspace", Host: root}})
	path, _, err := w.Resolve("/workspace/file", true)
	if err != nil || path != filepath.Join(root, "file") {
		t.Fatalf("resolved %q: %v", path, err)
	}
}
