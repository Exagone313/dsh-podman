// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"fmt"
	"os"
	"strings"

	imagebuild "github.com/Exagone313/dsh-podman/internal/orchestrator/images"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

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
