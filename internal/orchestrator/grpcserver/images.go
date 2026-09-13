// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"context"
	"fmt"
	"os"
	"sort"
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
	for _, base := range imagebuild.BaseImages {
		if _, _, err := s.ensureBase(base.ID); err != nil {
			s.log().Error("control request failed", "method", "RebuildAllImages", "base_image", base.ID, "error", err)
		}
	}
	_, dependents := rebuildGraph(images)
	ordered, skipped := rebuildPlan(images)
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

// rebuildGraph indexes stored images for rebuild planning: byID maps short
// image ids to their records (last occurrence wins) and dependents maps each
// short image id to the sorted list of image ids whose parent is that id.
func rebuildGraph(images []state.Image) (byID map[string]state.Image, dependents map[string][]string) {
	byID = make(map[string]state.Image, len(images))
	for _, image := range images {
		byID[image.ImageID] = image
	}
	dependents = make(map[string][]string)
	for _, image := range images {
		if owner, ok := byID[image.Parent]; ok {
			dependents[owner.ImageID] = append(dependents[owner.ImageID], image.ImageID)
		}
	}
	for owner := range dependents {
		sort.Strings(dependents[owner])
	}
	return byID, dependents
}

// rebuildPlan computes the deterministic rebuild plan for the stored custom
// images. It returns the ordered list of images to rebuild, with every parent
// preceding its dependents, and the list of image ids to skip.
//
// A parent that names a base image is always usable: bases are ensured before
// custom images are rebuilt. A parent that cannot be resolved to a stored
// custom image is skipped, as are any images left over by a dependency cycle.
func rebuildPlan(images []state.Image) (ordered []state.Image, skipped []string) {
	byID, dependents := rebuildGraph(images)

	settled := make(map[string]bool, len(images))
	rebuilt := make(map[string]bool, len(images))

	var markSkipped func(id string)
	markSkipped = func(id string) {
		if settled[id] {
			return
		}
		settled[id] = true
		skipped = append(skipped, id)
		for _, dependent := range dependents[id] {
			markSkipped(dependent)
		}
	}

	candidates := make([]string, 0, len(images))
	for _, image := range images {
		candidates = append(candidates, image.ImageID)
	}
	sort.Strings(candidates)
	remaining := make(map[string]bool, len(candidates))
	for _, id := range candidates {
		remaining[id] = true
	}

	for len(remaining) > 0 {
		progress := false
		for _, id := range candidates {
			if !remaining[id] {
				continue
			}
			if settled[id] {
				delete(remaining, id)
				continue
			}
			image := byID[id]
			if image.Parent == "" {
				markSkipped(id)
				delete(remaining, id)
				progress = true
				continue
			}
			if _, isBase := imagebuild.BaseImageByID(image.Parent); isBase {
				settled[id] = true
				rebuilt[id] = true
				ordered = append(ordered, image)
				delete(remaining, id)
				progress = true
				continue
			}
			owner, ok := byID[image.Parent]
			if !ok {
				markSkipped(id)
				delete(remaining, id)
				progress = true
				continue
			}
			if !settled[owner.ImageID] {
				continue
			}
			if !rebuilt[owner.ImageID] {
				markSkipped(id)
				delete(remaining, id)
				progress = true
				continue
			}
			settled[id] = true
			rebuilt[id] = true
			ordered = append(ordered, image)
			delete(remaining, id)
			progress = true
		}
		if !progress {
			leftover := make([]string, 0, len(remaining))
			for id := range remaining {
				leftover = append(leftover, id)
			}
			sort.Strings(leftover)
			for _, id := range leftover {
				markSkipped(id)
			}
			break
		}
	}
	return ordered, skipped
}

// skipDependents returns failedID and all of its transitive dependents: the
// image ids that must be skipped when failedID's rebuild fails.
func skipDependents(dependents map[string][]string, failedID string) []string {
	skipped := make([]string, 0)
	seen := make(map[string]bool)
	var walk func(id string)
	walk = func(id string) {
		if seen[id] {
			return
		}
		seen[id] = true
		skipped = append(skipped, id)
		for _, dependent := range dependents[id] {
			walk(dependent)
		}
	}
	walk(failedID)
	return skipped
}

// defaultImageShort is the short name of the built-in default workspace image.
func defaultImageShort() string {
	return "archlinux"
}

// baseTag computes the fully-qualified tag for a base image short name under
// the server's base image prefix.
func (s *Server) baseTag(short string) string {
	prefix := s.BaseImagePrefix
	if prefix == "" {
		prefix = "localhost/dsh-podman/base/"
	}
	if !strings.HasSuffix(prefix, "/") {
		prefix += "/"
	}
	return prefix + short + ":latest"
}

// baseImagesPublic reports whether base images are pulled from a public
// registry rather than built locally. A prefix starting with "localhost/"
// designates a local build prefix; an empty prefix defaults to the local
// prefix.
func (s *Server) baseImagesPublic() bool {
	prefix := s.BaseImagePrefix
	if prefix == "" {
		prefix = "localhost/dsh-podman/base/"
	}
	return !strings.HasPrefix(prefix, "localhost/")
}

// baseStatus reports the current status of a base image: "built" (local mode)
// or "pulled" (public mode) when the image is present, else "missing".
func (s *Server) baseStatus(short string) (string, error) {
	if _, ok := imagebuild.BaseImageByID(short); !ok {
		return "", status.Error(codes.NotFound, fmt.Sprintf("base image %q not found", short))
	}
	if s.Podman == nil {
		return "", status.Error(codes.FailedPrecondition, "podman is not configured")
	}
	exists, err := s.Podman.ImageExists(s.baseTag(short))
	if err != nil {
		return "", status.Error(codes.Internal, err.Error())
	}
	if !exists {
		return "missing", nil
	}
	if s.baseImagesPublic() {
		return "pulled", nil
	}
	return "built", nil
}

