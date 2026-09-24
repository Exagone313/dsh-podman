// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"context"
	"strings"
	"testing"

	ctl "github.com/Exagone313/dsh-podman/internal/genproto/dshctl/v1"
	imagebuild "github.com/Exagone313/dsh-podman/internal/orchestrator/images"
	"github.com/Exagone313/dsh-podman/internal/orchestrator/podman"
	"github.com/Exagone313/dsh-podman/internal/orchestrator/state"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func TestDefaultImageShort(t *testing.T) {
	if got := defaultImageShort(); got != "archlinux" {
		t.Fatalf("unexpected default image short name: %q", got)
	}
}

func TestShortImageName(t *testing.T) {
	for _, id := range []string{"archlinux", "a-b_c.1", "A1", "x", "_x", "my.image-2", strings.Repeat("a", 64)} {
		if !shortImageName(id) {
			t.Errorf("rejected valid short name %q", id)
		}
	}
	for _, id := range []string{"", ".", "..", "-x", "a/b", "a:b", "a b", "a\nb", "a\\b", strings.Repeat("a", 65)} {
		if shortImageName(id) {
			t.Errorf("accepted invalid short name %q", id)
		}
	}
}

func TestBaseTag(t *testing.T) {
	server := &Server{Logger: silentLogger()}
	if got := server.baseTag("archlinux"); got != "localhost/dsh-podman/base/archlinux:latest" {
		t.Fatalf("unexpected default base tag %q", got)
	}
	server = &Server{BaseImagePrefix: "registry.example.com/base/", Logger: silentLogger()}
	if got := server.baseTag("archlinux"); got != "registry.example.com/base/archlinux:latest" {
		t.Fatalf("unexpected public base tag %q", got)
	}
	server = &Server{BaseImagePrefix: "registry.example.com/base", Logger: silentLogger()}
	if got := server.baseTag("archlinux"); got != "registry.example.com/base/archlinux:latest" {
		t.Fatalf("unexpected normalized base tag %q", got)
	}
}

func TestBaseImagesPublic(t *testing.T) {
	if (&Server{Logger: silentLogger()}).baseImagesPublic() {
		t.Fatal("default localhost prefix must be local")
	}
	if (&Server{BaseImagePrefix: "localhost/x/", Logger: silentLogger()}).baseImagesPublic() {
		t.Fatal("localhost/ prefix must be local")
	}
	if !(&Server{BaseImagePrefix: "registry.example.com/base/", Logger: silentLogger()}).baseImagesPublic() {
		t.Fatal("non-localhost prefix must be public")
	}
}

func TestBaseStatus(t *testing.T) {
	server := &Server{Logger: silentLogger()}
	if _, err := server.baseStatus("archlinux"); status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("nil podman: expected FailedPrecondition, got %v", err)
	}
	if _, err := server.baseStatus("nope"); status.Code(err) != codes.NotFound {
		t.Fatalf("unknown base: expected NotFound, got %v", err)
	}
}

func TestEnsureBase(t *testing.T) {
	server := &Server{Logger: silentLogger()}
	if _, _, err := server.ensureBase("archlinux"); status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("nil podman: expected FailedPrecondition, got %v", err)
	}
	if _, _, err := server.ensureBase("nope"); status.Code(err) != codes.NotFound {
		t.Fatalf("unknown base: expected NotFound, got %v", err)
	}
}

