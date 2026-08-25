package images

import (
	"strings"
	"testing"

	"dsh-container-plugin/internal/orchestrator/state"
)

func TestContainerfileUsesPacmanCache(t *testing.T) {
	file, err := Containerfile(state.Image{BaseImage: "archlinux", Packages: []string{"git", "python"}})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(file, "type=cache") || !strings.Contains(file, "git python") {
		t.Fatalf("unexpected Containerfile: %s", file)
	}
}
func TestContainerfileRejectsCommandInjection(t *testing.T) {
	if _, err := Containerfile(state.Image{BaseImage: "arch", Packages: []string{"git;rm"}}); err == nil {
		t.Fatal("accepted invalid package")
	}
}