// ensureBase makes sure the named base image exists, building it locally or
// pulling it from a public registry as appropriate, and returns the base
// definition and its fully-qualified tag.
func (s *Server) ensureBase(short string) (*imagebuild.BaseImage, string, error) {
	base, ok := imagebuild.BaseImageByID(short)
	if !ok {
		return nil, "", status.Error(codes.NotFound, fmt.Sprintf("base image %q not found", short))
	}
	if s.Podman == nil {
		return nil, "", status.Error(codes.FailedPrecondition, "podman is not configured")
	}
	tag := s.baseTag(short)
	exists, err := s.Podman.ImageExists(tag)
	if err != nil {
		return nil, "", status.Error(codes.Internal, err.Error())
	}
	if exists {
		return base, tag, nil
	}
	if s.baseImagesPublic() {
		if err := s.Podman.ImagePull(tag); err != nil {
			return nil, "", status.Error(codes.Internal, err.Error())
		}
		return base, tag, nil
	}
	if s.ImageBuilder == nil {
		return nil, "", status.Error(codes.FailedPrecondition, "image builder is not configured")
	}
	spec := imagebuild.BuildSpec{ImageID: short, From: base.Primitive, PackageManager: base.PackageManager, Packages: base.Packages, IsBase: true, PostInstall: base.PostInstall}
	if _, err := s.ImageBuilder.Build(spec); err != nil {
		return nil, "", status.Error(codes.Internal, err.Error())
	}
	s.log().Info("auto-provisioned base image", "base_image", short, "image_tag", tag)
	return base, tag, nil
}

// resolveImage resolves a short image reference to control-plane-ready
// information. Base short names synthesize a base row (with its registry
// package manager and primitive reference); any other short name must match a
// stored custom image.
func (s *Server) resolveImage(short string) (resolvedImage, error) {
	if base, ok := imagebuild.BaseImageByID(short); ok {
		status := "missing"
		builtAt := ""
		if s.Podman != nil {
			st, err := s.baseStatus(short)
			if err != nil {
				return resolvedImage{}, err
			}
			status = st
			if status != "missing" {
				builtAt = s.Podman.ImageCreated(s.baseTag(short))
			}
		}
		return resolvedImage{ImageID: short, IsBase: true, PackageManager: base.PackageManager, ImageTag: s.baseTag(short), Primitive: base.Primitive, Packages: append([]string(nil), base.Packages...), Status: status, BuiltAt: builtAt, BasePublic: s.baseImagesPublic()}, nil
	}
	images, err := s.Store.Images()
	if err != nil {
		return resolvedImage{}, status.Error(codes.Internal, err.Error())
	}
	for _, image := range images {
		if image.ImageID == short {
			return resolvedImage{ImageID: image.ImageID, IsBase: false, PackageManager: image.PackageManager, ImageTag: image.ImageTag, Parent: image.Parent, Packages: image.Packages, BuiltAt: image.BuiltAt, Status: "built"}, nil
		}
	}
	return resolvedImage{}, status.Error(codes.NotFound, fmt.Sprintf("image %q not found", short))
}

// resolveImageTag returns the fully-qualified tag for a short image
// reference, auto-provisioning base images. Custom images must be stored with
// a non-empty tag.
func (s *Server) resolveImageTag(short string) (string, error) {
	if _, ok := imagebuild.BaseImageByID(short); ok {
		_, tag, err := s.ensureBase(short)
		if err != nil {
			return "", err
		}
		return tag, nil
	}
	images, err := s.Store.Images()
	if err != nil {
		return "", status.Error(codes.Internal, err.Error())
	}
	for _, image := range images {
		if image.ImageID == short && image.ImageTag != "" {
			return image.ImageTag, nil
		}
	}
	return "", status.Error(codes.NotFound, fmt.Sprintf("image %q not found", short))
}

// resolveParent resolves a short parent reference to its fully-qualified tag
// and package manager: a base short name is ensured (built or pulled), a
// stored custom image contributes its tag and recorded package manager.
func (s *Server) resolveParent(parent string) (tag, packageManager string, err error) {
	if base, ok := imagebuild.BaseImageByID(parent); ok {
		_, tag, err := s.ensureBase(parent)
		if err != nil {
			return "", "", err
		}
		return tag, base.PackageManager, nil
	}
	images, err := s.Store.Images()
	if err != nil {
		return "", "", status.Error(codes.Internal, err.Error())
	}
	for _, image := range images {
		if image.ImageID == parent {
			if image.ImageTag == "" {
				return "", "", status.Error(codes.NotFound, fmt.Sprintf("parent image %q not found", parent))
			}
			return image.ImageTag, image.PackageManager, nil
		}
	}
	return "", "", status.Error(codes.NotFound, fmt.Sprintf("parent image %q not found", parent))
}

// imageRefsMatch reports whether two stored image references denote the same
// image, ignoring a trailing ":tag" and the registry prefix.
func imageRefsMatch(a, b string) bool {
	if stripped, _, hasTag := strings.Cut(a, ":"); hasTag {
		a = stripped
	}
	if stripped, _, hasTag := strings.Cut(b, ":"); hasTag {
		b = stripped
	}
	return strings.TrimPrefix(a, imagePrefix()) == strings.TrimPrefix(b, imagePrefix())
}

func imagePrefix() string {
	prefix := os.Getenv("DSH_PODMAN_IMAGE_PREFIX")
	if prefix == "" {
		return "localhost/dsh-podman/"
	}
	if !strings.HasSuffix(prefix, "/") {
		prefix += "/"
	}
	return prefix
}
