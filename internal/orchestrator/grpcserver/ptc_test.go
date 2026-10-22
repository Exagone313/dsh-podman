// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"context"
	"errors"
	"strings"
	"testing"

	ctl "github.com/Exagone313/dsh-podman/internal/genproto/dshctl/v1"
	imagebuild "github.com/Exagone313/dsh-podman/internal/orchestrator/images"
	"github.com/Exagone313/dsh-podman/internal/orchestrator/state"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// ptcCreate is the input of one fake CreatePTC call.
type ptcCreate struct {
	name, image, token string
}

func (f *fakePodman) CreatePTC(name, image, token string) error {
	if f.ptcErr != nil {
		return f.ptcErr
	}
	f.ptcCreates = append(f.ptcCreates, ptcCreate{name: name, image: image, token: token})
	f.created = append(f.created, name)
	f.exists[name] = true
	f.running[name] = true
	f.agentToken[name] = token
	return nil
}

const (
	testPTCContainer    = "dsh-podman-ptc"
	testDSHVersion      = "0.0.0"
	testOtherDSHVersion = "0.0.1"
	testPTCImageID      = "ptc"
	testPTCImageTag     = "localhost/dsh-podman/ptc:latest"
)

// ptcImageLabels returns the labels the PTC image must carry for a harness
// release, so a test can seed the fake podman's image as current or stale.
func ptcImageLabels(t *testing.T, dshVersion string) map[string]string {
	t.Helper()
	labels, err := imagebuild.PTCImageLabels(dshVersion)
	if err != nil {
		t.Fatal(err)
	}
	return labels
}

// seedPTCImage records the single PTC image as present with the given labels.
func seedPTCImage(fake *fakePodman, labels map[string]string) {
	if fake.images == nil {
		fake.images = map[string]bool{}
	}
	if fake.imageLabels == nil {
		fake.imageLabels = map[string]map[string]string{}
	}
	tag := (&imagebuild.Builder{}).PTCImageTag()
	fake.images[tag] = true
	fake.imageLabels[tag] = labels
}

// fakePTCImages is the PTC image-builder double: it records every build and
// reuses the real deterministic tag computation.
type fakePTCImages struct {
	builds   []string
	buildErr error
	// onBuild, when set, runs as a build starts, so a test can observe what
	// had already happened (for example the base pull) at that point.
	onBuild func()
}

func (f *fakePTCImages) PTCImageTag() string {
	return (&imagebuild.Builder{}).PTCImageTag()
}

func (f *fakePTCImages) BuildPTC(dshVersion string) (string, error) {
	if f.onBuild != nil {
		f.onBuild()
	}
	f.builds = append(f.builds, dshVersion)
	if f.buildErr != nil {
		return "", f.buildErr
	}
	return (&imagebuild.Builder{}).PTCImageTag(), nil
}

// ptcRequest builds an EnsureContainer request for the shared container at the
// given harness release. It carries no workspace: the PTC container is not
// bound to one.
func ptcRequest(dshVersion string) *ctl.EnsureContainerRequest {
	return &ctl.EnsureContainerRequest{Container: ptcContainerLogical, DshVersion: dshVersion}
}

// ptcServer builds a server with a fake podman and no workspace at all, so a
// shared PTC ensure or remove proves it does not need one.
func ptcServer(t *testing.T) (*Server, *fakePodman) {
	t.Helper()
	server, fake, _ := ptcServerWithImages(t)
	return server, fake
}

// ptcServerWithImages also returns the PTC image-builder double, so a test can
// assert whether the image was built or reused.
func ptcServerWithImages(t *testing.T) (*Server, *fakePodman, *fakePTCImages) {
	t.Helper()
	fake := newFakePodman()
	images := &fakePTCImages{}
	return &Server{Store: newTestStore(t), Podman: fake, PTCImages: images, SocketsRoot: "/sockets", Logger: silentLogger()}, fake, images
}

