package images

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/containers/podman/v5/pkg/bindings/images"
	entities "github.com/containers/podman/v5/pkg/domain/entities/types"
	"gitlab.com/Exagone313/dsh-container-plugin/internal/orchestrator/state"
)

var packageName = regexp.MustCompile(`^[A-Za-z0-9@+._:-]+$`)

func Containerfile(image state.Image) (string, error) {
	return ContainerfileWithCache(image, "")
}

func ContainerfileWithCache(image state.Image, cacheSource string) (string, error) {
	for _, pkg := range image.Packages {
		if !packageName.MatchString(pkg) {
			return "", fmt.Errorf("invalid package name %q", pkg)
		}
	}
	if cacheSource != "" && !filepath.IsAbs(cacheSource) {
		return "", fmt.Errorf("pacman cache source must be an absolute path")
	}
	mount := "RUN --mount=type=cache,target=/var/cache/pacman/pkg,sharing=locked,id=pacman-cache"
	if cacheSource != "" {
		mount += ",source=" + cacheSource
	}
	lines := []string{"FROM " + image.BaseImage, mount + " pacman -Sy --noconfirm"}
	if len(image.Packages) > 0 {
		lines[1] += " " + strings.Join(image.Packages, " ")
	}
	lines[1] += " && pacman -Scc --noconfirm"
	lines = append(lines, "ENTRYPOINT [\"/usr/local/bin/dsh-workspace-agent\"]")
	return strings.Join(lines, "\n") + "\n", nil
}

type Builder struct {
	Context         context.Context
	StateDir        string
	HostPacmanCache string
}

func (b Builder) Build(image state.Image) (string, error) {
	contents, err := ContainerfileWithCache(image, b.HostPacmanCache)
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
	tag := "localhost/dsh-workspace/" + image.ImageID + ":latest"
	options := entities.BuildOptions{ContainerFiles: []string{file}}
	options.ContextDirectory = dir
	options.AdditionalTags = []string{tag}
	_, err = images.Build(b.Context, []string{file}, options)
	if err != nil {
		return "", err
	}
	return tag, nil
}
