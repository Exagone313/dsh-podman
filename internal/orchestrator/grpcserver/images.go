// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"context"
	"fmt"
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
	s.log().Info("control request completed", "method", "ListImages", "count", len(result.Images))
	return result, nil
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

func (s *Server) RebuildAllImages(_ context.Context, _ *ctl.RebuildAllImagesRequest) (*ctl.RebuildAllImagesResponse, error) {
	s.log().Info("control request", "method", "RebuildAllImages")
	if s.Podman == nil {
		return nil, status.Error(codes.FailedPrecondition, "podman is not configured")
	}
	if s.ImageBuilder == nil {
		return nil, status.Error(codes.FailedPrecondition, "image builder is not configured")
	}
	images, err := s.Store.Images()
	if err != nil {
		s.log().Error("control request failed", "method", "RebuildAllImages", "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	baseFailures := make([]string, 0)
	for _, base := range imagebuild.BaseImages {
		if _, _, err := s.ensureBase(base.ID); err != nil {
			s.log().Error("control request failed", "method", "RebuildAllImages", "base_image", base.ID, "error", err)
			// A base that could not be built or pulled is reported in skipped
			// like any other image left unavailable, instead of being only
			// logged.
			baseFailures = append(baseFailures, base.ID)
		}
	}
	_, dependents := rebuildGraph(images)
	ordered, skipped := rebuildPlan(images)
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
	s.log().Info("control request completed", "method", "RebuildAllImages", "rebuilt", len(rebuilt), "skipped", len(skipped))
	return &ctl.RebuildAllImagesResponse{Rebuilt: rebuilt, Skipped: skipped}, nil
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
	spec := imagebuild.BuildSpec{ImageID: base.ID, From: base.Primitive, PackageManager: base.PackageManager, Packages: base.Packages, IsBase: true, PostInstall: base.PostInstall}
	tag, err := s.ImageBuilder.Build(spec)
	if err != nil {
		s.log().Error("control request failed", "method", "RebuildBaseImage", "name", request.GetName(), "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	s.log().Info("control request completed", "method", "RebuildBaseImage", "name", request.GetName(), "image_tag", tag)
	return imageProto(resolvedImage{ImageID: base.ID, IsBase: true, PackageManager: base.PackageManager, ImageTag: tag, Primitive: base.Primitive, Packages: append([]string(nil), base.Packages...), Status: "built", BuiltAt: s.Podman.ImageCreated(tag), BasePublic: false}), nil
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

// buildCustomImage builds a custom image from its stored description,
// resolving its short-name parent to a tag, stamps BuiltAt, upserts the
// record in the store (replacing the record with the same id, else appending),
// and returns the stored image. The caller is responsible for builder
// availability checks.
func (s *Server) buildCustomImage(image state.Image) (state.Image, error) {
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