// storedPTC returns the shared PTC record the server holds, failing when none
// is stored.
func storedPTC(t *testing.T, server *Server) state.Container {
	t.Helper()
	record, found, err := server.Store.PTCContainer()
	if err != nil {
		t.Fatal(err)
	}
	if !found {
		t.Fatal("the shared PTC record was not stored")
	}
	return record
}

func TestEnsurePTCContainerCreatesLazilyWithoutAWorkspace(t *testing.T) {
	server, fake := ptcServer(t)
	row, err := server.EnsureContainer(context.Background(), ptcRequest(testDSHVersion))
	if err != nil {
		t.Fatal(err)
	}
	if len(fake.ptcCreates) != 1 {
		t.Fatalf("expected one PTC create, got %d", len(fake.ptcCreates))
	}
	create := fake.ptcCreates[0]
	if create.name != testPTCContainer {
		t.Fatalf("unexpected PTC podman name: %#v", create)
	}
	if create.image != testPTCImageTag {
		t.Fatalf("unexpected PTC image: %q", create.image)
	}
	if create.token == "" || create.token != row.AgentToken {
		t.Fatalf("PTC token mismatch: create %q, row %q", create.token, row.AgentToken)
	}
	if row.ContainerName != ptcContainerLogical || row.WorkspaceSlug != "" || row.Kind != ctl.ContainerKind_CONTAINER_KIND_PTC || row.Status != "running" {
		t.Fatalf("unexpected PTC row: %#v", row)
	}
	// The creation date comes from podman's inspect, not the local clock.
	requirePodmanCreatedAt(t, row.CreatedAt)
	// The record lives outside workspace state, so no workspace was created.
	workspaces, err := server.Store.Workspaces()
	if err != nil {
		t.Fatal(err)
	}
	if len(workspaces) != 0 {
		t.Fatalf("the shared PTC container created workspace state: %#v", workspaces)
	}
	stored := storedPTC(t, server)
	if stored.Kind != state.ContainerKindPTC || stored.ImageID != testPTCImageID || stored.PodmanName != testPTCContainer {
		t.Fatalf("unexpected stored PTC record: %#v", stored)
	}
	if stored.AgentSocketPath != "/sockets/"+testPTCContainer+"/guest.sock" {
		t.Fatalf("unexpected PTC socket path: %q", stored.AgentSocketPath)
	}
}

// TestEnsurePTCContainerKeepsOneRecord pins the singleton: ensuring twice,
// with and without a workspace slug, still yields exactly one container and
// one stored record.
func TestEnsurePTCContainerKeepsOneRecord(t *testing.T) {
	server, fake := ptcServer(t)
	first, err := server.EnsureContainer(context.Background(), ptcRequest(testDSHVersion))
	if err != nil {
		t.Fatal(err)
	}
	// The workspace slug is meaningless for the shared container; a caller
	// that still sends one addresses the same record.
	withSlug := ptcRequest(testDSHVersion)
	withSlug.WorkspaceSlug = testWorkspaceSlug
	second, err := server.EnsureContainer(context.Background(), withSlug)
	if err != nil {
		t.Fatal(err)
	}
	if len(fake.ptcCreates) != 1 {
		t.Fatalf("a second ensure created another container: %#v", fake.ptcCreates)
	}
	if second.PodmanName != first.PodmanName || second.WorkspaceSlug != "" || second.AgentToken != first.AgentToken {
		t.Fatalf("the shared container was not reused: first %#v, second %#v", first, second)
	}
	stored := storedPTC(t, server)
	if stored.PodmanName != testPTCContainer {
		t.Fatalf("unexpected stored record: %#v", stored)
	}
}