func TestListImages(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveImages([]state.Image{{ImageID: "devimg", Parent: "archlinux", PackageManager: "pacman", Packages: []string{"git"}, ImageTag: "localhost/dsh-podman/devimg:latest"}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}
	response, err := server.ListImages(context.Background(), &ctl.ListImagesRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if len(response.Images) != 4 {
		t.Fatalf("expected 4 images (3 bases + 1 custom), got %d", len(response.Images))
	}
	bases := response.Images[:3]
	for i, want := range []string{"archlinux", "ubuntu", "alpine"} {
		img := bases[i]
		if !img.IsBase || img.ImageId != want || img.Status != "missing" {
			t.Fatalf("unexpected base row %d: %#v", i, img)
		}
	}
	if bases[0].Primitive != "docker.io/library/archlinux:latest" || bases[0].PackageManager != "pacman" {
		t.Fatalf("unexpected archlinux row: %#v", bases[0])
	}
	if bases[1].Primitive != "docker.io/library/ubuntu:latest" || bases[1].PackageManager != "apt" {
		t.Fatalf("unexpected ubuntu row: %#v", bases[1])
	}
	if bases[2].Primitive != "docker.io/library/alpine:latest" || bases[2].PackageManager != "apk" {
		t.Fatalf("unexpected alpine row: %#v", bases[2])
	}
	for _, base := range bases {
		if len(base.Packages) == 0 {
			t.Fatalf("base %q must expose its default packages, got %#v", base.ImageId, base)
		}
		if base.BasePublic {
			t.Fatalf("base %q must default to local (not public), got %#v", base.ImageId, base)
		}
		if base.BuiltAt != "" {
			t.Fatalf("missing base %q must have no built date, got %#v", base.ImageId, base)
		}
	}
	custom := response.Images[3]
	if custom.ImageId != "devimg" || custom.Parent != "archlinux" || custom.PackageManager != "pacman" || custom.Status != "built" || custom.IsBase {
		t.Fatalf("unexpected custom row: %#v", custom)
	}
}

func (f *fakePodman) ImageExists(string) (bool, error) { return true, nil }

func (f *fakePodman) ImageCreated(string) string { return "" }

func (f *fakePodman) ImagePull(string) error { return nil }

func (f *fakePodman) ImageRemove(string) error { return nil }

func TestStartContainerRejectsUnknownImage(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveWorkspaces([]state.Workspace{{WorkspaceSlug: "proj"}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}
	for _, image := range []string{
		"docker.io/library/nginx:latest",
		"localhost/dsh-podman/not-built",
		"arbitrary",
	} {
		_, err := server.StartContainer(context.Background(), &ctl.StartContainerRequest{WorkspaceSlug: "proj", Container: "web", ImageId: image})
		if status.Code(err) != codes.NotFound {
			t.Errorf("image %q: expected NotFound (arbitrary image rejected), got %v", image, err)
		}
	}
}

func TestGetImageMissing(t *testing.T) {
	server := &Server{Store: newTestStore(t), Logger: silentLogger()}
	_, err := server.GetImage(context.Background(), &ctl.GetImageRequest{ImageId: "nope"})
	if status.Code(err) != codes.NotFound {
		t.Fatalf("expected NotFound, got %v", err)
	}
}

func TestGetImage(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveImages([]state.Image{{ImageID: "devimg", Parent: "archlinux", PackageManager: "pacman", Packages: []string{"git"}, ImageTag: "t1", BuiltAt: "now"}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}
	image, err := server.GetImage(context.Background(), &ctl.GetImageRequest{ImageId: "devimg"})
	if err != nil {
		t.Fatal(err)
	}
	if image.ImageId != "devimg" || image.Parent != "archlinux" || image.PackageManager != "pacman" || image.ImageTag != "t1" || image.BuiltAt != "now" || len(image.Packages) != 1 || image.Packages[0] != "git" {
		t.Fatalf("unexpected image: %#v", image)
	}
	if image.IsBase || image.Status != "built" {
		t.Fatalf("unexpected custom image status: %#v", image)
	}
}

func TestGetImageBase(t *testing.T) {
	server := &Server{Store: newTestStore(t), Logger: silentLogger()}
	image, err := server.GetImage(context.Background(), &ctl.GetImageRequest{ImageId: "archlinux"})
	if err != nil {
		t.Fatal(err)
	}
	if !image.IsBase || image.ImageId != "archlinux" || image.Primitive != "docker.io/library/archlinux:latest" || image.PackageManager != "pacman" || image.Status != "missing" {
		t.Fatalf("unexpected base row: %#v", image)
	}
}

func TestBuildImageRejectsBaseName(t *testing.T) {
	server := &Server{Logger: silentLogger()}
	_, err := server.BuildImage(context.Background(), &ctl.BuildImageRequest{ImageId: "archlinux", Parent: "archlinux"})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("expected InvalidArgument, got %v", err)
	}
}

func TestBuildImageRejectsInvalidName(t *testing.T) {
	server := &Server{Logger: silentLogger()}
	for _, id := range []string{"", "bad/name", "bad:tag", "-x", "a b"} {
		_, err := server.BuildImage(context.Background(), &ctl.BuildImageRequest{ImageId: id})
		if status.Code(err) != codes.InvalidArgument {
			t.Errorf("image id %q: expected InvalidArgument, got %v", id, err)
		}
	}
}

func TestRebuildImageRejectsBaseName(t *testing.T) {
	server := &Server{Logger: silentLogger()}
	_, err := server.RebuildImage(context.Background(), &ctl.RebuildImageRequest{ImageId: "archlinux"})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("expected InvalidArgument, got %v", err)
	}
}

func TestBuildImageUnknownParent(t *testing.T) {
	server := &Server{Store: newTestStore(t), ImageBuilder: &imagebuild.Builder{}, Logger: silentLogger()}
	_, err := server.BuildImage(context.Background(), &ctl.BuildImageRequest{ImageId: "dev", Parent: "missing"})
	if status.Code(err) != codes.NotFound {
		t.Fatalf("expected NotFound, got %v", err)
	}
}

func TestBuildImageRequiresBuilder(t *testing.T) {
	server := &Server{Logger: silentLogger()}
	_, err := server.BuildImage(context.Background(), &ctl.BuildImageRequest{ImageId: "dev", Parent: "archlinux"})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("expected FailedPrecondition, got %v", err)
	}
}

func TestBuildImageRequiresPodman(t *testing.T) {
	server := &Server{Store: newTestStore(t), ImageBuilder: &imagebuild.Builder{}, Logger: silentLogger()}
	_, err := server.BuildImage(context.Background(), &ctl.BuildImageRequest{ImageId: "dev", Parent: "archlinux"})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("expected FailedPrecondition, got %v", err)
	}
}

