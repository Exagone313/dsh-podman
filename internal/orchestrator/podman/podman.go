// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package podman

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"

	"github.com/containers/podman/v5/pkg/bindings"
	"github.com/containers/podman/v5/pkg/bindings/containers"
	"github.com/containers/podman/v5/pkg/bindings/images"
	"github.com/containers/podman/v5/pkg/bindings/pods"
	"github.com/containers/podman/v5/pkg/bindings/volumes"
	entities "github.com/containers/podman/v5/pkg/domain/entities/types"
	"github.com/containers/podman/v5/pkg/specgen"
	"github.com/opencontainers/runtime-spec/specs-go"
)

type Client struct {
	ctx                                                                   context.Context
	socketRoot, hostSocketRoot, projectRoot, guestBinary, hostGuestBinary string
	logger                                                                *slog.Logger
}

func New(ctx context.Context, socket, socketRoot, guestBinary, hostSocketRoot, projectRoot, hostGuestBinary string, logger *slog.Logger) (*Client, error) {
	connected, err := bindings.NewConnection(ctx, socket)
	if err != nil {
		return nil, err
	}
	return &Client{ctx: connected, socketRoot: socketRoot, hostSocketRoot: hostSocketRoot, projectRoot: projectRoot, guestBinary: guestBinary, hostGuestBinary: hostGuestBinary, logger: logger}, nil
}

func (c *Client) log() *slog.Logger {
	if c.logger != nil {
		return c.logger
	}
	return slog.Default()
}

// EnsurePod lazily creates the pod when it does not already exist. Containers
// created afterwards are placed inside it, sharing its network namespace.
func (c *Client) EnsurePod(name string) error {
	exists, err := pods.Exists(c.ctx, name, nil)
	if err != nil {
		return err
	}
	if exists {
		return nil
	}
	c.log().Info("creating pod", "pod_name", name)
	_, err = pods.CreatePodFromSpec(c.ctx, &entities.PodSpec{PodSpecGen: specgen.PodSpecGenerator{Name: name}})
	if err != nil {
		c.log().Error("pod creation failed", "pod_name", name, "error", err)
		return fmt.Errorf("create pod: %w", err)
	}
	return nil
}

// RemovePod deletes the pod, tolerating an already-absent pod.
func (c *Client) RemovePod(name string) error {
	exists, err := pods.Exists(c.ctx, name, nil)
	if err != nil {
		return err
	}
	if !exists {
		return nil
	}
	c.log().Info("removing pod", "pod_name", name)
	if _, err := pods.Remove(c.ctx, name, &pods.RemoveOptions{Force: boolPtr(true)}); err != nil {
		c.log().Error("pod removal failed", "pod_name", name, "error", err)
		return fmt.Errorf("remove pod: %w", err)
	}
	return nil
}

func (c *Client) CreateWorkspace(pod, name, image, token string, mounts []specs.Mount) error {
	c.log().Info("creating guest container", "pod_name", pod, "container_name", name, "image", image, "mount_count", len(mounts))
	socketDir := filepath.Join(c.socketRoot, name)
	hostSocketDir := filepath.Join(c.hostSocketRoot, name)
	if err := os.MkdirAll(socketDir, 0700); err != nil {
		return err
	}
	if err := c.EnsurePod(pod); err != nil {
		return err
	}
	init := true
	generator := specgen.NewSpecGenerator(image, false)
	generator.Name = name
	generator.Pod = pod
	generator.Command = []string{c.guestBinary}
	generator.Env = map[string]string{"DSH_PODMAN_GUEST_TOKEN": token, "DSH_PODMAN_GUEST_SOCKET": filepath.Join(c.socketRoot, name, "guest.sock"), "DSH_PODMAN_PROJECTS_ROOT": c.projectRoot}
	generator.Init = &init
	generator.ReadOnlyFilesystem = boolPtr(true)
	generator.Mounts = append(mounts, guestAgentMounts(hostSocketDir, c.socketRoot, name, c.hostGuestBinary, c.guestBinary)...)
	if _, err := containers.CreateWithSpec(c.ctx, generator, nil); err != nil {
		c.log().Error("guest container creation failed", "pod_name", pod, "container_name", name, "error", err)
		return fmt.Errorf("create container: %w", err)
	}
	if err := containers.Start(c.ctx, name, nil); err != nil {
		c.log().Error("guest container start failed", "pod_name", pod, "container_name", name, "error", err)
		return err
	}
	c.log().Info("guest container started", "pod_name", pod, "container_name", name)
	return nil
}