func TestEnsurePTCContainerBuildsAMissingImage(t *testing.T) {
	server, fake, images := ptcServerWithImages(t)
	// Nothing exists yet, so the PTC image must be built once.
	fake.images = map[string]bool{}
	row, err := server.EnsureContainer(context.Background(), ptcRequest(testDSHVersion))
	if err != nil {
		t.Fatal(err)
	}
	if len(images.builds) != 1 || images.builds[0] != testDSHVersion {
		t.Fatalf("expected one build for %q, got %v", testDSHVersion, images.builds)
	}
	if len(fake.ptcCreates) != 1 || fake.ptcCreates[0].image != testPTCImageTag {
		t.Fatalf("the container must use the built image: %#v", fake.ptcCreates)
	}
	if row.ImageId != testPTCImageID {
		t.Fatalf("unexpected PTC image id: %q", row.ImageId)
	}
	// A second ensure reuses the running container and does not rebuild.
	if _, err := server.EnsureContainer(context.Background(), ptcRequest(testDSHVersion)); err != nil {
		t.Fatal(err)
	}
	if len(images.builds) != 1 {
		t.Fatalf("a reused container rebuilt the image: %v", images.builds)
	}
}

func TestEnsurePTCContainerReusesAnImageWithMatchingLabels(t *testing.T) {
	server, fake, images := ptcServerWithImages(t)
	seedPTCImage(fake, ptcImageLabels(t, testDSHVersion))
	if _, err := server.EnsureContainer(context.Background(), ptcRequest(testDSHVersion)); err != nil {
		t.Fatal(err)
	}
	if len(images.builds) != 0 {
		t.Fatalf("an image with matching labels must be reused, got builds %v", images.builds)
	}
	if len(fake.ptcCreates) != 1 || fake.ptcCreates[0].image != testPTCImageTag {
		t.Fatalf("the container must use the existing image: %#v", fake.ptcCreates)
	}
	// Force a container recreate while the image stays current: the image must
	// still be reused, not rebuilt, when the labels match.
	fake.running[testPTCContainer] = false
	if _, err := server.EnsureContainer(context.Background(), ptcRequest(testDSHVersion)); err != nil {
		t.Fatal(err)
	}
	if len(images.builds) != 0 {
		t.Fatalf("the matching image was rebuilt during a container recreate: %v", images.builds)
	}
	if len(fake.ptcCreates) != 2 {
		t.Fatalf("expected the container to be recreated, got %d creates", len(fake.ptcCreates))
	}
}

func TestEnsurePTCContainerRebuildsForAnotherVersion(t *testing.T) {
	server, fake, images := ptcServerWithImages(t)
	seedPTCImage(fake, ptcImageLabels(t, testDSHVersion))
	if _, err := server.EnsureContainer(context.Background(), ptcRequest(testDSHVersion)); err != nil {
		t.Fatal(err)
	}
	if _, err := server.EnsureContainer(context.Background(), ptcRequest(testOtherDSHVersion)); err != nil {
		t.Fatal(err)
	}
	if len(images.builds) != 1 || images.builds[0] != testOtherDSHVersion {
		t.Fatalf("a different version must rebuild the image, got builds %v", images.builds)
	}
	if len(fake.ptcCreates) != 2 || fake.ptcCreates[1].image != testPTCImageTag {
		t.Fatalf("the rebuilt image must keep the single tag: %#v", fake.ptcCreates)
	}
}

func TestEnsurePTCContainerRebuildsForAnotherRecipe(t *testing.T) {
	server, fake, images := ptcServerWithImages(t)
	labels := ptcImageLabels(t, testDSHVersion)
	labels[imagebuild.PTCRecipeLabel] = "sha256:0000000000000000000000000000000000000000000000000000000000000000"
	seedPTCImage(fake, labels)
	if _, err := server.EnsureContainer(context.Background(), ptcRequest(testDSHVersion)); err != nil {
		t.Fatal(err)
	}
	if len(images.builds) != 1 || images.builds[0] != testDSHVersion {
		t.Fatalf("a different recipe must rebuild the image, got builds %v", images.builds)
	}
	if len(fake.ptcCreates) != 1 || fake.ptcCreates[0].image != testPTCImageTag {
		t.Fatalf("the container must use the rebuilt image: %#v", fake.ptcCreates)
	}
}

