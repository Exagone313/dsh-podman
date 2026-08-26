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
}
