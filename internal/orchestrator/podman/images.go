// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package podman

import (
	"errors"
	"time"

	"go.podman.io/podman/v6/pkg/bindings/images"
)

// ImageExists reports whether the named image is present in local storage.
func (c *Client) ImageExists(name string) (bool, error) {
	if err := c.connReady(); err != nil {
		return false, err
	}
	exists, err := images.Exists(c.ctx, name, nil)
	if err != nil {
		c.log().Error("workspace image lookup failed", "image", name, "error", err)
	} else {
		c.log().Info("workspace image lookup completed", "image", name, "exists", exists)
	}
	return exists, err
}

// ImagePull pulls the named image into local storage. The name is the only
// detail logged; pulled layers are never echoed.
func (c *Client) ImagePull(name string) error {
	if err := c.connReady(); err != nil {
		return err
	}
	c.log().Info("pulling image", "image", name)
	if _, err := images.Pull(c.ctx, name, nil); err != nil {
		c.log().Error("image pull failed", "image", name, "error", err)
		return err
	}
	c.log().Info("image pulled", "image", name)
	return nil
}

// ImageCreated returns the image's creation time as an RFC3339 string, or ""
// when the image does not exist or its creation time cannot be read.
func (c *Client) ImageCreated(name string) string {
	if err := c.connReady(); err != nil {
		return ""
	}
	report, err := images.GetImage(c.ctx, name, nil)
	if err != nil {
		return ""
	}
	return report.Created.UTC().Format(time.RFC3339)
}

// ImageRemove deletes the named image from local storage, tolerating an
// already-absent image via the force option. Any non-nil errors reported by
// images.Remove are joined into a single error.
func (c *Client) ImageRemove(name string) error {
	if err := c.connReady(); err != nil {
		return err
	}
	c.log().Info("removing image", "image", name)
	_, errs := images.Remove(c.ctx, []string{name}, &images.RemoveOptions{Force: boolPtr(true)})
	var joined error
	for _, err := range errs {
		if err != nil {
			joined = errors.Join(joined, err)
		}
	}
	if joined != nil {
		c.log().Error("image removal failed", "image", name, "error", joined)
		return joined
	}
	c.log().Info("image removed", "image", name)
	return nil
}