func TestEnsurePTCContainerRecreatesAfterAnImageRebuild(t *testing.T) {
	server, fake, images := ptcServerWithImages(t)
	// The first use builds and creates from the current release.
	if _, err := server.EnsureContainer(context.Background(), ptcRequest(testDSHVersion)); err != nil {
		t.Fatal(err)
	}
	// Simulate a rebuild: the single tag now carries another release, while
	// the shared container still runs the image it was created from.
	seedPTCImage(fake, ptcImageLabels(t, testOtherDSHVersion))
	row, err := server.EnsureContainer(context.Background(), ptcRequest(testOtherDSHVersion))
	if err != nil {
		t.Fatal(err)
	}
	if len(images.builds) != 1 {
		t.Fatalf("the already-rebuilt image must be reused here, got builds %v", images.builds)
	}
	if len(fake.ptcCreates) != 2 {
		t.Fatalf("the container must be recreated from the rebuilt image, got %d creates", len(fake.ptcCreates))
	}
	if row.ImageId != testPTCImageID {
		t.Fatalf("the recreate must keep the single image id: %q", row.ImageId)
	}
	stored := storedPTC(t, server)
	if stored.ImageID != testPTCImageID {
		t.Fatalf("the stored record kept a versioned image id: %#v", stored)
	}
	if stored.ImageFingerprint != imagebuild.LabelFingerprint(ptcImageLabels(t, testOtherDSHVersion)) {
		t.Fatalf("the stored record did not adopt the rebuilt image: %#v", stored)
	}
}

func TestEnsurePTCContainerReportsAnImageBuildFailure(t *testing.T) {
	server, fake, images := ptcServerWithImages(t)
	fake.images = map[string]bool{}
	images.buildErr = errors.New("registry unreachable")
	_, err := server.EnsureContainer(context.Background(), ptcRequest(testDSHVersion))
	if status.Code(err) != codes.Internal {
		t.Fatalf("expected Internal, got %v", err)
	}
	for _, want := range []string{"cannot build the PTC image", testDSHVersion, "registry unreachable"} {
		if !strings.Contains(err.Error(), want) {
			t.Fatalf("the build failure must name %q: %v", want, err)
		}
	}
	if len(fake.ptcCreates) != 0 {
		t.Fatalf("a failed build must not create the container: %#v", fake.ptcCreates)
	}
}

func TestEnsurePTCContainerRejectsInvalidVersions(t *testing.T) {
	server, fake := ptcServer(t)
	for _, version := range []string{"", "../escape", "0.0.0; rm -rf /", "0.0.0\nRUN true"} {
		_, err := server.EnsureContainer(context.Background(), ptcRequest(version))
		if status.Code(err) != codes.InvalidArgument {
			t.Errorf("version %q: expected InvalidArgument, got %v", version, err)
		}
		if !strings.Contains(err.Error(), "dsh version") {
			t.Errorf("version %q: the error must name the version: %v", version, err)
		}
	}
	if len(fake.ptcCreates) != 0 {
		t.Fatalf("an invalid version must not create the container: %#v", fake.ptcCreates)
	}
}

func TestEnsurePTCContainerRecreatesForANewHarnessVersion(t *testing.T) {
	server, fake, images := ptcServerWithImages(t)
	if _, err := server.EnsureContainer(context.Background(), ptcRequest(testDSHVersion)); err != nil {
		t.Fatal(err)
	}
	row, err := server.EnsureContainer(context.Background(), ptcRequest(testOtherDSHVersion))
	if err != nil {
		t.Fatal(err)
	}
	if len(images.builds) != 2 || images.builds[1] != testOtherDSHVersion {
		t.Fatalf("a new harness version must rebuild the image, got builds %v", images.builds)
	}
	if len(fake.ptcCreates) != 2 {
		t.Fatalf("a new harness version must recreate the container, got %d creates", len(fake.ptcCreates))
	}
	if fake.ptcCreates[1].image != testPTCImageTag {
		t.Fatalf("unexpected image for the new version: %q", fake.ptcCreates[1].image)
	}
	if row.ImageId != testPTCImageID {
		t.Fatalf("unexpected image id for the new version: %q", row.ImageId)
	}
	if stored := storedPTC(t, server); stored.ImageID != testPTCImageID {
		t.Fatalf("the stored record kept the old image: %#v", stored)
	}
}

