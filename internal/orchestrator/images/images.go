// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package images

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/containers/buildah/define"
	"github.com/containers/podman/v5/pkg/bindings/images"
	entities "github.com/containers/podman/v5/pkg/domain/entities/types"
)

var packageName = regexp.MustCompile(`^[A-Za-z0-9@+._:][A-Za-z0-9@+._:-]*$`)
var baseImageName = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._:/@-]*$`)
var imageIDName = regexp.MustCompile(`^[a-zA-Z0-9_][a-zA-Z0-9_.\-/:]{0,127}$`)
var containerPathName = regexp.MustCompile(`^/[a-zA-Z0-9._:@+=-]+(?:/[a-zA-Z0-9._:@+=-]+)*$`)

func validPackage(pkg string) bool {
	return pkg != "." && pkg != ".." && packageName.MatchString(pkg)
}

func validBaseImage(base string) bool {
	if len(base) > 255 || !baseImageName.MatchString(base) {
		return false
	}
	for _, segment := range strings.Split(base, "/") {
		if segment == "." || segment == ".." {
			return false
		}
	}
	return true
}

func validContainerPath(path string) bool {
	if !containerPathName.MatchString(path) {
		return false
	}
	for _, segment := range strings.Split(path, "/") {
		if segment == "." || segment == ".." {
			return false
		}
	}
	return true
}

func validImageID(id string) bool {
	if id == "." || id == ".." || !imageIDName.MatchString(id) {
		return false
	}
	for _, segment := range strings.Split(id, "/") {
		if segment == "." || segment == ".." {
			return false
		}
	}
	return true
}

type GuestAgentImage struct {
	Image        string
	AgentBin     string
	DestAgentBin string
}

// BaseImage is a fixed, hardcoded workspace base image. Base images live in
// the registry below rather than in orchestrator state; only custom images
// derived from them are stored.
type BaseImage struct {
	ID             string
	Primitive      string
	PackageManager string
	CachePath      string
	Packages       []string
	PostInstall    []string
}

// BaseImages is the fixed registry of base images, in listing order.
var BaseImages = []BaseImage{
	{
		ID: "archlinux", Primitive: "docker.io/library/archlinux:latest", PackageManager: "pacman", CachePath: "/var/cache/pacman/pkg",
		Packages: []string{"base-devel", "git", "python", "curl", "wget", "openssh", "ca-certificates", "ripgrep", "fd", "jq", "unzip", "zstd", "less", "procps-ng", "diffutils", "patch", "tree"},
	},
	{
		ID: "ubuntu", Primitive: "docker.io/library/ubuntu:latest", PackageManager: "apt", CachePath: "/var/cache/apt/archives",
		Packages:    []string{"build-essential", "ca-certificates", "curl", "diffutils", "fd-find", "git", "jq", "less", "openssh-client", "patch", "procps", "python3", "ripgrep", "tree", "unzip", "wget", "zstd"},
		PostInstall: []string{"ln -s /usr/bin/fd-find /usr/local/bin/fd"},
	},
	{
		ID: "alpine", Primitive: "docker.io/library/alpine:latest", PackageManager: "apk", CachePath: "",
		Packages: []string{"bash", "build-base", "ca-certificates", "curl", "diffutils", "fd", "git", "jq", "less", "openssh-client", "patch", "procps", "python3", "ripgrep", "tree", "unzip", "wget", "zstd"},
	},
}

// BaseImageByID returns the base image with the given short id, if any.
func BaseImageByID(id string) (*BaseImage, bool) {
	for i := range BaseImages {
		if BaseImages[i].ID == id {
			return &BaseImages[i], true
		}
	}
	return nil, false
}

// BuildSpec describes a single image build: either a base image (IsBase)
// built from its primitive reference, or a custom image built from a resolved
// parent tag.
type BuildSpec struct {
	ImageID        string
	From           string
	PackageManager string
	Packages       []string
	IsBase         bool
	PostInstall    []string
	GuestAgent     GuestAgentImage
}

// Containerfile renders a Containerfile for the given build spec. Every
// package is validated, the FROM reference is validated as a base image
// reference (a primitive full ref for bases, a resolved parent tag for
// custom images), and the guest-agent stage is emitted only for base builds.
func Containerfile(spec BuildSpec) (string, error) {
	for _, pkg := range spec.Packages {
		if !validPackage(pkg) {
			return "", fmt.Errorf("invalid package name %q", pkg)
		}
	}
	if !validBaseImage(spec.From) {
		return "", fmt.Errorf("invalid base image %q", spec.From)
	}
	var guest GuestAgentImage
	if spec.IsBase {
		guest = spec.GuestAgent
		if guest.AgentBin == "" {
			guest.AgentBin = "/bin/dsh-podman-guest-agent"
		}
		if guest.DestAgentBin == "" {
			guest.DestAgentBin = "/usr/local/bin/dsh-podman-guest-agent"
		}
		if !validBaseImage(guest.Image) {
			return "", fmt.Errorf("invalid guest agent image %q", guest.Image)
		}
		if !validContainerPath(guest.AgentBin) {
			return "", fmt.Errorf("invalid guest agent binary path %q", guest.AgentBin)
		}
		if !validContainerPath(guest.DestAgentBin) {
			return "", fmt.Errorf("invalid guest agent destination path %q", guest.DestAgentBin)
		}
	}
	lines := make([]string, 0, 7)
	if spec.IsBase {
		lines = append(lines, "FROM "+guest.Image+" AS guestagent")
	}
	lines = append(lines, "FROM "+spec.From)
	switch spec.PackageManager {
	case "pacman":
		line := "RUN pacman -Syu --needed --noconfirm"
		if len(spec.Packages) > 0 {
			line += " " + strings.Join(spec.Packages, " ")
		}
		lines = append(lines, line)
	case "apt":
		line := "RUN DEBIAN_FRONTEND=noninteractive apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends"
		if len(spec.Packages) > 0 {
			line += " " + strings.Join(spec.Packages, " ")
		}
		line += " && rm -rf /var/lib/apt/lists/*"
		lines = append(lines, line)
	case "apk":
		line := "RUN apk add --no-cache"
		if len(spec.Packages) > 0 {
			line += " " + strings.Join(spec.Packages, " ")
		}
		lines = append(lines, line)
	default:
		return "", fmt.Errorf("invalid package manager %q", spec.PackageManager)
	}
	for _, cmd := range spec.PostInstall {
		lines = append(lines, "RUN "+cmd)
	}
	if spec.IsBase {
		lines = append(lines, "COPY --from=guestagent "+guest.AgentBin+" "+guest.DestAgentBin)
		lines = append(lines, "ENTRYPOINT [\""+guest.DestAgentBin+"\"]")
	}
	return strings.Join(lines, "\n") + "\n", nil
}

type Builder struct {
	Context         context.Context
	StateDir        string
	HostPacmanCache string
	GuestAgentImage GuestAgentImage
	ImagePrefix     string
	BaseImagePrefix string
	Logger          *slog.Logger
}

func (b Builder) Build(spec BuildSpec) (string, error) {
	if b.Context == nil {
		return "", fmt.Errorf("podman build context is not configured")
	}
	if !validImageID(spec.ImageID) {
		return "", fmt.Errorf("invalid image id %q", spec.ImageID)
	}
	contents, err := Containerfile(spec)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(b.StateDir, 0700); err != nil {
		return "", err
	}
	dir := filepath.Join(b.StateDir, spec.ImageID)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", err
	}
	file := filepath.Join(dir, "Containerfile")
	if err := os.WriteFile(file, []byte(contents), 0600); err != nil {
		return "", err
	}
	if spec.PackageManager == "pacman" {
		if b.HostPacmanCache == "" || !filepath.IsAbs(b.HostPacmanCache) {
			return "", fmt.Errorf("pacman cache path must be an absolute path")
		}
	}
	tag := b.tagFor(spec.ImageID, spec.IsBase)
	options := entities.BuildOptions{ContainerFiles: []string{file}, BuildOptions: define.BuildOptions{CommonBuildOpts: &define.CommonBuildOptions{}}}
	options.ContextDirectory = dir
	options.AdditionalTags = []string{tag}
	if spec.PackageManager == "pacman" {
		options.CommonBuildOpts.Volumes = []string{b.HostPacmanCache + ":/var/cache/pacman/pkg"}
	}
	logger := b.Logger
	if logger == nil {
		logger = slog.Default()
	}
	logger.Info("building workspace image", "image_id", spec.ImageID, "from", spec.From, "package_manager", spec.PackageManager, "is_base", spec.IsBase, "packages", spec.Packages, "context_directory", dir, "container_files", options.ContainerFiles, "tags", options.AdditionalTags, "build_volumes", options.CommonBuildOpts.Volumes, "host_pacman_cache", b.HostPacmanCache)
	_, err = images.Build(b.Context, []string{file}, options)
	if err != nil {
		logger.Error("workspace image build failed", "image_id", spec.ImageID, "error", err)
		return "", err
	}
	logger.Info("workspace image build completed", "image_id", spec.ImageID, "image_tag", tag)
	return tag, nil
}

func (b Builder) imagePrefix() string {
	prefix := b.ImagePrefix
	if prefix == "" {
		prefix = "localhost/dsh-podman/"
	}
	if !strings.HasSuffix(prefix, "/") {
		prefix += "/"
	}
	return prefix
}

func (b Builder) baseImagePrefix() string {
	prefix := b.BaseImagePrefix
	if prefix == "" {
		prefix = "localhost/dsh-podman/base/"
	}
	if !strings.HasSuffix(prefix, "/") {
		prefix += "/"
	}
	return prefix
}

// tagFor computes the fully-qualified tag for an image short name. Base
// images live under BaseImagePrefix; custom images under ImagePrefix.
func (b Builder) tagFor(imageID string, isBase bool) string {
	if isBase {
		return b.baseImagePrefix() + imageID + ":latest"
	}
	return b.imagePrefix() + imageID + ":latest"
}
