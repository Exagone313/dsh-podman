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
	"strings"
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

// ImageTags returns the set of repository tags present in local storage from a
// single list call. It is how a batch of stored records is checked against
// podman without one inspect per record. A tag absent from the set is not in
// local storage; an empty (but non-nil) set means nothing is stored at all.
func (c *Client) ImageTags() (map[string]struct{}, error) {
	if err := c.connReady(); err != nil {
		return nil, err
	}
	ctx, cancel := c.lookupContext()
	defer cancel()
	summaries, err := images.List(ctx, nil)
	if err != nil {
		c.log().Error("workspace image listing failed", "error", err)
		return nil, err
	}
	tags := make(map[string]struct{})
	for _, summary := range summaries {
		if summary == nil {
			continue
		}
		for _, tag := range summary.RepoTags {
			tags[tag] = struct{}{}
		}
	}
	c.log().Info("workspace image listing completed", "tag_count", len(tags))
	return tags, nil
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

// ImageLabels returns the labels stamped on an image. It is how the PTC image's
// build inputs are read back: the tag never changes, so only the labels can
// tell whether an existing image already carries the requested release and
// recipe.
func (c *Client) ImageLabels(name string) (map[string]string, error) {
	if err := c.connReady(); err != nil {
		return nil, err
	}
	ctx, cancel := c.lookupContext()
	defer cancel()
	report, err := images.GetImage(ctx, name, nil)
	if err != nil {
		c.log().Error("workspace image inspect failed", "image", name, "error", err)
		return nil, err
	}
	return report.Labels, nil
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

// ErrImageUnknown is the service's sentinel for a reference it does not store
// locally. The v6 bindings transport libpod's errors as plain strings
// ("<reference>: image not known"), so IsImageUnknown matches the exact trailing
// message rather than the leading reference, which callers control and which
// must never decide whether a failure is swallowed.
var ErrImageUnknown = errors.New("image not known")

// imageUnknownMessages are the exact service messages denoting an absent image.
var imageUnknownMessages = []string{ErrImageUnknown.Error(), "no such image"}

// IsImageUnknown reports whether err is podman's answer for an image reference
// it does not store locally.
func IsImageUnknown(err error) bool {
	if err == nil {
		return false
	}
	if errors.Is(err, ErrImageUnknown) {
		return true
	}
	message := err.Error()
	for _, unknown := range imageUnknownMessages {
		if message == unknown || strings.HasSuffix(message, ": "+unknown) {
			return true
		}
	}
	return false
}

// ImageRemove deletes the named image from local storage, idempotently: an
// image already absent is a no-op. Force also removes the containers still
// using the image; on its own it does not tolerate absence (podman answers
// "image not known" for an unknown reference), so Ignore makes the service skip
// it. Any remaining not-known answer is filtered here too, in case the service
// did not honour ignore. Every other error is joined into one, preserving its
// cause.
func (c *Client) ImageRemove(name string) error {
	if err := c.connReady(); err != nil {
		return err
	}
	c.log().Info("removing image", "image", name)
	_, errs := images.Remove(c.ctx, []string{name}, &images.RemoveOptions{Force: boolPtr(true), Ignore: boolPtr(true)})
	var joined error
	for _, err := range errs {
		if err != nil && !IsImageUnknown(err) {
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
