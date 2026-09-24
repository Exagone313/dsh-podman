// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package podman

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"

	"go.podman.io/podman/v6/pkg/bindings"
	"go.podman.io/podman/v6/pkg/bindings/images"
)

// ImageExists reports whether the named image is present in local storage.
func (c *Client) ImageExists(name string) (bool, error) {
	if err := c.connReady(); err != nil {
		return false, err
	}
	ctx, cancel := c.lookupContext()
	defer cancel()
	exists, err := images.Exists(ctx, name, nil)
	if err != nil {
		c.log().Error("workspace image lookup failed", "image", name, "error", err)
	} else {
		c.log().Info("workspace image lookup completed", "image", name, "exists", exists)
	}
	return exists, err
}

// pullMessage is the subset of the pull stream's JSON messages we act on. The
// stream also carries registry progress, which is deliberately ignored: only
// errors are read.
type pullMessage struct {
	Error string `json:"error"`
}

// ImagePull pulls the named image into local storage by asking the Podman
// service to do it. The request goes straight to the libpod pull endpoint
// rather than through the images.Pull binding, whose auth header resolves the
// caller's registry credentials through the user's config directory: in a
// scratch image there is neither HOME nor /etc/passwd for that lookup to fall
// back on. Without a client auth header the service pulls with its own
// credentials, the same way builds pull their base images. The name is the only
// detail logged; pulled layers are never echoed.
func (c *Client) ImagePull(name string) error {
	if err := c.connReady(); err != nil {
		return err
	}
	c.log().Info("pulling image", "image", name)
	if err := c.pull(name); err != nil {
		c.log().Error("image pull failed", "image", name, "error", err)
		return err
	}
	c.log().Info("image pulled", "image", name)
	return nil
}

// pull sends one pull request and drains its progress stream, returning the
// first error the stream reports.
func (c *Client) pull(name string) error {
	connection, err := bindings.GetClient(c.ctx)
	if err != nil {
		return err
	}
	params := url.Values{}
	params.Set("reference", name)
	response, err := connection.DoRequest(c.ctx, nil, http.MethodPost, "/images/pull", params, http.Header{})
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if !response.IsSuccess() {
		return response.Process(nil)
	}
	decoder := json.NewDecoder(response.Body)
	for {
		var message pullMessage
		if err := decoder.Decode(&message); err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return fmt.Errorf("decode pull stream: %w", err)
		}
		if message.Error != "" {
			return errors.New(message.Error)
		}
	}
}

// ImageCreated returns the image's creation time as an RFC3339 string, or ""
// when the image does not exist or its creation time cannot be read.
func (c *Client) ImageCreated(name string) string {
	if err := c.connReady(); err != nil {
		return ""
	}
	ctx, cancel := c.lookupContext()
	defer cancel()
	report, err := images.GetImage(ctx, name, nil)
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