func TestEnsurePTCContainerReusesARunningContainer(t *testing.T) {
	server, fake := ptcServer(t)
	first, err := server.EnsureContainer(context.Background(), ptcRequest(testDSHVersion))
	if err != nil {
		t.Fatal(err)
	}
	second, err := server.EnsureContainer(context.Background(), ptcRequest(testDSHVersion))
	if err != nil {
		t.Fatal(err)
	}
	if len(fake.ptcCreates) != 1 {
		t.Fatalf("a running PTC container must be reused, got %d creates", len(fake.ptcCreates))
	}
	if second.AgentToken != first.AgentToken || second.CreatedAt != first.CreatedAt {
		t.Fatalf("the reused PTC container changed: first %#v, second %#v", first, second)
	}
}

func TestEnsurePTCContainerRecreatesAStoppedContainer(t *testing.T) {
	server, fake := ptcServer(t)
	if _, err := server.EnsureContainer(context.Background(), ptcRequest(testDSHVersion)); err != nil {
		t.Fatal(err)
	}
	fake.running[testPTCContainer] = false
	if _, err := server.EnsureContainer(context.Background(), ptcRequest(testDSHVersion)); err != nil {
		t.Fatal(err)
	}
	if len(fake.ptcCreates) != 2 {
		t.Fatalf("expected a recreate after the PTC container stopped, got %d creates", len(fake.ptcCreates))
	}
}

func TestEnsurePTCContainerReportsACreateFailure(t *testing.T) {
	server, fake := ptcServer(t)
	fake.ptcErr = errors.New("no space left on device")
	_, err := server.EnsureContainer(context.Background(), ptcRequest(testDSHVersion))
	if status.Code(err) != codes.Internal {
		t.Fatalf("expected Internal, got %v", err)
	}
	if !strings.Contains(err.Error(), "cannot create the PTC container") || !strings.Contains(err.Error(), "no space left on device") {
		t.Fatalf("unexpected error: %v", err)
	}
}

