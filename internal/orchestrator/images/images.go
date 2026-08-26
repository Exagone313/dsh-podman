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
	"gitlab.com/Exagone313/dsh-container-plugin/internal/orchestrator/state"
)

var packageName = regexp.MustCompile(`^[A-Za-z0-9@+._:-]+$`)

func Containerfile(image state.Image) (string, error) {
	for _, pkg := range image.Packages {
		if !packageName.MatchString(pkg) {
			return "", fmt.Errorf("invalid package name %q", pkg)
		}
	}
	lines := []string{"FROM " + image.BaseImage, "RUN pacman -Sy --noconfirm"}
	if len(image.Packages) > 0 {
		lines[1] += " " + strings.Join(image.Packages, " ")
	}
	lines = append(lines, "ENTRYPOINT [\"/usr/local/bin/dsh-workspace-agent\"]")
	return strings.Join(lines, "\n") + "\n", nil
}

type Builder struct {
	Context         context.Context
	StateDir        string
	HostPacmanCache string
	Logger          *slog.Logger
}

func (b Builder) Build(image state.Image) (string, error) {
	if b.Context == nil {
		return "", fmt.Errorf("podman build context is not configured")
	}
	contents, err := Containerfile(image)
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
