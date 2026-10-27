// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package podman

import (
	"context"
	"errors"
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

// TestImageLabelsReadsTheInspectReport pins that labels are read back from the
// inspect endpoint, which is how the PTC image's build inputs are compared.
func TestImageLabelsReadsTheInspectReport(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// The bindings ping the service before the first call.
		if strings.HasSuffix(r.URL.Path, "/_ping") {
			return
		}
		if !strings.HasSuffix(r.URL.Path, "/json") {
			t.Errorf("path = %q, want an inspect suffix", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"Labels":{"io.example.release":"1.2.3"}}`)
	}))
	t.Cleanup(server.Close)
	ctx, err := bindings.NewConnection(context.Background(), "tcp://"+server.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	client := &Client{ctx: ctx, logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	labels, err := client.ImageLabels("localhost/dsh-podman/ptc:latest")
	if err != nil {
		t.Fatal(err)
	}
	if labels["io.example.release"] != "1.2.3" {
		t.Fatalf("unexpected labels: %#v", labels)
	}
}

// TestImageTagsReadsTheList pins that the batch presence check is one list
// call returning repository tags, not an inspect per record.
func TestImageTagsReadsTheList(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// The bindings ping the service before the first call.
		if strings.HasSuffix(r.URL.Path, "/_ping") {
			return
		}
		if !strings.HasSuffix(r.URL.Path, "/images/json") {
			t.Errorf("path = %q, want an image list suffix", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `[{"Id":"sha256:abc","RepoTags":["localhost/a:latest","localhost/b:latest"]},{"Id":"sha256:def","RepoTags":[]}]`)
	}))
	t.Cleanup(server.Close)
	ctx, err := bindings.NewConnection(context.Background(), "tcp://"+server.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	client := &Client{ctx: ctx, logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	tags, err := client.ImageTags()
	if err != nil {
		t.Fatal(err)
	}
	if len(tags) != 2 {
		t.Fatalf("expected the two repository tags, got %#v", tags)
	}
	for _, tag := range []string{"localhost/a:latest", "localhost/b:latest"} {
		if _, ok := tags[tag]; !ok {
			t.Fatalf("tag %q is missing from the set: %#v", tag, tags)
		}
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

// imageRemoveServer starts a fake Podman API for one image removal, answering
// with the given batch-removal report.
func imageRemoveServer(t *testing.T, report string, got *http.Request) *Client {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/_ping") {
			return
		}
		*got = *r
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, report)
	}))
	t.Cleanup(server.Close)
	ctx, err := bindings.NewConnection(context.Background(), "tcp://"+server.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	return &Client{ctx: ctx, logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
}

// TestImageRemoveToleratesAnAbsentImage pins the fix for a record whose podman
// image was deleted outside dsh-podman: the removal asks the service to ignore
// an absent reference (force alone only removes the containers using it), and a
// not-known answer is success, not a failure that would surface as INTERNAL.
func TestImageRemoveToleratesAnAbsentImage(t *testing.T) {
	const tag = "localhost/dsh-podman/gone:latest"
	var request http.Request
	client := imageRemoveServer(t, `{"ExitCode":1,"Errors":["`+tag+`: image not known"]}`, &request)
	if err := client.ImageRemove(tag); err != nil {
		t.Fatalf("an absent image must be tolerated: %v", err)
	}
	if request.Method != http.MethodDelete {
		t.Errorf("method = %q, want DELETE", request.Method)
	}
	if !strings.HasSuffix(request.URL.Path, "/images/remove") {
		t.Errorf("path = %q, want an /images/remove suffix", request.URL.Path)
	}
	if got := request.URL.Query().Get("ignore"); got != "true" {
		t.Errorf("ignore = %q, want true", got)
	}
	if got := request.URL.Query().Get("force"); got != "true" {
		t.Errorf("force = %q, want true", got)
	}
}

// TestImageRemoveKeepsAGenuineFailure pins that tolerating absence does not
// swallow a real removal failure: the podman cause is returned.
func TestImageRemoveKeepsAGenuineFailure(t *testing.T) {
	const tag = "localhost/dsh-podman/valkey:latest"
	var request http.Request
	client := imageRemoveServer(t, `{"ExitCode":2,"Errors":["`+tag+`: image is in use by a container"]}`, &request)
	err := client.ImageRemove(tag)
	if err == nil || !strings.Contains(err.Error(), "image is in use by a container") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestIsImageUnknown(t *testing.T) {
	cases := []struct {
		name string
		err  error
		want bool
	}{
		{"nil", nil, false},
		{"exact sentinel", errors.New("image not known"), true},
		{"wrapped sentinel", fmt.Errorf("remove: %w", ErrImageUnknown), true},
		{"reference-prefixed sentinel", errors.New("localhost/dsh-podman/gone:latest: image not known"), true},
		{"compat sentinel", errors.New("localhost/dsh-podman/gone:latest: no such image"), true},
		{"forged prefix", errors.New("image not known: permission denied"), false},
		{"genuine failure", errors.New("image is in use by a container"), false},
	}
	for _, tc := range cases {
		if got := IsImageUnknown(tc.err); got != tc.want {
			t.Errorf("%s: IsImageUnknown(%v) = %v, want %v", tc.name, tc.err, got, tc.want)
		}
	}
}