// TestPTCContainerNameIsReserved pins that every workspace-addressed mutation
// still refuses the reserved PTC name; only the workspace-less remove is the
// new path that may retire the shared container.
func TestPTCContainerNameIsReserved(t *testing.T) {
	server, fake := ptcServer(t)
	if err := server.Store.SavePTCContainer(state.Container{
		Name: ptcContainerLogical, Kind: state.ContainerKindPTC, PodmanName: testPTCContainer, ImageID: testPTCImageID, Status: "running", AgentToken: "ptc-token",
	}); err != nil {
		t.Fatal(err)
	}
	fake.exists[testPTCContainer] = true
	fake.running[testPTCContainer] = true
	fake.agentToken[testPTCContainer] = "ptc-token"
	ctx := context.Background()
	calls := []struct {
		name string
		call func() error
	}{
		{"StartContainer", func() error {
			_, err := server.StartContainer(ctx, &ctl.StartContainerRequest{WorkspaceSlug: testWorkspaceSlug, Container: ptcContainerLogical, ImageId: "archlinux"})
			return err
		}},
		{"RecreateContainer", func() error {
			_, err := server.RecreateContainer(ctx, &ctl.RecreateContainerRequest{WorkspaceSlug: testWorkspaceSlug, Container: ptcContainerLogical, ImageId: "archlinux"})
			return err
		}},
		{"RemoveContainer", func() error {
			_, err := server.RemoveContainer(ctx, &ctl.RemoveContainerRequest{WorkspaceSlug: testWorkspaceSlug, Container: ptcContainerLogical})
			return err
		}},
		{"AddContainerMount", func() error {
			_, err := server.AddContainerMount(ctx, &ctl.AddContainerMountRequest{WorkspaceSlug: testWorkspaceSlug, Container: ptcContainerLogical, Kind: ctl.MountKind_MOUNT_KIND_TMPFS, Destination: "/scratch", Mode: ctl.MountMode_MOUNT_MODE_READ_WRITE})
			return err
		}},
		{"RemoveContainerMount", func() error {
			_, err := server.RemoveContainerMount(ctx, &ctl.RemoveContainerMountRequest{WorkspaceSlug: testWorkspaceSlug, Container: ptcContainerLogical, Kind: ctl.MountKind_MOUNT_KIND_TMPFS, Destination: "/scratch"})
			return err
		}},
		{"UpdateContainerMount", func() error {
			_, err := server.UpdateContainerMount(ctx, &ctl.UpdateContainerMountRequest{WorkspaceSlug: testWorkspaceSlug, Container: ptcContainerLogical, Kind: ctl.MountKind_MOUNT_KIND_TMPFS, Destination: "/scratch", Mode: ctl.MountMode_MOUNT_MODE_READ_ONLY})
			return err
		}},
		{"SetContainerPaths", func() error {
			_, err := server.SetContainerPaths(ctx, &ctl.SetContainerPathsRequest{WorkspaceSlug: testWorkspaceSlug, Container: ptcContainerLogical, Paths: []string{"/opt/bin"}})
			return err
		}},
		{"AddContainerSecret", func() error {
			_, err := server.AddContainerSecret(ctx, &ctl.AddContainerSecretRequest{WorkspaceSlug: testWorkspaceSlug, Container: ptcContainerLogical, Env: "TOKEN", Secret: "s"})
			return err
		}},
		{"RemoveContainerSecret", func() error {
			_, err := server.RemoveContainerSecret(ctx, &ctl.RemoveContainerSecretRequest{WorkspaceSlug: testWorkspaceSlug, Container: ptcContainerLogical, Env: "TOKEN"})
			return err
		}},
		{"PublishPort", func() error {
			_, err := server.PublishPort(ctx, &ctl.PublishPortRequest{WorkspaceSlug: testWorkspaceSlug, Container: ptcContainerLogical, Port: 8080, Protocol: ctl.Protocol_PROTOCOL_TCP})
			return err
		}},
		{"UnpublishPort", func() error {
			_, err := server.UnpublishPort(ctx, &ctl.UnpublishPortRequest{WorkspaceSlug: testWorkspaceSlug, Container: ptcContainerLogical, Port: 8080, Protocol: ctl.Protocol_PROTOCOL_TCP})
			return err
		}},
	}
	for _, tc := range calls {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.call()
			if status.Code(err) != codes.InvalidArgument || !strings.Contains(err.Error(), "reserved") {
				t.Fatalf("expected a reserved-name InvalidArgument, got %v", err)
			}
		})
	}
	if len(fake.removed) != 0 || len(fake.recreated) != 0 || len(fake.ptcCreates) != 0 {
		t.Fatalf("a refused call mutated the PTC container: removed %v, recreated %v, ptcCreates %v", fake.removed, fake.recreated, fake.ptcCreates)
	}
	stored := storedPTC(t, server)
	if stored.Status != "running" || len(stored.Paths) != 0 || len(stored.Mounts) != 0 || len(stored.SecretEnv) != 0 {
		t.Fatalf("a refused call changed the PTC record: %#v", stored)
	}
}

