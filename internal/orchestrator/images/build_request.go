// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package images

import (
	"archive/tar"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"

	"go.podman.io/podman/v6/pkg/bindings"
)

// containerFileName is the name the rendered Containerfile takes inside the
// build context, and the path the API is told to build from.
const containerFileName = "Containerfile"

// buildRequest is one image build to stream to the Podman API.
type buildRequest struct {
	ImageID       string
	Tag           string
	Containerfile string
	// CacheVolume, when set, is the host:container package-cache mount.
	CacheVolume string
}

// buildMessage is the subset of the build stream's JSON messages we act on:
// progress output, and the two spellings of an error the API uses.
type buildMessage struct {
	Stream       string `json:"stream"`
	ErrorMessage string `json:"error"`
	Error        *struct {
		Message string `json:"message"`
	} `json:"errorDetail"`
}

// buildContextTar packs the rendered Containerfile into an in-memory build
// context: a tar holding the file at its root, which is what the build API
// takes as its request body. Nothing touches the filesystem, so the state
// directory holds state only.
func buildContextTar(containerfile string) (*bytes.Reader, error) {
	buffer := &bytes.Buffer{}
	writer := tar.NewWriter(buffer)
	body := []byte(containerfile)
	header := &tar.Header{Name: containerFileName, Mode: 0o600, Size: int64(len(body))}
	if err := writer.WriteHeader(header); err != nil {
		return nil, err
	}
	if _, err := writer.Write(body); err != nil {
		return nil, err
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	return bytes.NewReader(buffer.Bytes()), nil
}

// requestBuild streams the context to the Podman API's libpod build endpoint
// and returns the build's error, if the stream reports one. The build output is
// logged line by line as it arrives, so a failed build still shows what it did
// before it failed.
func (b *Builder) requestBuild(request buildRequest) error {
	body, err := buildContextTar(request.Containerfile)
	if err != nil {
		return err
	}
	connection, err := bindings.GetClient(b.Context)
	if err != nil {
		return err
	}
	params := url.Values{}
	params.Add("t", request.Tag)
	params.Set("dockerfile", containerFileName)
	if request.CacheVolume != "" {
		params.Add("volume", request.CacheVolume)
	}
	headers := http.Header{"Content-Type": []string{"application/x-tar"}}
	response, err := connection.DoRequest(b.Context, body, http.MethodPost, "/build", params, headers)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if !response.IsSuccess() {
		return response.Process(nil)
	}
	logger := b.logger()
	decoder := json.NewDecoder(response.Body)
	for {
		var message buildMessage
		if err := decoder.Decode(&message); err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return fmt.Errorf("decode build stream: %w", err)
		}
		// Progress is logged before the error is inspected, so everything the
		// server sent before failing is reported.
		for _, line := range strings.Split(message.Stream, "\n") {
			if line != "" {
				logger.Info(line, "image_id", request.ImageID)
			}
		}
		if message.Error != nil && message.Error.Message != "" {
			return errors.New(message.Error.Message)
		}
		if message.ErrorMessage != "" {
			return errors.New(message.ErrorMessage)
		}
	}
}