func TestResolveImageTag(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveImages([]state.Image{{ImageID: "valkey", Parent: "archlinux", PackageManager: "pacman", ImageTag: "localhost/dsh-podman/valkey:latest"}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}
	if got, err := server.resolveImageTag("valkey"); err != nil || got != "localhost/dsh-podman/valkey:latest" {
		t.Fatalf("resolveImageTag(valkey) = %q, %v", got, err)
	}
	if _, err := server.resolveImageTag("missing"); status.Code(err) != codes.NotFound {
		t.Fatalf("expected NotFound for missing image, got %v", err)
	}
	if _, err := server.resolveImageTag("archlinux"); status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("base with nil podman: expected FailedPrecondition, got %v", err)
	}
}

func TestGetImageByShortName(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveImages([]state.Image{{ImageID: "valkey", ImageTag: "localhost/dsh-podman/valkey:latest"}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}
	image, err := server.GetImage(context.Background(), &ctl.GetImageRequest{ImageId: "valkey"})
	if err != nil {
		t.Fatal(err)
	}
	if image.ImageId != "valkey" {
		t.Fatalf("expected stored image valkey, got %q", image.ImageId)
	}
}

func TestRebuildImageByShortName(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveImages([]state.Image{
		{ImageID: "mid", PackageManager: "pacman", ImageTag: "localhost/dsh-podman/mid:latest"},
		{ImageID: "valkey", Parent: "mid", PackageManager: "pacman", Packages: []string{"valkey"}, ImageTag: "localhost/dsh-podman/valkey:latest"},
	}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, ImageBuilder: &imagebuild.Builder{}, Logger: silentLogger()}
	_, err := server.RebuildImage(context.Background(), &ctl.RebuildImageRequest{ImageId: "valkey"})
	if status.Code(err) != codes.Internal {
		t.Fatalf("short name should resolve past image lookup, expected Internal (unconfigured builder), got %v", err)
	}
}

func TestRemoveImageRejectsBaseName(t *testing.T) {
	server := &Server{Store: newTestStore(t), Logger: silentLogger()}
	_, err := server.RemoveImage(context.Background(), &ctl.RemoveImageRequest{ImageId: "archlinux"})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("expected InvalidArgument, got %v", err)
	}
}

func TestRemoveImageUnknown(t *testing.T) {
	server := &Server{Store: newTestStore(t), Logger: silentLogger()}
	_, err := server.RemoveImage(context.Background(), &ctl.RemoveImageRequest{ImageId: "nope"})
	if status.Code(err) != codes.NotFound {
		t.Fatalf("expected NotFound, got %v", err)
	}
}

