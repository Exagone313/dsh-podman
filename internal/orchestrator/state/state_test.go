package state

import "testing"

func TestStateRoundTrip(t *testing.T) {
	store, err := New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	images := []Image{{ImageID: "arch", BaseImage: "archlinux", Packages: []string{"git"}, ImageTag: "tag", BuiltAt: "now"}}
	if err := store.SaveImages(images); err != nil {
		t.Fatal(err)
	}
	got, err := store.Images()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].ImageID != "arch" || got[0].Packages[0] != "git" {
		t.Fatalf("round trip mismatch: %#v", got)
	}
}
func TestMissingStateIsEmpty(t *testing.T) {
	store, _ := New(t.TempDir())
	got, err := store.Workspaces()
	if err != nil || len(got) != 0 {
		t.Fatalf("got %#v, %v", got, err)
	}
}
