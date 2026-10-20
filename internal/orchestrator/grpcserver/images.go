// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"context"
	"fmt"
	"strings"
	"time"

	ctl "github.com/Exagone313/dsh-podman/internal/genproto/dshctl/v1"
	imagebuild "github.com/Exagone313/dsh-podman/internal/orchestrator/images"
	"github.com/Exagone313/dsh-podman/internal/orchestrator/state"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func (s *Server) ListImages(context.Context, *ctl.ListImagesRequest) (*ctl.ListImagesResponse, error) {
	s.log().Info("control request", "method", "ListImages")
	result := &ctl.ListImagesResponse{}
	for _, base := range imagebuild.BaseImages {
		resolved, err := s.resolveImage(base.ID)
		if err != nil {
			s.log().Error("control request failed", "method", "ListImages", "base_image", base.ID, "error", err)
			return nil, err
		}
		result.Images = append(result.Images, imageProto(resolved))
	}
	images, err := s.Store.Images()
	if err != nil {
		s.log().Error("control request failed", "method", "ListImages", "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	for _, image := range images {
		resolved, err := s.resolveImage(image.ImageID)
		if err != nil {
			s.log().Error("control request failed", "method", "ListImages", "image_id", image.ImageID, "error", err)
			return nil, err
		}
		result.Images = append(result.Images, imageProto(resolved))
	}
	ptc, err := s.ptcImageRow()
	if err != nil {
		s.log().Error("control request failed", "method", "ListImages", "image_id", imagebuild.PTCImageID(), "error", err)
		return nil, err
	}
	result.Images = append(result.Images, ptc)
	s.log().Info("control request completed", "method", "ListImages", "count", len(result.Images))
	return result, nil
}

// ptcImageRow projects the single on-demand PTC image as a custom-image row.
// It is not stored in the image state, so its status is the podman presence
// of the one deterministic tag: "built" when present, "missing" otherwise.
func (s *Server) ptcImageRow() (*ctl.Image, error) {
	builder, err := s.ptcImageBuilder()
	if err != nil {
		// Listing still works without a builder configured: report the fixed
		// default tag and let the podman probe decide the status.
		builder = &imagebuild.Builder{}
	}
	tag := builder.PTCImageTag()
	imageStatus := "missing"
	builtAt := ""
	if s.Podman != nil {
		exists, err := s.Podman.ImageExists(tag)
		if err != nil {
			return nil, status.Error(codes.Internal, err.Error())
		}
		if exists {
			imageStatus = "built"
			builtAt = s.Podman.ImageCreated(tag)
		}
	}
	return imageProto(resolvedImage{
		ImageID:        imagebuild.PTCImageID(),
		IsBase:         false,
		PackageManager: "apt",
		ImageTag:       tag,
		Parent:         imagebuild.PTCBasePrimitive,
		BuiltAt:        builtAt,
		Status:         imageStatus,
	}), nil
}

func (s *Server) GetImage(_ context.Context, request *ctl.GetImageRequest) (*ctl.Image, error) {
	s.log().Info("control request", "method", "GetImage", "image_id", request.GetImageId())
	resolved, err := s.resolveImage(request.GetImageId())
	if err != nil {
		s.log().Warn("control request failed", "method", "GetImage", "image_id", request.GetImageId(), "reason", "not found")
		return nil, err
	}
	s.log().Info("control request completed", "method", "GetImage", "image_id", request.GetImageId())
	return imageProto(resolved), nil
}

func (s *Server) BuildImage(_ context.Context, request *ctl.BuildImageRequest) (*ctl.Image, error) {
	s.log().Info("control request", "method", "BuildImage", "image_id", request.GetImageId(), "parent", request.GetParent(), "package_count", len(request.GetPackages()))
	imageID := request.GetImageId()
	if !shortImageName(imageID) {
		return nil, status.Error(codes.InvalidArgument, fmt.Sprintf("invalid image id %q", imageID))
	}
	if _, ok := imagebuild.BaseImageByID(imageID); ok {
		return nil, status.Error(codes.InvalidArgument, fmt.Sprintf("image id %q is a reserved base image name", imageID))
	}
	if err := s.validateBuildParent(request.GetParent()); err != nil {
		return nil, err
	}
	if s.ImageBuilder == nil {
		return nil, status.Error(codes.FailedPrecondition, "image builder is not configured")
	}
	image := state.Image{ImageID: imageID, Parent: request.GetParent(), Packages: append([]string(nil), request.GetPackages()...)}
	stored, err := s.buildCustomImage(image)
	if err != nil {
		s.log().Error("control request failed", "method", "BuildImage", "image_id", imageID, "error", err)
		return nil, grpcError(err)
	}
	s.log().Info("control request completed", "method", "BuildImage", "image_id", stored.ImageID, "image_tag", stored.ImageTag)
	return imageProto(resolvedImage{ImageID: stored.ImageID, IsBase: false, PackageManager: stored.PackageManager, ImageTag: stored.ImageTag, Parent: stored.Parent, Packages: stored.Packages, BuiltAt: stored.BuiltAt, Status: "built"}), nil
}

func (s *Server) RebuildImage(_ context.Context, request *ctl.RebuildImageRequest) (*ctl.Image, error) {
	s.log().Info("control request", "method", "RebuildImage", "image_id", request.GetImageId())
	imageID := request.GetImageId()
	if imageID == "" {
		return nil, status.Error(codes.InvalidArgument, "image id is required")
	}
	if _, ok := imagebuild.BaseImageByID(imageID); ok {
		return nil, status.Error(codes.InvalidArgument, "base images are rebuilt from the settings")
	}
	// The reserved PTC image has no stored description: its single tag is
	// rebuilt unconditionally from the requested release, and the container
	// record is deliberately left alone (its ensure recreates it on next use).
	if imageID == imagebuild.PTCImageID() {
		image, err := s.rebuildPTCImage(request.GetDshVersion())
		if err != nil {
			s.log().Error("control request failed", "method", "RebuildImage", "image_id", imageID, "error", err)
			return nil, err
		}
		s.log().Info("control request completed", "method", "RebuildImage", "image_id", image.ImageId, "image_tag", image.ImageTag)
		return image, nil
	}
	if s.ImageBuilder == nil {
		return nil, status.Error(codes.FailedPrecondition, "image builder is not configured")
	}
	resolved, err := s.resolveImage(imageID)
	if err != nil {
		s.log().Warn("control request failed", "method", "RebuildImage", "image_id", imageID, "reason", "not found")
		return nil, err
	}
	if resolved.IsBase {
		return nil, status.Error(codes.InvalidArgument, "base images are rebuilt from the settings")
	}
	stored, err := s.buildCustomImage(state.Image{ImageID: imageID, Parent: resolved.Parent, PackageManager: resolved.PackageManager, Packages: resolved.Packages})
	if err != nil {
		s.log().Error("control request failed", "method", "RebuildImage", "image_id", imageID, "error", err)
		return nil, grpcError(err)
	}
	s.log().Info("control request completed", "method", "RebuildImage", "image_id", stored.ImageID, "image_tag", stored.ImageTag)
	return imageProto(resolvedImage{ImageID: stored.ImageID, IsBase: false, PackageManager: stored.PackageManager, ImageTag: stored.ImageTag, Parent: stored.Parent, Packages: stored.Packages, BuiltAt: stored.BuiltAt, Status: "built"}), nil
}

func (s *Server) RebuildAllImages(_ context.Context, request *ctl.RebuildAllImagesRequest) (*ctl.RebuildAllImagesResponse, error) {
	s.log().Info("control request", "method", "RebuildAllImages", "dsh_version", request.GetDshVersion())
	if s.Podman == nil {
		return nil, status.Error(codes.FailedPrecondition, "podman is not configured")
	}
	if s.ImageBuilder == nil {
		return nil, status.Error(codes.FailedPrecondition, "image builder is not configured")
	}
	// Validate the requested PTC release before doing any work, so a bad
	// version never leaves the stored images partially rebuilt.
	dshVersion := request.GetDshVersion()
	if dshVersion != "" {
		if _, err := imagebuild.PTCBuildSpec(dshVersion); err != nil {
			return nil, status.Error(codes.InvalidArgument, err.Error())
		}
	}
	images, err := s.Store.Images()
	if err != nil {
		s.log().Error("control request failed", "method", "RebuildAllImages", "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	baseFailures := make([]string, 0)
	failedBases := make(map[string]bool)
	for _, base := range imagebuild.BaseImages {
		exists, err := s.Podman.ImageExists(s.baseTag(base.ID))
		if err != nil {
			s.log().Error("control request failed", "method", "RebuildAllImages", "base_image", base.ID, "error", err)
			// A base whose availability could not be checked is reported in
			// skipped like any other image left unavailable, instead of being
			// only logged, and its dependents are skipped with it.
			baseFailures = append(baseFailures, base.ID)
			failedBases[base.ID] = true
			continue
		}
		if !exists {
			// Rebuilding only refreshes images that already exist: a base that
			// was never built is left alone. A base that a stored custom image
			// needs is still provisioned on demand when that custom image is
			// rebuilt (resolveParent -> ensureBase).
			s.log().Info("control request skipped", "method", "RebuildAllImages", "base_image", base.ID, "reason", "missing")
			continue
		}
		if err := s.rebuildBaseImage(&base); err != nil {
			s.log().Error("control request failed", "method", "RebuildAllImages", "base_image", base.ID, "error", err)
			baseFailures = append(baseFailures, base.ID)
			failedBases[base.ID] = true
		}
	}
	_, dependents := rebuildGraph(images)
	ordered, skipped := rebuildPlan(images, failedBases)
	skipped = append(baseFailures, skipped...)
	settled := make(map[string]bool, len(images))
	for _, id := range skipped {
		settled[id] = true
	}
	rebuilt := make([]string, 0, len(ordered))
	for _, image := range ordered {
		if settled[image.ImageID] {
			continue
		}
		if _, err := s.buildCustomImage(image); err != nil {
			s.log().Error("control request failed", "method", "RebuildAllImages", "image_id", image.ImageID, "error", err)
			for _, id := range skipDependents(dependents, image.ImageID) {
				if settled[id] {
					continue
				}
				settled[id] = true
				skipped = append(skipped, id)
			}
			continue
		}
		settled[image.ImageID] = true
		rebuilt = append(rebuilt, image.ImageID)
	}
	// A supplied release also covers the reserved PTC image, which lives
	// outside the stored set: the call builds it whether or not its tag already
	// exists. The container record is never touched, so its next ensure
	// recreates it from the freshly built image.
	if dshVersion != "" {
		if _, err := s.rebuildPTCImage(dshVersion); err != nil {
			s.log().Error("control request failed", "method", "RebuildAllImages", "image_id", imagebuild.PTCImageID(), "error", err)
			skipped = append(skipped, imagebuild.PTCImageID())
		} else {
			rebuilt = append(rebuilt, imagebuild.PTCImageID())
		}
	}
	s.log().Info("control request completed", "method", "RebuildAllImages", "rebuilt", len(rebuilt), "skipped", len(skipped))
	return &ctl.RebuildAllImagesResponse{Rebuilt: rebuilt, Skipped: skipped}, nil
}

// rebuildPTCImage builds the single PTC image for a harness release
// unconditionally, replacing the one tag whether or not it already exists with
// the current Containerfile, runtime package, symlink scaffold, and version and
// recipe labels. Like a base rebuild, it pulls the Node primitive first, so the
// build reflects current upstream rather than a stale local copy; a failed pull
// fails the rebuild before any build starts. It never touches the container
// record: Build/Rebuild only rebuild the image.
func (s *Server) rebuildPTCImage(dshVersion string) (*ctl.Image, error) {
	spec, err := imagebuild.PTCBuildSpec(dshVersion)
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}
	builder, err := s.ptcImageBuilder()
	if err != nil {
		return nil, err
	}
	if s.Podman == nil {
		return nil, status.Error(codes.FailedPrecondition, "podman is not configured")
	}
	if err := s.Podman.ImagePull(spec.From); err != nil {
		return nil, status.Error(codes.Internal, fmt.Sprintf("cannot pull the PTC base image %q: %v", spec.From, err))
	}
	tag, err := builder.BuildPTC(dshVersion)
	if err != nil {
		return nil, status.Error(codes.Internal, fmt.Sprintf("cannot build the PTC image with dsh version %q: %v", dshVersion, err))
	}
	builtAt := ""
	if s.Podman != nil {
		builtAt = s.Podman.ImageCreated(tag)
	}
	s.log().Info("built PTC image", "dsh_version", dshVersion, "image_tag", tag)
	return imageProto(resolvedImage{ImageID: spec.ImageID, IsBase: false, PackageManager: spec.PackageManager, ImageTag: tag, Parent: spec.From, BuiltAt: builtAt, Status: "built"}), nil
}

func (s *Server) RebuildBaseImage(_ context.Context, request *ctl.RebuildBaseImageRequest) (*ctl.Image, error) {
	s.log().Info("control request", "method", "RebuildBaseImage", "name", request.GetName())
	base, ok := imagebuild.BaseImageByID(request.GetName())
	if !ok {
		return nil, status.Error(codes.NotFound, fmt.Sprintf("base image %q not found", request.GetName()))
	}
	if s.baseImagesPublic() {
		return nil, status.Error(codes.InvalidArgument, "base images are pulled, not built, in this mode")
	}
	if s.Podman == nil {
		return nil, status.Error(codes.FailedPrecondition, "podman is not configured")
	}
	if s.ImageBuilder == nil {
		return nil, status.Error(codes.FailedPrecondition, "image builder is not configured")
	}
	if err := s.rebuildBaseImage(base); err != nil {
		s.log().Error("control request failed", "method", "RebuildBaseImage", "name", request.GetName(), "error", err)
		return nil, err
	}
	tag := s.baseTag(base.ID)
	s.log().Info("control request completed", "method", "RebuildBaseImage", "name", request.GetName(), "image_tag", tag)
	return imageProto(resolvedImage{ImageID: base.ID, IsBase: true, PackageManager: base.PackageManager, ImageTag: tag, Primitive: base.Primitive, Packages: append([]string(nil), base.Packages...), Status: "built", BuiltAt: s.Podman.ImageCreated(tag), BasePublic: false}), nil
}

// rebuildBaseImage refreshes a base image. In local mode the base's primitive
// is pulled first, so the rebuild reflects current upstream rather than a stale
// local copy, then the base is built from it. In public mode the base tag is
// pulled again. The caller is responsible for the podman/builder availability
// checks.
func (s *Server) rebuildBaseImage(base *imagebuild.BaseImage) error {
	if s.baseImagesPublic() {
		return s.Podman.ImagePull(s.baseTag(base.ID))
	}
	if s.Podman == nil {
		return status.Error(codes.FailedPrecondition, "podman is not configured")
	}
	if s.ImageBuilder == nil {
		return status.Error(codes.FailedPrecondition, "image builder is not configured")
	}
	if err := s.Podman.ImagePull(base.Primitive); err != nil {
		return status.Error(codes.Internal, err.Error())
	}
	spec := imagebuild.BuildSpec{ImageID: base.ID, From: base.Primitive, PackageManager: base.PackageManager, Packages: base.Packages, IsBase: true, PostInstall: base.PostInstall}
	if _, err := s.ImageBuilder.Build(spec); err != nil {
		return status.Error(codes.Internal, err.Error())
	}
	return nil
}

func (s *Server) PullBaseImage(_ context.Context, request *ctl.PullBaseImageRequest) (*ctl.Image, error) {
	s.log().Info("control request", "method", "PullBaseImage", "name", request.GetName())
	base, ok := imagebuild.BaseImageByID(request.GetName())
	if !ok {
		return nil, status.Error(codes.NotFound, fmt.Sprintf("base image %q not found", request.GetName()))
	}
	if !s.baseImagesPublic() {
		return nil, status.Error(codes.InvalidArgument, "base images are built, not pulled, in this mode")
	}
	if s.Podman == nil {
		return nil, status.Error(codes.FailedPrecondition, "podman is not configured")
	}
	tag := s.baseTag(base.ID)
	if err := s.Podman.ImagePull(tag); err != nil {
		s.log().Error("control request failed", "method", "PullBaseImage", "name", request.GetName(), "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	s.log().Info("control request completed", "method", "PullBaseImage", "name", request.GetName(), "image_tag", tag)
	return imageProto(resolvedImage{ImageID: base.ID, IsBase: true, PackageManager: base.PackageManager, ImageTag: tag, Primitive: base.Primitive, Packages: append([]string(nil), base.Packages...), Status: "pulled", BuiltAt: s.Podman.ImageCreated(tag), BasePublic: true}), nil
}

func (s *Server) RemoveImage(_ context.Context, request *ctl.RemoveImageRequest) (*ctl.RemoveImageResponse, error) {
	s.log().Info("control request", "method", "RemoveImage", "image_id", request.GetImageId())
	imageID := request.GetImageId()
	if imageID == "" {
		return nil, status.Error(codes.InvalidArgument, "image id is required")
	}
	if _, ok := imagebuild.BaseImageByID(imageID); ok {
		return nil, status.Error(codes.InvalidArgument, "base images are rebuilt from the settings")
	}
	resolved, err := s.resolveImage(imageID)
	if err != nil {
		s.log().Warn("control request failed", "method", "RemoveImage", "image_id", imageID, "reason", "not found")
		return nil, err
	}
	workspaces, err := s.Store.Workspaces()
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	// Reconcile first so a container deleted outside dsh-podman does not keep
	// the image "in use" (and its dead record is dropped).
	if s.Podman != nil {
		workspaces, err = s.reconcileContainers(workspaces, s.Podman.ContainerExists, s.Podman.ContainerRunning)
		if err != nil {
			s.log().Error("control request failed", "method", "RemoveImage", "image_id", imageID, "error", err)
			return nil, status.Error(codes.Internal, err.Error())
		}
	}
	for _, workspace := range workspaces {
		if imageRefsMatch(workspace.ImageID, imageID) {
			return nil, status.Error(codes.FailedPrecondition, fmt.Sprintf("image %q is in use by workspace %q container %q", imageID, workspace.WorkspaceSlug, "default"))
		}
		for _, container := range workspace.Containers {
			if imageRefsMatch(container.ImageID, imageID) {
				return nil, status.Error(codes.FailedPrecondition, fmt.Sprintf("image %q is in use by workspace %q container %q", imageID, workspace.WorkspaceSlug, container.Name))
			}
		}
	}
	if s.Podman == nil {
		return nil, status.Error(codes.FailedPrecondition, "podman is not configured")
	}
	if err := s.Podman.ImageRemove(resolved.ImageTag); err != nil {
		s.log().Error("control request failed", "method", "RemoveImage", "image_id", imageID, "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	if err := s.Store.UpdateImages(func(current []state.Image) ([]state.Image, error) {
		next := make([]state.Image, 0, len(current))
		for _, image := range current {
			if image.ImageID != imageID {
				next = append(next, image)
			}
		}
		return next, nil
	}); err != nil {
		s.log().Error("control request failed", "method", "RemoveImage", "image_id", imageID, "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	s.log().Info("control request completed", "method", "RemoveImage", "image_id", imageID)
	return &ctl.RemoveImageResponse{}, nil
}

// resolvedImage is the control-plane-ready projection of an image reference:
// either a synthesized base image or a stored custom image.
type resolvedImage struct {
	ImageID        string
	IsBase         bool
	PackageManager string
	ImageTag       string
	Parent         string
	Packages       []string
	BuiltAt        string
	Primitive      string
	Status         string
	BasePublic     bool
}

// imageProto projects a resolved image onto the control plane's Image message.
func imageProto(image resolvedImage) *ctl.Image {
	return &ctl.Image{ImageId: image.ImageID, Parent: image.Parent, Packages: image.Packages, ImageTag: image.ImageTag, BuiltAt: image.BuiltAt, IsBase: image.IsBase, Status: image.Status, Primitive: image.Primitive, PackageManager: image.PackageManager, BasePublic: image.BasePublic}
}

// validateBuildParent refuses a custom-image parent that names the reserved PTC
// image. The PTC image is built on demand by the orchestrator, so it must never
// become another custom image's parent; refusing here rather than in a client
// keeps a direct control call from bypassing the rule.
func (s *Server) validateBuildParent(parent string) error {
	if parent == "" || !s.isPtcParent(parent) {
		return nil
	}
	return status.Error(codes.InvalidArgument, fmt.Sprintf("parent image %q is reserved: the PTC image %q is built on demand and cannot be a custom image's parent", parent, imagebuild.PTCImageID()))
}

// isPtcParent reports whether parent denotes the reserved PTC image, in any
// spelling a caller can use: the logical id ("ptc"), its short or
// fully-qualified tag, or either of those without the ":latest" suffix, which
// podman resolves the same way. The default image prefix is included alongside
// the builder's configured one, so a caller cannot dodge the check by spelling
// the tag the other way.
func (s *Server) isPtcParent(parent string) bool {
	references := []string{imagebuild.PTCImageID()}
	tag := (&imagebuild.Builder{}).PTCImageTag()
	if s.ImageBuilder != nil {
		tag = s.ImageBuilder.PTCImageTag()
	}
	references = append(references, tag)
	if defaultTag := (&imagebuild.Builder{}).PTCImageTag(); defaultTag != tag {
		references = append(references, defaultTag)
	}
	name := imageParentName(parent)
	for _, reference := range references {
		if name == imageParentName(reference) {
			return true
		}
	}
	return false
}

// imageParentName drops an image reference's ":tag" suffix when the colon
// follows the last slash, so a registry port is never mistaken for a tag. A
// bare reference is returned unchanged: podman resolves it to ":latest".
func imageParentName(reference string) string {
	if index := strings.LastIndex(reference, ":"); index > strings.LastIndex(reference, "/") {
		return reference[:index]
	}
	return reference
}

// buildCustomImage builds a custom image from its stored description,
// resolving its short-name parent to a tag, stamps BuiltAt, upserts the
// record in the store (replacing the record with the same id, else appending),
// and returns the stored image. The caller is responsible for builder
// availability checks.
func (s *Server) buildCustomImage(image state.Image) (state.Image, error) {
	if err := s.validateBuildParent(image.Parent); err != nil {
		return state.Image{}, err
	}
	parentTag, parentPM, err := s.resolveParent(image.Parent)
	if err != nil {
		return state.Image{}, err
	}
	spec := imagebuild.BuildSpec{ImageID: image.ImageID, From: parentTag, PackageManager: parentPM, Packages: image.Packages, IsBase: false}
	tag, err := s.ImageBuilder.Build(spec)
	if err != nil {
		return state.Image{}, err
	}
	image.ImageTag = tag
	image.PackageManager = parentPM
	image.BuiltAt = time.Now().UTC().Format(time.RFC3339)
	if err := s.Store.UpdateImages(func(current []state.Image) ([]state.Image, error) {
		for i := range current {
			if current[i].ImageID == image.ImageID {
				current[i] = image
				return current, nil
			}
		}
		return append(current, image), nil
	}); err != nil {
		return state.Image{}, err
	}
	return image, nil
}
