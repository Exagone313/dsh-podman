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

func (c *Client) CreateWorkspace(name, image, token string, mounts []specs.Mount) error {
	c.log().Info("creating guest container", "container_name", name, "image", image, "mount_count", len(mounts))
	socketDir := filepath.Join(c.socketRoot, name)
	hostSocketDir := filepath.Join(c.hostSocketRoot, name)
	if err := os.MkdirAll(socketDir, 0700); err != nil {
		return err
	}
	init := true
	generator := specgen.NewSpecGenerator(image, false)
	generator.Name = name
	generator.Command = []string{c.guestBinary}
	generator.Env = map[string]string{"DSH_PODMAN_GUEST_TOKEN": token, "DSH_PODMAN_GUEST_SOCKET": filepath.Join(c.socketRoot, name, "guest.sock"), "DSH_PODMAN_PROJECTS_ROOT": c.projectRoot}
	generator.Init = &init
	generator.Mounts = append(mounts, guestAgentMounts(hostSocketDir, c.socketRoot, name, c.hostGuestBinary, c.guestBinary)...)
	if _, err := containers.CreateWithSpec(c.ctx, generator, nil); err != nil {
		c.log().Error("guest container creation failed", "container_name", name, "error", err)
		return fmt.Errorf("create container: %w", err)
	}
	if err := containers.Start(c.ctx, name, nil); err != nil {
		c.log().Error("guest container start failed", "container_name", name, "error", err)
		return err
	}
	c.log().Info("guest container started", "container_name", name)
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
func (c *Client) List() ([]entities.ListContainer, error) {
	c.log().Info("listing containers")
	result, err := containers.List(c.ctx, &containers.ListOptions{All: boolPtr(true)})
	if err != nil {
		c.log().Error("container list failed", "error", err)
		return nil, err
	}
	c.log().Info("container list completed", "count", len(result))
	return result, nil
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

func (c *Client) RecreateWorkspace(name, image, token string, mounts []specs.Mount) error {
	c.log().Info("recreating guest container", "container_name", name, "image", image, "mount_count", len(mounts))
	if err := c.Stop(name); err != nil {
		return err
	}
	if err := c.Remove(name); err != nil {
		return err
	}
	return c.CreateWorkspace(name, image, token, mounts)
}
