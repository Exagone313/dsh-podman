// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package podman

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"go.podman.io/podman/v6/pkg/bindings"
)

// pullServer starts a fake Podman API for one pull request. It records the
// request and answers with the given pull stream.
func pullServer(t *testing.T, stream string, got *http.Request) *Client {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*got = *r
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, stream)
	}))
	t.Cleanup(server.Close)
	ctx, err := bindings.NewConnection(context.Background(), "tcp://"+server.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	return &Client{ctx: ctx, logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
}

// TestImagePullAsksTheService pins that the pull is sent to the libpod pull
// endpoint with the reference, and without an auth header: the service pulls
// with its own credentials.
func TestImagePullAsksTheService(t *testing.T) {
	var request http.Request
	client := pullServer(t, `{"status":"success","images":["sha256:abc"]}`, &request)
	if err := client.ImagePull("ghcr.io/example/guest:1"); err != nil {
		t.Fatal(err)
	}
	if request.Method != http.MethodPost {
		t.Errorf("method = %q, want POST", request.Method)
	}
	if !strings.HasSuffix(request.URL.Path, "/libpod/images/pull") {
		t.Errorf("path = %q, want a /libpod/images/pull suffix", request.URL.Path)
	}
	if got := request.URL.Query().Get("reference"); got != "ghcr.io/example/guest:1" {
		t.Errorf("reference = %q", got)
	}
	if got := request.Header.Get("X-Registry-Auth"); got != "" {
		t.Errorf("X-Registry-Auth = %q, want it unset", got)
	}
}

// TestImagePullReportsStreamErrors pins that an error reported inside the pull
// stream is returned.
func TestImagePullReportsStreamErrors(t *testing.T) {
	var request http.Request
	client := pullServer(t, `{"stream":"pulling"}{"error":"manifest unknown"}`, &request)
	err := client.ImagePull("ghcr.io/example/guest:1")
	if err == nil || !strings.Contains(err.Error(), "manifest unknown") {
		t.Fatalf("unexpected error: %v", err)
	}
}

// TestImagePullObeysTheConnection pins that a client without a Podman
// connection fails before sending anything.
func TestImagePullObeysTheConnection(t *testing.T) {
	client := &Client{}
	if err := client.ImagePull("ghcr.io/example/guest:1"); err == nil {
		t.Fatal("expected an error without a Podman connection")
	}
}
