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
	"gitlab.com/Exagone313/dsh-podman/internal/orchestrator/state"
)

var packageName = regexp.MustCompile(`^[A-Za-z0-9@+._:][A-Za-z0-9@+._:-]*$`)
var baseImageName = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._:/@-]*$`)
var imageIDName = regexp.MustCompile(`^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,99}$`)
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
	return id != "." && id != ".." && imageIDName.MatchString(id)
}

type GuestAgentImage struct {
	Image        string
	AgentBin     string
	DestAgentBin string
}

func Containerfile(image state.Image, guestAgent ...GuestAgentImage) (string, error) {
	for _, pkg := range image.Packages {
		if !validPackage(pkg) {
			return "", fmt.Errorf("invalid package name %q", pkg)
		}
	}
	if !validBaseImage(image.BaseImage) {
		return "", fmt.Errorf("invalid base image %q", image.BaseImage)
	}
	var guest GuestAgentImage
	if len(guestAgent) > 0 {
		guest = guestAgent[0]
	}
	if guest.Image != "" {
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
	lines := make([]string, 0, 5)
	if guest.Image != "" {
		lines = append(lines, "FROM "+guest.Image+" AS guestagent")
	}
	lines = append(lines, "FROM "+image.BaseImage)
	lines = append(lines, "RUN pacman -Syu --needed --noconfirm")
	if len(image.Packages) > 0 {
		lines[len(lines)-1] += " " + strings.Join(image.Packages, " ")
	}
	if guest.Image != "" {
		lines = append(lines, "COPY --from=guestagent "+guest.AgentBin+" "+guest.DestAgentBin)
	}
	if guest.Image != "" {
		lines = append(lines, "ENTRYPOINT [\""+guest.DestAgentBin+"\"]")
	} else {
		lines = append(lines, "ENTRYPOINT [\"/usr/local/bin/dsh-podman-guest-agent\"]")
	}
	return strings.Join(lines, "\n") + "\n", nil
}

type Builder struct {
	Context         context.Context
	StateDir        string
	HostPacmanCache string
	GuestAgentImage GuestAgentImage
	Logger          *slog.Logger
}

func (b Builder) Build(image state.Image) (string, error) {
	if b.Context == nil {
		return "", fmt.Errorf("podman build context is not configured")
	}
	if !validImageID(image.ImageID) {
		return "", fmt.Errorf("invalid image id %q", image.ImageID)
	}
	contents, err := Containerfile(image, b.GuestAgentImage)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(b.StateDir, 0700); err != nil {
		return "", err
	}
	dir := filepath.Join(b.StateDir, image.ImageID)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", err
	}
	file := filepath.Join(dir, "Containerfile")
	if err := os.WriteFile(file, []byte(contents), 0600); err != nil {
		return "", err
	}
	if b.HostPacmanCache == "" || !filepath.IsAbs(b.HostPacmanCache) {
		return "", fmt.Errorf("pacman cache path must be an absolute path")
	}
	tag := "localhost/dsh-workspace/" + image.ImageID + ":latest"
	options := entities.BuildOptions{ContainerFiles: []string{file}, BuildOptions: define.BuildOptions{CommonBuildOpts: &define.CommonBuildOptions{}}}
	options.ContextDirectory = dir
	options.AdditionalTags = []string{tag}
	options.CommonBuildOpts.Volumes = []string{b.HostPacmanCache + ":/var/cache/pacman/pkg"}
	logger := b.Logger
	if logger == nil {
		logger = slog.Default()
	}
	logger.Info("building workspace image", "image_id", image.ImageID, "base_image", image.BaseImage, "packages", image.Packages, "context_directory", dir, "container_files", options.ContainerFiles, "tags", options.AdditionalTags, "build_volumes", options.CommonBuildOpts.Volumes, "host_pacman_cache", b.HostPacmanCache)
	_, err = images.Build(b.Context, []string{file}, options)
	if err != nil {
		logger.Error("workspace image build failed", "image_id", image.ImageID, "error", err)
		return "", err
	}
	logger.Info("workspace image build completed", "image_id", image.ImageID, "image_tag", tag)
	return tag, nil
}