// TestRemovePTCContainerWithoutAWorkspace covers the explicit workspace-less
// remove that retires the shared container, including its idempotence.
func TestRemovePTCContainerWithoutAWorkspace(t *testing.T) {
	server, fake := ptcServer(t)
	ctx := context.Background()
	if _, err := server.EnsureContainer(ctx, ptcRequest(testDSHVersion)); err != nil {
		t.Fatal(err)
	}
	if _, err := server.RemoveContainer(ctx, &ctl.RemoveContainerRequest{Container: ptcContainerLogical}); err != nil {
		t.Fatal(err)
	}
	if !sliceContains(fake.removed, testPTCContainer) {
		t.Fatalf("the shared PTC container was not removed: %v", fake.removed)
	}
	if !sliceContains(fake.removedSocketDirs, testPTCContainer) {
		t.Fatalf("the PTC socket directory was not removed: %v", fake.removedSocketDirs)
	}
	if _, found, err := server.Store.PTCContainer(); err != nil || found {
		t.Fatalf("the PTC record survived removal: found=%v err=%v", found, err)
	}
	// A second remove succeeds: the container and record are already gone.
	if _, err := server.RemoveContainer(ctx, &ctl.RemoveContainerRequest{Container: ptcContainerLogical}); err != nil {
		t.Fatalf("the workspace-less remove is not idempotent: %v", err)
	}
}

// TestRemoveContainerWithoutAWorkspaceRequiresPTC keeps the empty slug from
// becoming a way to address a guest container without its workspace.
func TestRemoveContainerWithoutAWorkspaceRequiresPTC(t *testing.T) {
	server, fake := ptcServer(t)
	_, err := server.RemoveContainer(context.Background(), &ctl.RemoveContainerRequest{Container: "default"})
	if status.Code(err) != codes.InvalidArgument {
		t.Fatalf("expected InvalidArgument, got %v", err)
	}
	if len(fake.removed) != 0 {
		t.Fatalf("a refused remove touched podman: %v", fake.removed)
	}
}

func TestReconcilePTCContainersDropsADeadRecord(t *testing.T) {
	server, fake := ptcServer(t)
	if err := server.Store.SavePTCContainer(state.Container{
		Name: ptcContainerLogical, Kind: state.ContainerKindPTC, PodmanName: testPTCContainer, ImageID: testPTCImageID, Status: "running",
	}); err != nil {
		t.Fatal(err)
	}
	// The podman container is gone: its record must not outlive it.
	server.ReconcilePTCContainers()
	if _, found, err := server.Store.PTCContainer(); err != nil || found {
		t.Fatalf("a dead PTC record must be dropped: found=%v err=%v", found, err)
	}
	if len(fake.removed) != 0 {
		t.Fatalf("reconcile must not remove podman resources: %v", fake.removed)
	}
}

func TestReconcilePTCContainersRefreshesStatus(t *testing.T) {
	server, fake := ptcServer(t)
	if err := server.Store.SavePTCContainer(state.Container{
		Name: ptcContainerLogical, Kind: state.ContainerKindPTC, PodmanName: testPTCContainer, ImageID: testPTCImageID, Status: "running",
	}); err != nil {
		t.Fatal(err)
	}
	fake.exists[testPTCContainer] = true
	fake.running[testPTCContainer] = false
	server.ReconcilePTCContainers()
	stored := storedPTC(t, server)
	if stored.Status != "stopped" {
		t.Fatalf("PTC status not refreshed: %#v", stored)
	}
}

// TestReconcilePTCContainersLeavesWorkspacesAlone pins that reconcile touches
// exactly the one shared record, never per-workspace containers.
func TestReconcilePTCContainersLeavesWorkspacesAlone(t *testing.T) {
	server, _ := ptcServer(t)
	if err := server.Store.SaveWorkspaces([]state.Workspace{{
		WorkspaceSlug: testWorkspaceSlug,
		ContainerName: testDefaultContainer,
		Containers:    []state.Container{{Name: "default", PodmanName: testDefaultContainer, Status: "running"}},
	}}); err != nil {
		t.Fatal(err)
	}
	server.ReconcilePTCContainers()
	workspaces, err := server.Store.Workspaces()
	if err != nil {
		t.Fatal(err)
	}
	if len(workspaces) != 1 || len(workspaces[0].Containers) != 1 || workspaces[0].Containers[0].Status != "running" {
		t.Fatalf("reconcile changed workspace state: %#v", workspaces)
	}
}