func TestRemoveImageInUse(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveImages([]state.Image{{ImageID: "valkey", ImageTag: "localhost/dsh-podman/valkey:latest"}}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveWorkspaces([]state.Workspace{{
		WorkspaceSlug: "valkey-ws",
		Containers:    []state.Container{{Name: "valkey-ctr", ImageID: "valkey"}},
	}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}
	_, err := server.RemoveImage(context.Background(), &ctl.RemoveImageRequest{ImageId: "valkey"})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("named container in use: expected FailedPrecondition, got %v", err)
	}
	if err := store.SaveWorkspaces([]state.Workspace{{
		WorkspaceSlug: "valkey-ws",
		ImageID:       "valkey",
		Containers:    []state.Container{{Name: "default", ImageID: "valkey"}},
	}}); err != nil {
		t.Fatal(err)
	}
	_, err = server.RemoveImage(context.Background(), &ctl.RemoveImageRequest{ImageId: "valkey"})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("workspace default container in use: expected FailedPrecondition, got %v", err)
	}
}

// TestRemoveImageReconcilesDeadContainers pins that a container deleted outside
// dsh-podman no longer keeps its image in use: the dead record is reconciled
// away before the usage check.
func TestRemoveImageReconcilesDeadContainers(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveImages([]state.Image{{ImageID: "valkey", ImageTag: "localhost/dsh-podman/valkey:latest"}}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveWorkspaces([]state.Workspace{{
		WorkspaceSlug: "valkey-ws",
		Containers:    []state.Container{{Name: "default", PodmanName: "dsh-podman-valkey-ws-default", ImageID: "valkey"}},
	}}); err != nil {
		t.Fatal(err)
	}
	fake := newFakePodman()
	server := &Server{Store: store, Podman: fake, Logger: silentLogger()}
	if _, err := server.RemoveImage(context.Background(), &ctl.RemoveImageRequest{ImageId: "valkey"}); err != nil {
		t.Fatalf("a dead container must not keep the image in use: %v", err)
	}
	stored, err := store.Workspaces()
	if err != nil {
		t.Fatal(err)
	}
	if len(stored) != 0 {
		t.Fatalf("expected the dead record to be reconciled away, got %#v", stored)
	}
}

func TestRemoveImageRequiresPodman(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveImages([]state.Image{{ImageID: "valkey", ImageTag: "localhost/dsh-podman/valkey:latest"}}); err != nil {
		t.Fatal(err)
	}
	if err := store.SaveWorkspaces([]state.Workspace{{
		WorkspaceSlug: "other-ws",
		Containers:    []state.Container{{Name: "default", ImageID: "arch"}},
	}}); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, Logger: silentLogger()}
	_, err := server.RemoveImage(context.Background(), &ctl.RemoveImageRequest{ImageId: "valkey"})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("expected FailedPrecondition, got %v", err)
	}
}

func TestImageRefsMatch(t *testing.T) {
	cases := []struct {
		name  string
		a, b  string
		match bool
	}{
		{"identical short id", "valkey", "valkey", true},
		{"short id vs qualified tag", "valkey", "localhost/dsh-podman/valkey:latest", true},
		{"qualified vs short tag", "localhost/dsh-podman/valkey", "valkey:latest", true},
		{"qualified vs qualified tag", "localhost/dsh-podman/valkey", "localhost/dsh-podman/valkey:latest", true},
		{"tag vs tag", "valkey:latest", "valkey:latest", true},
		{"differing short ids", "valkey", "redis", false},
		{"differing qualified ids", "localhost/dsh-podman/valkey", "localhost/dsh-podman/redis", false},
		{"different prefixes", "registry.example.com/x/valkey", "localhost/dsh-podman/valkey", false},
	}
	for _, tc := range cases {
		if got := imageRefsMatch(tc.a, tc.b); got != tc.match {
			t.Errorf("%s: imageRefsMatch(%q, %q) = %v, want %v", tc.name, tc.a, tc.b, got, tc.match)
		}
	}
}

