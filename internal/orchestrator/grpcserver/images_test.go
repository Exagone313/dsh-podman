// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	ctl "github.com/Exagone313/dsh-podman/internal/genproto/dshctl/v1"
	imagebuild "github.com/Exagone313/dsh-podman/internal/orchestrator/images"
	"github.com/Exagone313/dsh-podman/internal/orchestrator/podman"
	"github.com/Exagone313/dsh-podman/internal/orchestrator/state"
	"go.podman.io/podman/v6/pkg/bindings"
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
	if len(response.Images) != 5 {
		t.Fatalf("expected 5 images (3 bases + 1 custom + 1 PTC), got %d", len(response.Images))
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
	ptc := response.Images[4]
	if ptc.ImageId != testPTCImageID || ptc.IsBase || ptc.Status != "missing" || ptc.ImageTag != testPTCImageTag || ptc.PackageManager != "apt" {
		t.Fatalf("unexpected PTC row: %#v", ptc)
	}
}

// findListedImage returns the row ListImages reported for imageID.
func findListedImage(t *testing.T, response *ctl.ListImagesResponse, imageID string) *ctl.Image {
	t.Helper()
	for _, image := range response.Images {
		if image.ImageId == imageID {
			return image
		}
	}
	t.Fatalf("image %q is not listed: %#v", imageID, response.Images)
	return nil
}

// TestListImagesCustomImageStatusFromTagSet pins both sides of the batch
// presence check: a record whose tag is in podman is built with its build date,
// and a record whose image was removed behind the orchestrator's back (its tag
// is absent from the set) is missing with no build date.
func TestListImagesCustomImageStatusFromTagSet(t *testing.T) {
	const presentTag = "localhost/dsh-podman/present:latest"
	const removedTag = "localhost/dsh-podman/removed:latest"
	const builtAt = "2026-10-01T00:00:00Z"
	store := newTestStore(t)
	if err := store.SaveImages([]state.Image{
		{ImageID: "present", Parent: "archlinux", PackageManager: "pacman", ImageTag: presentTag, BuiltAt: builtAt},
		{ImageID: "removed", Parent: "archlinux", PackageManager: "pacman", ImageTag: removedTag, BuiltAt: builtAt},
	}); err != nil {
		t.Fatal(err)
	}
	fake := newFakePodman()
	fake.imageTags = map[string]struct{}{presentTag: {}}
	server := &Server{Store: store, Podman: fake, Logger: silentLogger()}
	response, err := server.ListImages(context.Background(), &ctl.ListImagesRequest{})
	if err != nil {
		t.Fatal(err)
	}
	present := findListedImage(t, response, "present")
	if present.Status != "built" || present.BuiltAt != builtAt {
		t.Fatalf("present image must stay built with its build date, got %#v", present)
	}
	removed := findListedImage(t, response, "removed")
	if removed.Status != "missing" || removed.BuiltAt != "" {
		t.Fatalf("removed image must be missing with no build date, got %#v", removed)
	}
}

// TestListImagesFetchesTheTagSetOnce pins that listing any number of records
// costs a single podman list call.
func TestListImagesFetchesTheTagSetOnce(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveImages([]state.Image{
		{ImageID: "one", ImageTag: "localhost/dsh-podman/one:latest"},
		{ImageID: "two", ImageTag: "localhost/dsh-podman/two:latest"},
		{ImageID: "three", ImageTag: "localhost/dsh-podman/three:latest"},
	}); err != nil {
		t.Fatal(err)
	}
	fake := newFakePodman()
	fake.imageTags = map[string]struct{}{}
	server := &Server{Store: store, Podman: fake, Logger: silentLogger()}
	if _, err := server.ListImages(context.Background(), &ctl.ListImagesRequest{}); err != nil {
		t.Fatal(err)
	}
	if fake.imageTagSetCalls != 1 {
		t.Fatalf("expected one batch tag read, got %d", fake.imageTagSetCalls)
	}
}