func TestRemoveWorkspaceLeavesThePTCContainerAlone(t *testing.T) {
	server, fake := ptcServer(t)
	if err := server.Store.SaveWorkspaces([]state.Workspace{{
		WorkspaceSlug: testWorkspaceSlug,
		ContainerName: testDefaultContainer,
		Containers:    []state.Container{{Name: "default", PodmanName: testDefaultContainer, ImageID: "archlinux", Status: "running", AgentToken: "tok"}},
	}}); err != nil {
		t.Fatal(err)
	}
	if err := server.Store.SavePTCContainer(state.Container{
		Name: ptcContainerLogical, Kind: state.ContainerKindPTC, PodmanName: testPTCContainer, ImageID: testPTCImageID, Status: "running", AgentToken: "ptc-token",
	}); err != nil {
		t.Fatal(err)
	}
	fake.exists[testPTCContainer] = true
	fake.running[testPTCContainer] = true
	if _, err := server.RemoveWorkspace(context.Background(), &ctl.RemoveWorkspaceRequest{WorkspaceSlug: testWorkspaceSlug}); err != nil {
		t.Fatal(err)
	}
	if !sliceContains(fake.removedPods, "dsh-podman-"+testWorkspaceSlug) {
		t.Fatalf("workspace pod not removed: %v", fake.removedPods)
	}
	if sliceContains(fake.removed, testPTCContainer) || sliceContains(fake.removedSocketDirs, testPTCContainer) {
		t.Fatalf("workspace removal tore down the shared PTC container: removed %v, socket dirs %v", fake.removed, fake.removedSocketDirs)
	}
	if _, found, err := server.Store.PTCContainer(); err != nil || !found {
		t.Fatalf("the shared PTC record did not survive workspace removal: found=%v err=%v", found, err)
	}
	stored, err := server.Store.Workspaces()
	if err != nil {
		t.Fatal(err)
	}
	if len(stored) != 0 {
		t.Fatalf("workspace record survived removal: %#v", stored)
	}
}

func TestListContainersMarksTheSharedPTCContainer(t *testing.T) {
	server, fake := ptcServer(t)
	if err := server.Store.SavePTCContainer(state.Container{
		Name: ptcContainerLogical, Kind: state.ContainerKindPTC, PodmanName: testPTCContainer, ImageID: testPTCImageID, Status: "running",
	}); err != nil {
		t.Fatal(err)
	}
	fake.exists[testPTCContainer] = true
	fake.running[testPTCContainer] = true
	response, err := server.ListContainers(context.Background(), &ctl.ListContainersRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if len(response.Containers) != 1 {
		t.Fatalf("expected the one shared PTC row, got %#v", response.Containers)
	}
	row := response.Containers[0]
	if row.ContainerName != ptcContainerLogical || row.WorkspaceSlug != "" || row.Kind != ctl.ContainerKind_CONTAINER_KIND_PTC || row.Status != "running" {
		t.Fatalf("unexpected PTC row: %#v", row)
	}
}

// TestListContainersEmitsTheSharedPTCContainerWithoutWorkspaces pins that the
// shared row is state-driven: no workspace has to exist for it to be listed.
func TestListContainersEmitsTheSharedPTCContainerWithoutWorkspaces(t *testing.T) {
	server, _ := ptcServer(t)
	if err := server.Store.SavePTCContainer(state.Container{
		Name: ptcContainerLogical, Kind: state.ContainerKindPTC, PodmanName: testPTCContainer, ImageID: testPTCImageID, Status: "running",
	}); err != nil {
		t.Fatal(err)
	}
	response, err := server.ListContainers(context.Background(), &ctl.ListContainersRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if len(response.Containers) != 1 {
		t.Fatalf("the shared PTC row was not listed: %#v", response.Containers)
	}
	if response.Containers[0].WorkspaceSlug != "" || response.Containers[0].Kind != ctl.ContainerKind_CONTAINER_KIND_PTC {
		t.Fatalf("unexpected shared PTC row: %#v", response.Containers[0])
	}
}