func TestCreateWorkspaceRejectsUnknownImage(t *testing.T) {
	server := &Server{Store: newTestStore(t), Logger: silentLogger()}
	_, err := server.CreateWorkspace(context.Background(), &ctl.CreateWorkspaceRequest{WorkspaceSlug: testWorkspaceSlug, ProjectName: "proj", ImageId: "missing"})
	if status.Code(err) != codes.NotFound {
		t.Fatalf("expected NotFound, got %v", err)
	}
}

func TestCreateWorkspaceDefaultBase(t *testing.T) {
	server := &Server{Store: newTestStore(t), Logger: silentLogger()}
	_, err := server.CreateWorkspace(context.Background(), &ctl.CreateWorkspaceRequest{WorkspaceSlug: testWorkspaceSlug, ProjectName: "proj"})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("empty image id must resolve the default base (archlinux) and require podman, expected FailedPrecondition, got %v", err)
	}
}

func TestRebuildBaseImage(t *testing.T) {
	server := &Server{Logger: silentLogger()}
	if _, err := server.RebuildBaseImage(context.Background(), &ctl.RebuildBaseImageRequest{Name: "nope"}); status.Code(err) != codes.NotFound {
		t.Fatalf("unknown base: expected NotFound, got %v", err)
	}
	_, err := server.RebuildBaseImage(context.Background(), &ctl.RebuildBaseImageRequest{Name: "archlinux"})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("local mode with nil podman: expected FailedPrecondition, got %v", err)
	}
	public := &Server{BaseImagePrefix: "registry.example.com/base/", Logger: silentLogger()}
	if _, err := public.RebuildBaseImage(context.Background(), &ctl.RebuildBaseImageRequest{Name: "archlinux"}); status.Code(err) != codes.InvalidArgument {
		t.Fatalf("public mode: expected InvalidArgument, got %v", err)
	}
}

func TestPullBaseImage(t *testing.T) {
	server := &Server{Logger: silentLogger()}
	if _, err := server.PullBaseImage(context.Background(), &ctl.PullBaseImageRequest{Name: "nope"}); status.Code(err) != codes.NotFound {
		t.Fatalf("unknown base: expected NotFound, got %v", err)
	}
	_, err := server.PullBaseImage(context.Background(), &ctl.PullBaseImageRequest{Name: "archlinux"})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("local mode: expected InvalidArgument, got %v", err)
	}
	public := &Server{BaseImagePrefix: "registry.example.com/base/", Logger: silentLogger()}
	if _, err := public.PullBaseImage(context.Background(), &ctl.PullBaseImageRequest{Name: "archlinux"}); status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("public mode with nil podman: expected FailedPrecondition, got %v", err)
	}
}

func TestRebuildImageRequiresBuilder(t *testing.T) {
	server := &Server{Logger: silentLogger()}
	_, err := server.RebuildImage(context.Background(), &ctl.RebuildImageRequest{ImageId: "arch"})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("expected FailedPrecondition, got %v", err)
	}
}

func TestRebuildAllImagesRequiresBuilder(t *testing.T) {
	server := &Server{Store: newTestStore(t), Podman: &podman.Client{}, Logger: silentLogger()}
	_, err := server.RebuildAllImages(context.Background(), &ctl.RebuildAllImagesRequest{})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("expected FailedPrecondition, got %v", err)
	}
}

func TestRebuildAllImagesRequiresPodman(t *testing.T) {
	server := &Server{Store: newTestStore(t), ImageBuilder: &imagebuild.Builder{}, Logger: silentLogger()}
	_, err := server.RebuildAllImages(context.Background(), &ctl.RebuildAllImagesRequest{})
	if status.Code(err) != codes.FailedPrecondition {
		t.Fatalf("expected FailedPrecondition, got %v", err)
	}
}

func TestRebuildAllImagesNoImages(t *testing.T) {
	server := &Server{Store: newTestStore(t), ImageBuilder: &imagebuild.Builder{}, Podman: &podman.Client{}, Logger: silentLogger()}
	response, err := server.RebuildAllImages(context.Background(), &ctl.RebuildAllImagesRequest{})
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if len(response.Rebuilt) != 0 {
		t.Fatalf("expected no rebuilt images, got %#v", response.Rebuilt)
	}
	// No custom image exists, but the unusable builder still reports every base
	// it could not ensure, instead of logging the failure only.
	if len(response.Skipped) != len(imagebuild.BaseImages) {
		t.Fatalf("expected the unbuildable bases to be reported, got %#v", response.Skipped)
	}
}

