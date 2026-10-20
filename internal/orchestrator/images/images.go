// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package images

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"log/slog"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
)

var packageName = regexp.MustCompile(`^[A-Za-z0-9@+._:][A-Za-z0-9@+._:-]*$`)
var baseImageName = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._:/@-]*$`)
var imageIDName = regexp.MustCompile(`^[a-zA-Z0-9_][a-zA-Z0-9_.\-/:]{0,127}$`)

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

// PTCBasePrimitive is the Node base the PTC image builds from. The PTC
// container runs the harness's PTC runtime on the same Node release as the dsh
// image. It names the tag rather than a digest: a digest names a single-platform
// manifest, which would break multi-arch builds.
const PTCBasePrimitive = "docker.io/library/node:26-slim"

// ptcImageID is the single short name of the PTC image. Its harness release
// and recipe are carried in labels, so an upgrade replaces the one tag instead
// of leaving an image behind per release.
const ptcImageID = "ptc"

// PTC image labels record the build inputs, so ensure can decide whether an
// existing image still matches the requested harness release and recipe.
const (
	PTCVersionLabel = "io.github.exagone313.dsh-podman.ptc.dsh-version"
	PTCRecipeLabel  = "io.github.exagone313.dsh-podman.ptc.containerfile-digest"
)

// ptcRuntimePackage is the harness's PTC runtime, installed into the PTC image,
// and ptcRuntimePackageName is its unscoped directory name.
const (
	ptcRuntimePackage     = "@deepseek-ai/dsh-ptc-runtime-node"
	ptcRuntimePackageName = "dsh-ptc-runtime-node"
)

// dshVersionName matches a harness release: a lowercase npm version with no
// separator or shell metacharacter that could alter the build instructions.
var dshVersionName = regexp.MustCompile(`^[0-9a-z]+(?:[._-][0-9a-z]+)*$`)

// PTCImageID returns the short name of the single PTC image. It never carries
// the harness release: that is a build label, so every release shares the one
// image and rebuilding replaces its tag.
func PTCImageID() string {
	return ptcImageID
}

// PTCBuildSpec describes the on-demand PTC image for a harness release. It
// carries only the PTC runtime package at the absolute path the host expects,
// never the dsh CLI or a patched dsh: the symlink scaffold resolves that path
// without installing the whole app package. The apt package manager is what
// makes the build use the managed apt cache. Its labels carry the release and
// a digest of the rendered Containerfile, so a change to either forces a
// rebuild of the same tag.
func PTCBuildSpec(dshVersion string) (BuildSpec, error) {
	if dshVersion == "" {
		return BuildSpec{}, fmt.Errorf("dsh version is required")
	}
	if len(dshVersion) > 100 || !dshVersionName.MatchString(dshVersion) {
		return BuildSpec{}, fmt.Errorf("invalid dsh version %q", dshVersion)
	}
	spec := BuildSpec{
		ImageID:        PTCImageID(),
		From:           PTCBasePrimitive,
		PackageManager: "apt",
		PostInstall: []string{
			"npm install -g " + ptcRuntimePackage + "@" + dshVersion,
			"mkdir -p /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai && ln -s /usr/local/lib/node_modules/" + ptcRuntimePackage + " /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/" + ptcRuntimePackageName,
		},
	}
	recipe, err := Containerfile(spec)
	if err != nil {
		return BuildSpec{}, err
	}
	spec.Labels = map[string]string{
		PTCVersionLabel: dshVersion,
		PTCRecipeLabel:  recipeDigest(recipe),
	}
	return spec, nil
}

// PTCImageLabels returns the labels the PTC image for a harness release must
// carry. A matching image is reused; anything else is rebuilt.
func PTCImageLabels(dshVersion string) (map[string]string, error) {
	spec, err := PTCBuildSpec(dshVersion)
	if err != nil {
		return nil, err
	}
	return spec.Labels, nil
}

// recipeDigest returns a stable digest of a rendered Containerfile, so the
// image's recipe label changes whenever the build instructions do.
func recipeDigest(containerfile string) string {
	sum := sha256.Sum256([]byte(containerfile))
	return "sha256:" + hex.EncodeToString(sum[:])
}

// LabelFingerprint returns a stable digest of an image's build labels. It
// identifies the exact image a container was created from: the tag is fixed,
// but the labels change whenever the release or recipe does.
func LabelFingerprint(labels map[string]string) string {
	keys := make([]string, 0, len(labels))
	for key := range labels {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	digest := sha256.New()
	for _, key := range keys {
		fmt.Fprintf(digest, "%s=%s\n", key, labels[key])
	}
	return "sha256:" + hex.EncodeToString(digest.Sum(nil))
}

// BaseImages is the fixed registry of base images, in listing order.
var BaseImages = []BaseImage{
	{
		ID: "archlinux", Primitive: "docker.io/library/archlinux:latest", PackageManager: "pacman", CachePath: "/var/cache/pacman/pkg",
		Packages: []string{"base-devel", "ca-certificates", "curl", "diffutils", "fd", "git", "inetutils", "jq", "less", "openbsd-netcat", "openssh", "patch", "procps-ng", "python", "ripgrep", "tree", "unzip", "wget", "zstd"},
	},
	{
		ID: "ubuntu", Primitive: "docker.io/library/ubuntu:latest", PackageManager: "apt", CachePath: "/var/cache/apt/archives",
		Packages:    []string{"build-essential", "ca-certificates", "curl", "diffutils", "fd-find", "git", "jq", "less", "netcat-openbsd", "openssh-client", "patch", "procps", "python3", "ripgrep", "tree", "unzip", "wget", "zstd"},
		PostInstall: []string{"ln -s /usr/bin/fd-find /usr/local/bin/fd"},
	},
	{
		ID: "alpine", Primitive: "docker.io/library/alpine:latest", PackageManager: "apk", CachePath: "/etc/apk/cache",
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
	CachePackages  bool
	// Labels are stamped on the built image, not rendered into the
	// Containerfile, so a recipe digest label can be computed from that file
	// without changing it.
	Labels map[string]string
}

// Containerfile renders a Containerfile for the given build spec. Every
// package is validated and the FROM reference is validated as a base image
// reference (a primitive full ref for bases, a resolved parent tag for custom
// images). Base and custom builds differ only by their FROM reference and
// packages; no guest-agent stage is emitted.
func Containerfile(spec BuildSpec) (string, error) {
	for _, pkg := range spec.Packages {
		if !validPackage(pkg) {
			return "", fmt.Errorf("invalid package name %q", pkg)
		}
	}
	if !validBaseImage(spec.From) {
		return "", fmt.Errorf("invalid base image %q", spec.From)
	}
	lines := make([]string, 0, 7)
	lines = append(lines, "FROM "+spec.From)
	switch spec.PackageManager {
	case "pacman":
		line := "RUN pacman -Syu --needed --noconfirm"
		if len(spec.Packages) > 0 {
			line += " " + strings.Join(spec.Packages, " ")
		}
		lines = append(lines, line)
	case "apt":
		// The official Debian/Ubuntu images ship docker-clean, whose
		// Post-Invoke hooks delete /var/cache/apt/archives/*.deb after every
		// apt/dpkg run — exactly the directory a build mounts as the package
		// cache. Drop those two hooks (keeping the pkgcache suppression, so the
		// built image stays lean) and state the retention explicitly.
		line := "RUN sed -i '/Post-Invoke/d' /etc/apt/apt.conf.d/docker-clean && printf 'APT::Keep-Downloaded-Packages \"true\";\\n' > /etc/apt/apt.conf.d/99dsh-podman-keep && DEBIAN_FRONTEND=noninteractive apt-get update && DEBIAN_FRONTEND=noninteractive apt-get dist-upgrade -y && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends"
		if len(spec.Packages) > 0 {
			line += " " + strings.Join(spec.Packages, " ")
		}
		line += " && rm -rf /var/lib/apt/lists/*"
		lines = append(lines, line)
	case "apk":
		line := "RUN apk upgrade --no-cache && apk add --no-cache"
		if spec.CachePackages {
			line = "RUN apk upgrade --cache-packages --update-cache && apk add --cache-packages --update-cache"
		}
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
	return strings.Join(lines, "\n") + "\n", nil
}

type Builder struct {
	Context         context.Context
	HostPacmanCache string
	HostAptCache    string
	HostApkCache    string
	ImagePrefix     string
	BaseImagePrefix string
	Logger          *slog.Logger

	// mu guards the shared package caches: builds take it for reading (they
	// still run concurrently) and a cache cleanup takes it for writing, so a
	// cleanup never deletes a package out from under a running build.
	mu sync.RWMutex
}

// logger returns the builder's logger, defaulting to the process logger.
func (b *Builder) logger() *slog.Logger {
	if b.Logger != nil {
		return b.Logger
	}
	return slog.Default()
}

// cacheMount returns the host cache directory and its container mount target
// for the given package manager, along with whether a host cache is
// configured. Caches are opt-in: an unset host cache disables caching for that
// package manager entirely.
func (b *Builder) cacheMount(packageManager string) (host, container string, configured bool) {
	switch packageManager {
	case "pacman":
		if b.HostPacmanCache == "" {
			return "", "", false
		}
		return b.HostPacmanCache, "/var/cache/pacman/pkg", true
	case "apt":
		if b.HostAptCache == "" {
			return "", "", false
		}
		return b.HostAptCache, "/var/cache/apt/archives", true
	case "apk":
		if b.HostApkCache == "" {
			return "", "", false
		}
		return b.HostApkCache, "/etc/apk/cache", true
	default:
		return "", "", false
	}
}

// Build holds the read lock for its whole duration. Builds may run
// concurrently (the read lock is shared), but a cache cleanup takes the write
// lock and therefore waits for them: deleting a package out from under a
// running build is exactly what this ordering prevents. A cleanup blocking for
// the length of a build is the intended trade-off.
func (b *Builder) Build(spec BuildSpec) (string, error) {
	b.mu.RLock()
	defer b.mu.RUnlock()
	if b.Context == nil {
		return "", fmt.Errorf("podman build context is not configured")
	}
	if !validImageID(spec.ImageID) {
		return "", fmt.Errorf("invalid image id %q", spec.ImageID)
	}
	hostCache, cacheTarget, cacheConfigured := b.cacheMount(spec.PackageManager)
	if cacheConfigured && !filepath.IsAbs(hostCache) {
		return "", fmt.Errorf("%s cache path must be an absolute path", spec.PackageManager)
	}
	spec.CachePackages = cacheConfigured
	contents, err := Containerfile(spec)
	if err != nil {
		return "", err
	}
	tag := b.tagFor(spec.ImageID, spec.IsBase)
	cacheVolume := ""
	if cacheConfigured {
		cacheVolume = hostCache + ":" + cacheTarget
	}
	logger := b.logger()
	logger.Info("building workspace image", "image_id", spec.ImageID, "from", spec.From, "package_manager", spec.PackageManager, "is_base", spec.IsBase, "packages", spec.Packages, "tag", tag, "build_volume", cacheVolume, "host_package_cache", hostCache)
	if err := b.requestBuild(buildRequest{ImageID: spec.ImageID, Tag: tag, Containerfile: contents, CacheVolume: cacheVolume, Labels: spec.Labels}); err != nil {
		logger.Error("workspace image build failed", "image_id", spec.ImageID, "error", err)
		return "", err
	}
	logger.Info("workspace image build completed", "image_id", spec.ImageID, "image_tag", tag)
	return tag, nil
}

func (b *Builder) imagePrefix() string {
	prefix := b.ImagePrefix
	if prefix == "" {
		prefix = "localhost/dsh-podman/"
	}
	if !strings.HasSuffix(prefix, "/") {
		prefix += "/"
	}
	return prefix
}

func (b *Builder) baseImagePrefix() string {
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
func (b *Builder) tagFor(imageID string, isBase bool) string {
	if isBase {
		return b.baseImagePrefix() + imageID + ":latest"
	}
	return b.imagePrefix() + imageID + ":latest"
}

// PTCImageTag returns the tag of the single PTC image. It is a custom-image
// tag: the PTC image is built on demand rather than registered as a base image.
func (b *Builder) PTCImageTag() string {
	return b.tagFor(PTCImageID(), false)
}

// BuildPTC builds the PTC image for a harness release and returns its tag. The
// caller checks the image's labels first: BuildPTC always builds, replacing the
// single tag, so reusing a matching image is what avoids an unnecessary build.
func (b *Builder) BuildPTC(dshVersion string) (string, error) {
	spec, err := PTCBuildSpec(dshVersion)
	if err != nil {
		return "", err
	}
	return b.Build(spec)
}
