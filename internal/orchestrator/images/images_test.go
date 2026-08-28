// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package images

import (
	"strings"
	"testing"

	"gitlab.com/Exagone313/dsh-podman/internal/orchestrator/state"
)

func TestContainerfileInstallsPackagesWithoutInlineCache(t *testing.T) {
	file, err := Containerfile(state.Image{BaseImage: "archlinux", Packages: []string{"git", "python"}})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(file, "--mount") || !strings.Contains(file, "git python") {
		t.Fatalf("unexpected Containerfile: %s", file)
	}
}
func TestContainerfileRejectsCommandInjection(t *testing.T) {
	if _, err := Containerfile(state.Image{BaseImage: "arch", Packages: []string{"git;rm"}}); err == nil {
		t.Fatal("accepted invalid package")
	}
}

func TestContainerfileLeavesCacheMountToBuildOptions(t *testing.T) {
	file, err := Containerfile(state.Image{BaseImage: "archlinux"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(file, "--mount") || strings.Contains(file, "type=cache") {
		t.Fatalf("Containerfile contains an inline cache mount: %s", file)
	}
	if strings.Contains(file, "pacman -Scc") {
		t.Fatalf("Containerfile cleans the persistent pacman cache: %s", file)
	}
}

func TestContainerfileUsesBaseImage(t *testing.T) {
	file, err := Containerfile(state.Image{BaseImage: "docker.io/library/archlinux:latest"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(file, "FROM docker.io/library/archlinux:latest") {
		t.Fatalf("base image not first line: %s", file)
	}
}

func TestContainerfileWithoutPackagesRunsPlainUpdate(t *testing.T) {
	file, err := Containerfile(state.Image{BaseImage: "arch"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(file, "RUN pacman -Syu --needed --noconfirm\n") {
		t.Fatalf("missing plain update line: %s", file)
	}
}

func TestContainerfileSetsGuestAgentEntrypoint(t *testing.T) {
	file, err := Containerfile(state.Image{BaseImage: "arch"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(file, "ENTRYPOINT") {
		t.Fatalf("missing entrypoint: %s", file)
	}
}

func TestContainerfileRejectsShellMetacharacters(t *testing.T) {
	for _, pkg := range []string{"a b", "$(id)", "`id`", "a&b", "a|b", "a;b", "a>b", "a\nb", "~evil"} {
		if _, err := Containerfile(state.Image{BaseImage: "arch", Packages: []string{pkg}}); err == nil {
			t.Errorf("accepted invalid package %q", pkg)
		}
	}
}

func TestContainerfileRejectsFlagPackages(t *testing.T) {
	for _, pkg := range []string{"-S", "--noconfirm", "--dbpath", "-R"} {
		if _, err := Containerfile(state.Image{BaseImage: "arch", Packages: []string{pkg}}); err == nil {
			t.Errorf("accepted flag-like package %q", pkg)
		}
	}
}

func TestContainerfileAcceptsValidPackages(t *testing.T) {
	for _, pkg := range []string{"git", "base-devel", "python3.12", "g++", "linux-headers"} {
		if _, err := Containerfile(state.Image{BaseImage: "arch", Packages: []string{pkg}}); err != nil {
			t.Errorf("rejected valid package %q: %v", pkg, err)
		}
	}
}

func TestContainerfileRejectsInvalidBaseImage(t *testing.T) {
	for _, base := range []string{"", "..", "../etc", "arch\nRUN touch /escape", "arch:latest #evil", "arch 1.0", "a\\b", "arch\n", "::"} {
		if _, err := Containerfile(state.Image{BaseImage: base}); err == nil {
			t.Errorf("accepted invalid base image %q", base)
		}
	}
}

func TestContainerfileAcceptsValidBaseImages(t *testing.T) {
	for _, base := range []string{"archlinux", "docker.io/library/archlinux:latest", "localhost/team/image:1.0", "registry.example.com/ns/img@sha256:abc123", "archlinux-1"} {
		if _, err := Containerfile(state.Image{BaseImage: base}); err != nil {
			t.Errorf("rejected valid base image %q: %v", base, err)
		}
	}
}

func TestValidImageID(t *testing.T) {
	for _, id := range []string{"arch", "a-b_c.1", "A1", "x"} {
		if !validImageID(id) {
			t.Errorf("rejected valid image id %q", id)
		}
	}
	for _, id := range []string{"", ".", "..", "-x", "a/b", "a b", "a:latest", "a\nb", strings.Repeat("b", 120)} {
		if validImageID(id) {
			t.Errorf("accepted invalid image id %q", id)
		}
	}
}

func TestBuildRejectsInvalidImageID(t *testing.T) {
	builder := Builder{}
	for _, id := range []string{"../../etc", "..", "a/b", ""} {
		if _, err := builder.Build(state.Image{ImageID: id, BaseImage: "arch"}); err == nil {
			t.Errorf("accepted invalid image id %q", id)
		}
	}
}