// TestListImagesTagSetFailureFallsBackToPerRecordChecks pins the transient
// failure mode: when the batch list fails, each record is probed with
// ImageExists, so a genuine absence is still detected and a present image is
// not reported missing just because the list call failed.
func TestListImagesTagSetFailureFallsBackToPerRecordChecks(t *testing.T) {
	const presentTag = "localhost/dsh-podman/present:latest"
	const removedTag = "localhost/dsh-podman/removed:latest"
	const builtAt = "2026-10-01T00:00:00Z"
	store := newTestStore(t)
	if err := store.SaveImages([]state.Image{
		{ImageID: "present", ImageTag: presentTag, BuiltAt: builtAt},
		{ImageID: "removed", ImageTag: removedTag, BuiltAt: builtAt},
	}); err != nil {
		t.Fatal(err)
	}
	fake := newFakePodman()
	fake.imageTagSetErr = errors.New("podman list failed")
	fake.images = map[string]bool{presentTag: true, removedTag: false}
	server := &Server{Store: store, Podman: fake, Logger: silentLogger()}
	response, err := server.ListImages(context.Background(), &ctl.ListImagesRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if present := findListedImage(t, response, "present"); present.Status != "built" || present.BuiltAt != builtAt {
		t.Fatalf("a failed batch list must not hide a present image, got %#v", present)
	}
	if removed := findListedImage(t, response, "removed"); removed.Status != "missing" || removed.BuiltAt != "" {
		t.Fatalf("a failed batch list must still detect a genuine absence, got %#v", removed)
	}
}

// TestListImagesBaseStatusIsUnaffectedByTheTagSet pins that base rows keep
// their own per-tag probe: the batch set only describes custom records.
func TestListImagesBaseStatusIsUnaffectedByTheTagSet(t *testing.T) {
	fake := newFakePodman()
	fake.images = map[string]bool{"localhost/dsh-podman/base/archlinux:latest": true}
	fake.imageTags = map[string]struct{}{}
	server := &Server{Store: newTestStore(t), Podman: fake, Logger: silentLogger()}
	response, err := server.ListImages(context.Background(), &ctl.ListImagesRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if archlinux := findListedImage(t, response, "archlinux"); !archlinux.IsBase || archlinux.Status != "built" {
		t.Fatalf("a present base must stay built, got %#v", archlinux)
	}
	if ubuntu := findListedImage(t, response, "ubuntu"); !ubuntu.IsBase || ubuntu.Status != "missing" {
		t.Fatalf("an absent base must stay missing, got %#v", ubuntu)
	}
}

func TestListImagesReportsThePTCImageStatus(t *testing.T) {
	store := newTestStore(t)
	fake := newFakePodman()
	fake.images = map[string]bool{}
	server := &Server{Store: store, Podman: fake, Logger: silentLogger()}
	response, err := server.ListImages(context.Background(), &ctl.ListImagesRequest{})
	if err != nil {
		t.Fatal(err)
	}
	index := -1
	for i, image := range response.Images {
		if image.ImageId == testPTCImageID {
			index = i
		}
	}
	if index < 0 {
		t.Fatalf("the PTC image is not listed: %#v", response.Images)
	}
	if got := response.Images[index].Status; got != "missing" {
		t.Fatalf("expected a missing PTC image, got %q", got)
	}
	seedPTCImage(fake, ptcImageLabels(t, testDSHVersion))
	response, err = server.ListImages(context.Background(), &ctl.ListImagesRequest{})
	if err != nil {
		t.Fatal(err)
	}
	for _, image := range response.Images {
		if image.ImageId == testPTCImageID && image.Status != "built" {
			t.Fatalf("expected a built PTC image, got %q", image.Status)
		}
	}
}

func (f *fakePodman) ImageExists(name string) (bool, error) {
	if f.images == nil {
		return true, nil
	}
	return f.images[name], nil
}

func (f *fakePodman) ImageTags() (map[string]struct{}, error) {
	f.imageTagSetCalls++
	if f.imageTagSetErr != nil {
		return nil, f.imageTagSetErr
	}
	// A nil set means the fake was not seeded with one: returning it as-is
	// makes callers fall back to per-record ImageExists, which preserves the
	// double's unconditional presence for tests that do not care about tags.
	return f.imageTags, nil
}

func (f *fakePodman) ImageLabels(name string) (map[string]string, error) {
	return f.imageLabels[name], nil
}

func (f *fakePodman) ImageCreated(string) string { return "" }

func (f *fakePodman) ImagePull(name string) error {
	f.pulled = append(f.pulled, name)
	return f.pullErr
}

func (f *fakePodman) ImageRemove(name string) error {
	f.removedImages = append(f.removedImages, name)
	if f.imageRemoveErr != nil {
		return f.imageRemoveErr
	}
	delete(f.images, name)
	return nil
}

func sliceContains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

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

// TestGetImageCustomImageProbesPodman pins that a single custom-image lookup
// reports the tag's real presence too, so image_get agrees with the listing.
func TestGetImageCustomImageProbesPodman(t *testing.T) {
	const tag = "localhost/dsh-podman/removed:latest"
	store := newTestStore(t)
	if err := store.SaveImages([]state.Image{{ImageID: "removed", Parent: "archlinux", PackageManager: "pacman", ImageTag: tag, BuiltAt: "2026-10-01T00:00:00Z"}}); err != nil {
		t.Fatal(err)
	}
	fake := newFakePodman()
	fake.images = map[string]bool{tag: false}
	server := &Server{Store: store, Podman: fake, Logger: silentLogger()}
	image, err := server.GetImage(context.Background(), &ctl.GetImageRequest{ImageId: "removed"})
	if err != nil {
		t.Fatal(err)
	}
	if image.Status != "missing" || image.BuiltAt != "" {
		t.Fatalf("a removed custom image must be missing with no build date, got %#v", image)
	}
	fake.images[tag] = true
	image, err = server.GetImage(context.Background(), &ctl.GetImageRequest{ImageId: "removed"})
	if err != nil {
		t.Fatal(err)
	}
	if image.Status != "built" || image.BuiltAt != "2026-10-01T00:00:00Z" {
		t.Fatalf("a present custom image must be built with its build date, got %#v", image)
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

// buildAPIContext starts a fake Podman API that accepts one build and returns
// a context connected to it, so a test can drive a real custom image build.
func buildAPIContext(t *testing.T) context.Context {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"stream":"built\n"}`)
	}))
	t.Cleanup(server.Close)
	ctx, err := bindings.NewConnection(context.Background(), "tcp://"+server.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	return ctx
}

// TestBuildImageRejectsPtcParent pins that the reserved PTC image is refused as
// a custom image's parent in every spelling a caller can use: the logical id,
// a short tag, and a fully-qualified tag under the default or a configured
// image prefix.
func TestBuildImageRejectsPtcParent(t *testing.T) {
	server := &Server{
		Store:        newTestStore(t),
		ImageBuilder: &imagebuild.Builder{ImagePrefix: "registry.example.com/custom/"},
		Logger:       silentLogger(),
	}
	parents := []string{
		"ptc",
		"ptc:latest",
		"localhost/dsh-podman/ptc",
		"localhost/dsh-podman/ptc:latest",
		"registry.example.com/custom/ptc:latest",
	}
	for _, parent := range parents {
		_, err := server.BuildImage(context.Background(), &ctl.BuildImageRequest{ImageId: "dev", Parent: parent})
		if status.Code(err) != codes.InvalidArgument {
			t.Errorf("parent %q: expected InvalidArgument, got %v", parent, err)
			continue
		}
		message := status.Convert(err).Message()
		if !strings.Contains(message, "reserved") || !strings.Contains(message, "ptc") {
			t.Errorf("parent %q: message must name the reserved PTC image, got %q", parent, message)
		}
	}
	// A different image under the same prefixes is not the reserved one.
	for _, parent := range []string{"archlinux", "registry.example.com/custom/dev:latest", "localhost/dsh-podman/dev:latest"} {
		if server.isPtcParent(parent) {
			t.Errorf("parent %q must not be mistaken for the reserved PTC image", parent)
		}
	}
}

// TestPtcParentIgnoresRegistryPort pins that a colon in the registry host is
// not read as a tag, so another image under that registry is not confused with
// the reserved PTC one.
func TestPtcParentIgnoresRegistryPort(t *testing.T) {
	server := &Server{
		ImageBuilder: &imagebuild.Builder{ImagePrefix: "registry.example.com:5000/custom/"},
		Logger:       silentLogger(),
	}
	if server.isPtcParent("registry.example.com:5000/custom/dev:latest") {
		t.Fatal("a different image under a ported registry must not be the PTC image")
	}
	if !server.isPtcParent("registry.example.com:5000/custom/ptc:latest") {
		t.Fatal("the PTC image under a ported registry must be refused")
	}
}

// TestBuildImageAcceptsNormalParent pins that a base image is still a valid
// parent, so the new refusal does not narrow the normal build path.
func TestBuildImageAcceptsNormalParent(t *testing.T) {
	fake := newFakePodman()
	fake.images = map[string]bool{"localhost/dsh-podman/base/archlinux:latest": true}
	server := &Server{
		Store:        newTestStore(t),
		Podman:       fake,
		ImageBuilder: &imagebuild.Builder{Context: buildAPIContext(t)},
		Logger:       silentLogger(),
	}
	image, err := server.BuildImage(context.Background(), &ctl.BuildImageRequest{ImageId: "dev", Parent: "archlinux", Packages: []string{"git"}})
	if err != nil {
		t.Fatalf("a base image must remain an accepted parent: %v", err)
	}
	if image.ImageId != "dev" || image.Parent != "archlinux" || image.Status != "built" || len(image.Packages) != 1 || image.Packages[0] != "git" {
		t.Fatalf("unexpected built image: %#v", image)
	}
	stored, err := server.Store.Images()
	if err != nil {
		t.Fatal(err)
	}
	if len(stored) != 1 || stored[0].ImageID != "dev" || stored[0].Parent != "archlinux" {
		t.Fatalf("unexpected stored images: %#v", stored)
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

// TestRebuildImageToleratesAnAbsentPodmanImage pins the rebuild side of the
// same concern: a stored image whose podman tag is gone is still rebuildable.
// The build replaces the tag, so resolution must not turn the missing presence
// into NotFound; it proceeds to the builder like a present image.
func TestRebuildImageToleratesAnAbsentPodmanImage(t *testing.T) {
	const tag = "localhost/dsh-podman/gone:latest"
	store := newTestStore(t)
	if err := store.SaveImages([]state.Image{
		{ImageID: "mid", PackageManager: "pacman", ImageTag: "localhost/dsh-podman/mid:latest"},
		{ImageID: "gone", Parent: "mid", PackageManager: "pacman", ImageTag: tag},
	}); err != nil {
		t.Fatal(err)
	}
	fake := newFakePodman()
	fake.images = map[string]bool{tag: false}
	server := &Server{Store: store, Podman: fake, ImageBuilder: &imagebuild.Builder{}, Logger: silentLogger()}
	_, err := server.RebuildImage(context.Background(), &ctl.RebuildImageRequest{ImageId: "gone"})
	if status.Code(err) == codes.NotFound {
		t.Fatalf("a missing podman image must still resolve to its stored record: %v", err)
	}
	if status.Code(err) != codes.Internal {
		t.Fatalf("expected the build to run, stopping at the unconfigured builder (Internal), got %v", err)
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

// TestRemoveImageToleratesAnAbsentPodmanImage pins the reported bug: a record
// outlives the podman image removed with "podman rmi", and removing that stale
// row must succeed, drop the record, and stop listing it, instead of failing
// with an internal error.
func TestRemoveImageToleratesAnAbsentPodmanImage(t *testing.T) {
	const tag = "localhost/dsh-podman/gone:latest"
	store := newTestStore(t)
	if err := store.SaveImages([]state.Image{{ImageID: "gone", Parent: "archlinux", PackageManager: "pacman", ImageTag: tag, BuiltAt: "2026-10-01T00:00:00Z"}}); err != nil {
		t.Fatal(err)
	}
	fake := newFakePodman()
	fake.images = map[string]bool{tag: false}
	fake.imageRemoveErr = errors.New(tag + ": image not known")
	server := &Server{Store: store, Podman: fake, Logger: silentLogger()}
	if _, err := server.RemoveImage(context.Background(), &ctl.RemoveImageRequest{ImageId: "gone"}); err != nil {
		t.Fatalf("removing a record whose podman image is gone must succeed: %v", err)
	}
	images, err := store.Images()
	if err != nil {
		t.Fatal(err)
	}
	if len(images) != 0 {
		t.Fatalf("the stale record must be dropped, got %#v", images)
	}
	response, err := server.ListImages(context.Background(), &ctl.ListImagesRequest{})
	if err != nil {
		t.Fatal(err)
	}
	for _, image := range response.Images {
		if image.ImageId == "gone" {
			t.Fatalf("a removed record must no longer be listed: %#v", image)
		}
	}
}

// TestRemoveImageSurfacesThePodmanFailure pins that only a not-known answer is
// tolerated: a genuine removal failure keeps a code the caller can act on and
// the podman cause in its message, so the sanitizing interceptor cannot flatten
// it into the generic "internal error". The record must survive a failed
// removal.
func TestRemoveImageSurfacesThePodmanFailure(t *testing.T) {
	const tag = "localhost/dsh-podman/valkey:latest"
	cases := []struct {
		name string
		err  error
		code codes.Code
		want []string
	}{
		{"in use", errors.New(tag + ": image is in use by a container"), codes.FailedPrecondition, []string{`image "valkey" is in use`, "image is in use by a container"}},
		{"permission", errors.New(tag + ": permission denied"), codes.PermissionDenied, []string{`cannot remove image "valkey"`, "permission denied"}},
		{"daemon", errors.New("cannot connect to Podman socket: connection refused"), codes.Unavailable, []string{`cannot remove image "valkey"`, "connection refused"}},
		{"state", errors.New(tag + ": image store is read-only"), codes.FailedPrecondition, []string{`cannot remove image "valkey"`, "image store is read-only"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			store := newTestStore(t)
			if err := store.SaveImages([]state.Image{{ImageID: "valkey", PackageManager: "pacman", ImageTag: tag}}); err != nil {
				t.Fatal(err)
			}
			fake := newFakePodman()
			fake.imageRemoveErr = tc.err
			server := &Server{Store: store, Podman: fake, Logger: silentLogger()}
			_, err := server.RemoveImage(context.Background(), &ctl.RemoveImageRequest{ImageId: "valkey"})
			if status.Code(err) != tc.code {
				t.Fatalf("expected %v, got %v", tc.code, err)
			}
			for _, want := range tc.want {
				if !strings.Contains(err.Error(), want) {
					t.Fatalf("error %q does not contain %q", err, want)
				}
			}
			images, readErr := store.Images()
			if readErr != nil {
				t.Fatal(readErr)
			}
			if len(images) != 1 || images[0].ImageID != "valkey" {
				t.Fatalf("a refused removal must keep the record, got %#v", images)
			}
		})
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
	// No custom image exists, but the unusable podman connection still reports
	// every base whose availability could not be checked, instead of logging
	// the failure only.
	if len(response.Skipped) != len(imagebuild.BaseImages) {
		t.Fatalf("expected the uncheckable bases to be reported, got %#v", response.Skipped)
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
	// The base images whose availability could not be checked come first, then
	// the custom images and their dependents (skipped because their base
	// failed, not by a runtime build failure).
	want := make([]string, 0, len(imagebuild.BaseImages)+2)
	for _, base := range imagebuild.BaseImages {
		want = append(want, base.ID)
	}
	want = append(want, "mid", "top")
	if !sameStrings(response.Skipped, want) {
		t.Fatalf("expected skipped %#v, got %#v", want, response.Skipped)
	}
}

func TestRebuildAllRebuildsOnlyPresentBases(t *testing.T) {
	store := newTestStore(t)
	podman := newFakePodman()
	server := &Server{Store: store, Podman: podman, ImageBuilder: &imagebuild.Builder{}, Logger: silentLogger()}
	// archlinux exists locally; ubuntu and alpine were never built.
	podman.images = map[string]bool{
		server.baseTag("archlinux"): true,
		server.baseTag("ubuntu"):    false,
		server.baseTag("alpine"):    false,
	}
	response, err := server.RebuildAllImages(context.Background(), &ctl.RebuildAllImagesRequest{})
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	// The present base's primitive is pulled before its (failing) rebuild.
	if !sliceContains(podman.pulled, "docker.io/library/archlinux:latest") {
		t.Fatalf("expected the archlinux primitive to be pulled before its rebuild, got %#v", podman.pulled)
	}
	// Missing bases are neither pulled nor rebuilt by the base pass.
	if sliceContains(podman.pulled, "docker.io/library/ubuntu:latest") ||
		sliceContains(podman.pulled, "docker.io/library/alpine:latest") {
		t.Fatalf("missing bases must not be pulled, got %#v", podman.pulled)
	}
	if !sameStrings(response.Skipped, []string{"archlinux"}) {
		t.Fatalf("expected only the failed base rebuild reported, got %#v", response.Skipped)
	}
}

func TestRebuildAllMissingBasesAreLeftAlone(t *testing.T) {
	podman := newFakePodman()
	server := &Server{Store: newTestStore(t), Podman: podman, ImageBuilder: &imagebuild.Builder{}, Logger: silentLogger()}
	podman.images = map[string]bool{
		server.baseTag("archlinux"): false,
		server.baseTag("ubuntu"):    false,
		server.baseTag("alpine"):    false,
	}
	response, err := server.RebuildAllImages(context.Background(), &ctl.RebuildAllImagesRequest{})
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if len(podman.pulled) != 0 {
		t.Fatalf("missing bases must not be pulled, got %#v", podman.pulled)
	}
	if len(response.Rebuilt) != 0 || len(response.Skipped) != 0 {
		t.Fatalf("expected no activity for missing bases, got rebuilt=%#v skipped=%#v", response.Rebuilt, response.Skipped)
	}
}

func TestRebuildAllRebuildsCustomImagesWhoseBaseParentIsMissing(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveImages([]state.Image{{
		ImageID: "dev", Parent: "archlinux", PackageManager: "pacman", ImageTag: "localhost/dsh-podman/dev:latest",
	}}); err != nil {
		t.Fatal(err)
	}
	podman := newFakePodman()
	server := &Server{Store: store, Podman: podman, ImageBuilder: &imagebuild.Builder{}, Logger: silentLogger()}
	podman.images = map[string]bool{
		server.baseTag("archlinux"): false,
	}
	response, err := server.RebuildAllImages(context.Background(), &ctl.RebuildAllImagesRequest{})
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	// The custom image is still rebuilt even though its base parent is missing:
	// the parent is provisioned on demand, and the failing builder reports the
	// custom image in skipped. The missing base itself is not reported.
	if !sameStrings(response.Skipped, []string{"dev"}) {
		t.Fatalf("expected the custom image attempted and reported, got %#v", response.Skipped)
	}
	if len(podman.pulled) != 0 {
		t.Fatalf("the base pass must not pull a missing base, got %#v", podman.pulled)
	}
}

func TestRebuildBaseImagePullsPrimitive(t *testing.T) {
	podman := newFakePodman()
	server := &Server{Store: newTestStore(t), Podman: podman, ImageBuilder: &imagebuild.Builder{}, Logger: silentLogger()}
	_, err := server.RebuildBaseImage(context.Background(), &ctl.RebuildBaseImageRequest{Name: "archlinux"})
	if status.Code(err) != codes.Internal {
		t.Fatalf("expected the build to fail on the unusable builder, got %v", err)
	}
	if !sliceContains(podman.pulled, "docker.io/library/archlinux:latest") {
		t.Fatalf("expected the primitive to be pulled before the rebuild, got %#v", podman.pulled)
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
	ordered, skipped := rebuildPlan(images, nil)
	wantOrder := []string{"mid", "top"}
	if !sameImageIDs(ordered, wantOrder) {
		t.Fatalf("expected order %#v, got %#v", wantOrder, ordered)
	}
	if !sameStrings(skipped, []string{"unresolvable"}) {
		t.Fatalf("expected unresolvable skipped, got %#v", skipped)
	}
}

func TestRebuildPlanFailedBaseSkipsDependents(t *testing.T) {
	images := rebuildAllImagesFixtures() // mid -> archlinux, top -> mid
	ordered, skipped := rebuildPlan(images, map[string]bool{"archlinux": true})
	if len(ordered) != 0 {
		t.Fatalf("expected no rebuild candidates under a failed base, got %#v", ordered)
	}
	if !sameStrings(skipped, []string{"mid", "top"}) {
		t.Fatalf("expected the failed base's dependents skipped, got %#v", skipped)
	}
	// A base that merely does not exist is not failed: it is provisioned on
	// demand, so its dependents are still ordered.
	ordered, skipped = rebuildPlan(images, map[string]bool{})
	if !sameImageIDs(ordered, []string{"mid", "top"}) {
		t.Fatalf("expected dependents ordered under a missing base, got %#v", ordered)
	}
	if len(skipped) != 0 {
		t.Fatalf("expected nothing skipped under a missing base, got %#v", skipped)
	}
}

func TestRebuildAllFailedBaseSkipsDescendants(t *testing.T) {
	store := newTestStore(t)
	if err := store.SaveImages(rebuildAllImagesFixtures()); err != nil {
		t.Fatal(err)
	}
	podman := newFakePodman()
	server := &Server{Store: store, Podman: podman, ImageBuilder: &imagebuild.Builder{}, Logger: silentLogger()}
	// archlinux exists locally, so the base pass rebuilds it; the unusable
	// builder fails that rebuild, and both dependents must be skipped with it.
	podman.images = map[string]bool{
		server.baseTag("archlinux"): true,
	}
	response, err := server.RebuildAllImages(context.Background(), &ctl.RebuildAllImagesRequest{})
	if err != nil {
		t.Fatalf("expected no error, got %v", err)
	}
	if len(response.Rebuilt) != 0 {
		t.Fatalf("expected no rebuilt images, got %#v", response.Rebuilt)
	}
	if !sameStrings(response.Skipped, []string{"archlinux", "mid", "top"}) {
		t.Fatalf("expected the failed base and its dependents skipped, got %#v", response.Skipped)
	}
}

func TestRebuildPlanCycleSkipped(t *testing.T) {
	images := []state.Image{
		{ImageID: "cyc-a", Parent: "cyc-b"},
		{ImageID: "cyc-b", Parent: "cyc-a"},
	}
	ordered, skipped := rebuildPlan(images, nil)
	if len(ordered) != 0 {
		t.Fatalf("expected no rebuild candidates for a cycle, got %#v", ordered)
	}
	if !sameStrings(skipped, []string{"cyc-a", "cyc-b"}) {
		t.Fatalf("expected cycle members skipped, got %#v", skipped)
	}
}

// ptcRebuildServer builds a server whose stored-image builds use the real
// builder (and fail on its unconfigured context, which no PTC test triggers)
// and whose PTC builds are recorded by the fake. The fake podman starts with no
// image at all, so a base pass skips every missing base.
func ptcRebuildServer(t *testing.T) (*Server, *fakePodman, *fakePTCImages) {
	t.Helper()
	fake := newFakePodman()
	fake.images = map[string]bool{}
	images := &fakePTCImages{}
	return &Server{Store: newTestStore(t), Podman: fake, ImageBuilder: &imagebuild.Builder{}, PTCImages: images, Logger: silentLogger()}, fake, images
}

// assertBuiltPTCImage pins the row a PTC build reports: the single tag, the Node
// primitive it builds from, and the apt package manager.
func assertBuiltPTCImage(t *testing.T, image *ctl.Image) {
	t.Helper()
	if image.ImageId != testPTCImageID || image.IsBase || image.Status != "built" || image.ImageTag != testPTCImageTag || image.Parent != imagebuild.PTCBasePrimitive || image.PackageManager != "apt" {
		t.Fatalf("unexpected rebuilt PTC image: %#v", image)
	}
}

func TestRebuildImageBuildsMissingPTCImage(t *testing.T) {
	server, fake, images := ptcRebuildServer(t)
	if exists, _ := fake.ImageExists(testPTCImageTag); exists {
		t.Fatal("the fixture must start without a PTC image")
	}
	image, err := server.RebuildImage(context.Background(), &ctl.RebuildImageRequest{ImageId: testPTCImageID, DshVersion: testDSHVersion})
	if err != nil {
		t.Fatal(err)
	}
	assertBuiltPTCImage(t, image)
	if !sameStrings(images.builds, []string{testDSHVersion}) {
		t.Fatalf("expected one PTC build for %q, got %v", testDSHVersion, images.builds)
	}
}

// TestRebuildImagePullsPTCBaseBeforeBuilding pins that a PTC rebuild refreshes
// the Node primitive first, exactly like a base rebuild, instead of relying on
// the builder's implicit pull-if-missing: the pull is already recorded when the
// build starts.
func TestRebuildImagePullsPTCBaseBeforeBuilding(t *testing.T) {
	server, fake, images := ptcRebuildServer(t)
	var pulledAtBuild []string
	images.onBuild = func() { pulledAtBuild = append([]string(nil), fake.pulled...) }
	if _, err := server.RebuildImage(context.Background(), &ctl.RebuildImageRequest{ImageId: testPTCImageID, DshVersion: testDSHVersion}); err != nil {
		t.Fatal(err)
	}
	if !sameStrings(fake.pulled, []string{imagebuild.PTCBasePrimitive}) {
		t.Fatalf("expected the PTC base to be pulled, got %#v", fake.pulled)
	}
	if !sameStrings(pulledAtBuild, []string{imagebuild.PTCBasePrimitive}) {
		t.Fatalf("the pull must happen before the build, got pulled=%#v at build time", pulledAtBuild)
	}
}

// TestRebuildImagePTCFailsWhenBasePullFails pins that a failed primitive pull
// fails the rebuild with that error and never starts a build.
func TestRebuildImagePTCFailsWhenBasePullFails(t *testing.T) {
	server, fake, images := ptcRebuildServer(t)
	fake.pullErr = errors.New("registry unreachable")
	_, err := server.RebuildImage(context.Background(), &ctl.RebuildImageRequest{ImageId: testPTCImageID, DshVersion: testDSHVersion})
	if status.Code(err) != codes.Internal {
		t.Fatalf("expected Internal, got %v", err)
	}
	message := status.Convert(err).Message()
	for _, want := range []string{"cannot pull the PTC base image", imagebuild.PTCBasePrimitive, "registry unreachable"} {
		if !strings.Contains(message, want) {
			t.Fatalf("expected the pull error to mention %q, got %q", want, message)
		}
	}
	if !sameStrings(fake.pulled, []string{imagebuild.PTCBasePrimitive}) {
		t.Fatalf("expected one pull attempt, got %#v", fake.pulled)
	}
	if len(images.builds) != 0 {
		t.Fatalf("a failed pull must not build, got %v", images.builds)
	}
}

func TestRebuildImageRebuildsPresentPTCImage(t *testing.T) {
	server, fake, images := ptcRebuildServer(t)
	// Seed an image whose labels already match: RebuildImage must still build,
	// replacing the one tag unconditionally.
	seedPTCImage(fake, ptcImageLabels(t, testDSHVersion))
	image, err := server.RebuildImage(context.Background(), &ctl.RebuildImageRequest{ImageId: testPTCImageID, DshVersion: testDSHVersion})
	if err != nil {
		t.Fatal(err)
	}
	assertBuiltPTCImage(t, image)
	if !sameStrings(images.builds, []string{testDSHVersion}) {
		t.Fatalf("a present PTC image must be rebuilt, got builds %v", images.builds)
	}
	if !sameStrings(fake.pulled, []string{imagebuild.PTCBasePrimitive}) {
		t.Fatalf("a present PTC image must still pull its base, got %#v", fake.pulled)
	}
}

func TestRebuildImagePTCRejectsMissingOrInvalidVersion(t *testing.T) {
	server, _, images := ptcRebuildServer(t)
	for _, version := range []string{"", "Bad Version", "0.2.1;rm", "0.2.1 rc"} {
		_, err := server.RebuildImage(context.Background(), &ctl.RebuildImageRequest{ImageId: testPTCImageID, DshVersion: version})
		if status.Code(err) != codes.InvalidArgument {
			t.Errorf("version %q: expected InvalidArgument, got %v", version, err)
		}
	}
	if len(images.builds) != 0 {
		t.Fatalf("a refused version must not build, got %v", images.builds)
	}
}

func TestRebuildImagePTCNeverTouchesTheContainer(t *testing.T) {
	server, fake, images := ptcServerWithImages(t)
	fake.images = map[string]bool{}
	if _, err := server.EnsureContainer(context.Background(), ptcRequest(testDSHVersion)); err != nil {
		t.Fatal(err)
	}
	before := storedPTC(t, server)
	creates := len(fake.ptcCreates)
	// The ensure built the image once; the rebuild must add exactly one build.
	if len(images.builds) != 1 {
		t.Fatalf("expected the ensure's build, got %v", images.builds)
	}
	if _, err := server.RebuildImage(context.Background(), &ctl.RebuildImageRequest{ImageId: testPTCImageID, DshVersion: testOtherDSHVersion}); err != nil {
		t.Fatal(err)
	}
	if !sameStrings(images.builds, []string{testDSHVersion, testOtherDSHVersion}) {
		t.Fatalf("expected the rebuild to build for the other release, got %v", images.builds)
	}
	if !sameStrings(fake.pulled, []string{imagebuild.PTCBasePrimitive}) {
		t.Fatalf("the rebuild must pull its base, got %#v", fake.pulled)
	}
	after := storedPTC(t, server)
	if !reflect.DeepEqual(before, after) {
		t.Fatalf("the container record changed: before %#v, after %#v", before, after)
	}
	if len(fake.ptcCreates) != creates {
		t.Fatalf("the rebuild created a container: %#v", fake.ptcCreates)
	}
	if len(fake.removed) != 0 {
		t.Fatalf("the rebuild removed a container: %#v", fake.removed)
	}
}

func TestRebuildAllImagesWithVersionBuildsMissingPTCImage(t *testing.T) {
	server, fake, images := ptcRebuildServer(t)
	var pulledAtBuild []string
	images.onBuild = func() { pulledAtBuild = append([]string(nil), fake.pulled...) }
	response, err := server.RebuildAllImages(context.Background(), &ctl.RebuildAllImagesRequest{DshVersion: testDSHVersion})
	if err != nil {
		t.Fatal(err)
	}
	if !sameStrings(images.builds, []string{testDSHVersion}) {
		t.Fatalf("expected one PTC build for %q, got %v", testDSHVersion, images.builds)
	}
	if !sameStrings(pulledAtBuild, []string{imagebuild.PTCBasePrimitive}) {
		t.Fatalf("the pull must happen before the build, got pulled=%#v at build time", pulledAtBuild)
	}
	if !sliceContains(response.Rebuilt, testPTCImageID) {
		t.Fatalf("expected the PTC image in rebuilt, got %#v", response.Rebuilt)
	}
}

// TestRebuildAllImagesPTCFailsWhenBasePullFails pins that a failed primitive
// pull leaves the PTC image in skipped and never starts its build, like any
// other PTC rebuild failure.
func TestRebuildAllImagesPTCFailsWhenBasePullFails(t *testing.T) {
	server, fake, images := ptcRebuildServer(t)
	fake.pullErr = errors.New("registry unreachable")
	response, err := server.RebuildAllImages(context.Background(), &ctl.RebuildAllImagesRequest{DshVersion: testDSHVersion})
	if err != nil {
		t.Fatal(err)
	}
	if !sliceContains(response.Skipped, testPTCImageID) {
		t.Fatalf("expected the PTC image in skipped, got %#v", response.Skipped)
	}
	if sliceContains(response.Rebuilt, testPTCImageID) {
		t.Fatalf("the PTC image must not be rebuilt, got %#v", response.Rebuilt)
	}
	if len(images.builds) != 0 {
		t.Fatalf("a failed pull must not build, got %v", images.builds)
	}
	if !sameStrings(fake.pulled, []string{imagebuild.PTCBasePrimitive}) {
		t.Fatalf("expected one pull attempt, got %#v", fake.pulled)
	}
}

func TestRebuildAllImagesWithVersionRebuildsPresentPTCImage(t *testing.T) {
	server, fake, images := ptcRebuildServer(t)
	seedPTCImage(fake, ptcImageLabels(t, testDSHVersion))
	response, err := server.RebuildAllImages(context.Background(), &ctl.RebuildAllImagesRequest{DshVersion: testDSHVersion})
	if err != nil {
		t.Fatal(err)
	}
	if !sameStrings(images.builds, []string{testDSHVersion}) {
		t.Fatalf("a present PTC image must be rebuilt, got builds %v", images.builds)
	}
	if !sameStrings(fake.pulled, []string{imagebuild.PTCBasePrimitive}) {
		t.Fatalf("a present PTC image must still pull its base, got %#v", fake.pulled)
	}
	if !sliceContains(response.Rebuilt, testPTCImageID) {
		t.Fatalf("expected the PTC image in rebuilt, got %#v", response.Rebuilt)
	}
}

func TestRebuildAllImagesWithoutVersionLeavesPTCAlone(t *testing.T) {
	server, fake, images := ptcRebuildServer(t)
	seedPTCImage(fake, ptcImageLabels(t, testDSHVersion))
	response, err := server.RebuildAllImages(context.Background(), &ctl.RebuildAllImagesRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if len(images.builds) != 0 {
		t.Fatalf("an empty version must leave the PTC image untouched, got builds %v", images.builds)
	}
	if sliceContains(response.Rebuilt, testPTCImageID) || sliceContains(response.Skipped, testPTCImageID) {
		t.Fatalf("the PTC image must not be reported, got rebuilt=%#v skipped=%#v", response.Rebuilt, response.Skipped)
	}
}

func TestRebuildAllImagesPTCNeverTouchesTheContainer(t *testing.T) {
	server, fake, images := ptcServerWithImages(t)
	server.ImageBuilder = &imagebuild.Builder{}
	fake.images = map[string]bool{}
	if _, err := server.EnsureContainer(context.Background(), ptcRequest(testDSHVersion)); err != nil {
		t.Fatal(err)
	}
	before := storedPTC(t, server)
	creates := len(fake.ptcCreates)
	if _, err := server.RebuildAllImages(context.Background(), &ctl.RebuildAllImagesRequest{DshVersion: testOtherDSHVersion}); err != nil {
		t.Fatal(err)
	}
	if !sameStrings(images.builds, []string{testDSHVersion, testOtherDSHVersion}) {
		t.Fatalf("expected the rebuild to build for the other release, got %v", images.builds)
	}
	if !sameStrings(fake.pulled, []string{imagebuild.PTCBasePrimitive}) {
		t.Fatalf("the rebuild must pull its base, got %#v", fake.pulled)
	}
	after := storedPTC(t, server)
	if !reflect.DeepEqual(before, after) {
		t.Fatalf("the container record changed: before %#v, after %#v", before, after)
	}
	if len(fake.ptcCreates) != creates {
		t.Fatalf("the rebuild created a container: %#v", fake.ptcCreates)
	}
	if len(fake.removed) != 0 {
		t.Fatalf("the rebuild removed a container: %#v", fake.removed)
	}
}

func TestRebuildAllImagesRejectsInvalidPTCVersion(t *testing.T) {
	server, _, images := ptcRebuildServer(t)
	_, err := server.RebuildAllImages(context.Background(), &ctl.RebuildAllImagesRequest{DshVersion: "not a version"})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("expected InvalidArgument, got %v", err)
	}
	if len(images.builds) != 0 {
		t.Fatalf("a refused version must not build, got %v", images.builds)
	}
}