func TestRebuildAllImagesFailingBuilderSkipsAll(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveImages(rebuildAllImagesFixtures()); err != nil {
		t.Fatal(err)
	}
	server := &Server{Store: store, ImageBuilder: &imagebuild.Builder{}, Podman: &podman.Client{}, Logger: silentLogger()}
	response, err := server.RebuildAllImages(context.Background(), &ctl.RebuildAllImagesRequest{})
	if err != nil {
		t.Fatalf("build failures must not surface as a gRPC error, got %v", err)
	}
	if len(response.Rebuilt) != 0 {
		t.Fatalf("expected no rebuilt images, got %#v", response.Rebuilt)
	}
	// The base images the builder could not ensure come first, then the custom
	// images and their dependents.
	want := make([]string, 0, len(imagebuild.BaseImages)+2)
	for _, base := range imagebuild.BaseImages {
		want = append(want, base.ID)
	}
	want = append(want, "mid", "top")
	if !sameStrings(response.Skipped, want) {
		t.Fatalf("expected skipped %#v, got %#v", want, response.Skipped)
	}
}

func TestRebuildGraph(t *testing.T) {
	images := []state.Image{
		{ImageID: "a", ImageTag: "tag-a"},
		{ImageID: "b", ImageTag: "tag-b"},
		{ImageID: "c", Parent: "a"},
		{ImageID: "d", Parent: "b"},
		{ImageID: "e", Parent: "a"},
		{ImageID: "f", Parent: "missing"},
		{ImageID: "g"},
	}
	byID, dependents := rebuildGraph(images)
	if len(byID) != 7 {
		t.Fatalf("unexpected byID size: %#v", byID)
	}
	want := map[string][]string{"a": {"c", "e"}, "b": {"d"}}
	if len(dependents) != len(want) {
		t.Fatalf("unexpected dependents: %#v", dependents)
	}
	for owner, deps := range want {
		if !sameStrings(dependents[owner], deps) {
			t.Fatalf("dependents[%q] = %#v, want %#v", owner, dependents[owner], deps)
		}
	}
	if _, ok := dependents["f"]; ok {
		t.Fatalf("unresolvable parent must not create a dependent edge: %#v", dependents)
	}
}

func TestRebuildGraphByIDLastWins(t *testing.T) {
	images := []state.Image{
		{ImageID: "a", ImageTag: "tag-a", Packages: []string{"x"}},
		{ImageID: "a", ImageTag: "tag-a", Packages: []string{"y"}},
	}
	byID, _ := rebuildGraph(images)
	if len(byID["a"].Packages) != 1 || byID["a"].Packages[0] != "y" {
		t.Fatalf("expected last image to win, got %#v", byID["a"])
	}
}

func TestRebuildPlanOrder(t *testing.T) {
	images := append(rebuildAllImagesFixtures(),
		state.Image{ImageID: "unresolvable", Parent: "does-not-exist", ImageTag: "unresolvable:latest"},
	)
	ordered, skipped := rebuildPlan(images)
	wantOrder := []string{"mid", "top"}
	if !sameImageIDs(ordered, wantOrder) {
		t.Fatalf("expected order %#v, got %#v", wantOrder, ordered)
	}
	if !sameStrings(skipped, []string{"unresolvable"}) {
		t.Fatalf("expected unresolvable skipped, got %#v", skipped)
	}
}

func TestRebuildPlanCycleSkipped(t *testing.T) {
	images := []state.Image{
		{ImageID: "cyc-a", Parent: "cyc-b"},
		{ImageID: "cyc-b", Parent: "cyc-a"},
	}
	ordered, skipped := rebuildPlan(images)
	if len(ordered) != 0 {
		t.Fatalf("expected no rebuild candidates for a cycle, got %#v", ordered)
	}
	if !sameStrings(skipped, []string{"cyc-a", "cyc-b"}) {
		t.Fatalf("expected cycle members skipped, got %#v", skipped)
	}
}