func guestAgentMounts(hostSocketDir, socketRoot, name, hostGuestBinary, guestBinary string) []specs.Mount {
	mounts := []specs.Mount{{Type: "bind", Source: hostSocketDir, Destination: filepath.Join(socketRoot, name), Options: []string{"rw"}}}
	if hostGuestBinary != "" {
		mounts = append([]specs.Mount{{Type: "bind", Source: hostGuestBinary, Destination: guestBinary, Options: []string{"ro"}}}, mounts...)
	}
	return mounts
}
func (c *Client) Stop(name string) error {
	c.log().Info("stopping guest container", "container_name", name)
	err := containers.Stop(c.ctx, name, nil)
	if err != nil {
		c.log().Error("guest container stop failed", "container_name", name, "error", err)
	} else {
		c.log().Info("guest container stopped", "container_name", name)
	}
	return err
}
func (c *Client) ContainerExists(name string) (bool, error) {
	exists, err := containers.Exists(c.ctx, name, nil)
	if err != nil {
		c.log().Error("guest container lookup failed", "container_name", name, "error", err)
	} else {
		c.log().Info("guest container lookup completed", "container_name", name, "exists", exists)
	}
	return exists, err
}

func boolPtr(value bool) *bool {
	return &value
}

func (c *Client) ImageExists(name string) (bool, error) {
	exists, err := images.Exists(c.ctx, name, nil)
	if err != nil {
		c.log().Error("workspace image lookup failed", "image", name, "error", err)
	} else {
		c.log().Info("workspace image lookup completed", "image", name, "exists", exists)
	}
	return exists, err
}
func (c *Client) Remove(name string) error {
	c.log().Info("removing guest container", "container_name", name)
	_, err := containers.Remove(c.ctx, name, &containers.RemoveOptions{})
	if err != nil {
		c.log().Error("guest container removal failed", "container_name", name, "error", err)
	} else {
		c.log().Info("guest container removed", "container_name", name)
	}
	return err
}

func (c *Client) RecreateWorkspace(pod, name, image, token string, mounts []specs.Mount) error {
	c.log().Info("recreating guest container", "pod_name", pod, "container_name", name, "image", image, "mount_count", len(mounts))
	if err := c.Stop(name); err != nil {
		return err
	}
	if err := c.Remove(name); err != nil {
		return err
	}
	return c.CreateWorkspace(pod, name, image, token, mounts)
}

func (c *Client) VolumeExists(name string) (bool, error) {
	return volumes.Exists(c.ctx, name, nil)
}

func (c *Client) VolumeCreate(name string) error {
	_, err := volumes.Create(c.ctx, entities.VolumeCreateOptions{Name: name}, nil)
	if err != nil {
		c.log().Error("volume creation failed", "volume_name", name, "error", err)
		return fmt.Errorf("create volume: %w", err)
	}
	c.log().Info("volume created", "volume_name", name)
	return nil
}

func (c *Client) VolumeList() ([]string, error) {
	reports, err := volumes.List(c.ctx, nil)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(reports))
	for _, report := range reports {
		names = append(names, report.Name)
	}
	return names, nil
}

func (c *Client) VolumeRemove(name string) error {
	if err := volumes.Remove(c.ctx, name, &volumes.RemoveOptions{Force: boolPtr(true)}); err != nil {
		c.log().Error("volume removal failed", "volume_name", name, "error", err)
		return fmt.Errorf("remove volume: %w", err)
	}
	c.log().Info("volume removed", "volume_name", name)
	return nil
}
