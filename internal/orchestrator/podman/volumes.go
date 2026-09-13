// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package podman

import (
	"fmt"

	"go.podman.io/podman/v6/pkg/bindings/volumes"
	entities "go.podman.io/podman/v6/pkg/domain/entities/types"
)

func (c *Client) VolumeExists(name string) (bool, error) {
	return volumes.Exists(c.ctx, name, nil)
}

// ensureVolume auto-creates a named volume when it does not already exist.
func (c *Client) ensureVolume(name string) error {
	exists, err := c.VolumeExists(name)
	if err != nil {
		return err
	}
	if exists {
		return nil
	}
	return c.VolumeCreate(name)
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
