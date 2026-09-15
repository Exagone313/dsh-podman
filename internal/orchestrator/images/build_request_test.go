// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package images

import (
	"archive/tar"
	"bytes"
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

func TestBuildContextTar(t *testing.T) {
	reader, err := buildContextTar("FROM scratch\n")
	if err != nil {
		t.Fatal(err)
	}
	archive := tar.NewReader(reader)
	header, err := archive.Next()
	if err != nil {
		t.Fatal(err)
	}
	if header.Name != "Containerfile" || header.Mode != 0o600 || header.Size != int64(len("FROM scratch\n")) {
		t.Fatalf("unexpected header: %#v", header)
	}
	body, err := io.ReadAll(archive)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "FROM scratch\n" {
		t.Fatalf("unexpected body: %q", body)
	}
	if _, err := archive.Next(); err != io.EOF {
		t.Fatalf("expected a single entry, got %v", err)
	}
}

// buildServer starts a fake Podman API for one build request. It records the
// request and answers with the given build stream.
func buildServer(t *testing.T, stream string, got *http.Request, gotBody *string) context.Context {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*got = *r
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("read request body: %v", err)
		}
		*gotBody = string(body)
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, stream)
	}))
	t.Cleanup(server.Close)
	ctx, err := bindings.NewConnection(context.Background(), "tcp://"+server.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	return ctx
}

func TestRequestBuildStreamsContext(t *testing.T) {
	var request http.Request
	var body string
	ctx := buildServer(t, `{"stream":"Step 1/1 : FROM scratch\n"}`, &request, &body)
	builder := Builder{Context: ctx}
	err := builder.requestBuild(buildRequest{
		ImageID:       "dev",
		Tag:           "localhost/dsh-podman/dev:latest",
		Containerfile: "FROM scratch\n",
		CacheVolume:   "/host/cache:/var/cache/pacman/pkg",
	})
	if err != nil {
		t.Fatal(err)
	}
	if request.Method != http.MethodPost {
		t.Errorf("method = %q, want POST", request.Method)
	}
	if !strings.HasSuffix(request.URL.Path, "/libpod/build") {
		t.Errorf("path = %q, want a /libpod/build suffix", request.URL.Path)
	}
	if got := request.URL.Query().Get("t"); got != "localhost/dsh-podman/dev:latest" {
		t.Errorf("t = %q", got)
	}
	if got := request.URL.Query().Get("dockerfile"); got != "Containerfile" {
		t.Errorf("dockerfile = %q", got)
	}
	if got := request.URL.Query().Get("volume"); got != "/host/cache:/var/cache/pacman/pkg" {
		t.Errorf("volume = %q", got)
	}
	if got := request.Header.Get("Content-Type"); got != "application/x-tar" {
		t.Errorf("Content-Type = %q", got)
	}
	archive := tar.NewReader(strings.NewReader(body))
	header, err := archive.Next()
	if err != nil {
		t.Fatal(err)
	}
	content, err := io.ReadAll(archive)
	if err != nil {
		t.Fatal(err)
	}
	if header.Name != "Containerfile" || string(content) != "FROM scratch\n" {
		t.Fatalf("unexpected context tar: %q = %q", header.Name, content)
	}
}

// TestRequestBuildLogsProgressBeforeFailing pins that a failed build still
// reports the output it produced before the error, and that the error is
// returned.
func TestRequestBuildLogsProgressBeforeFailing(t *testing.T) {
	var request http.Request
	var body string
	ctx := buildServer(t, `{"stream":"Step 1/1 : FROM scratch\n"}{"errorDetail":{"message":"boom"}}`, &request, &body)
	var logs bytes.Buffer
	builder := Builder{Context: ctx, Logger: slog.New(slog.NewTextHandler(&logs, nil))}
	err := builder.requestBuild(buildRequest{ImageID: "dev", Tag: "t", Containerfile: "FROM scratch\n"})
	if err == nil || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(logs.String(), "Step 1/1 : FROM scratch") {
		t.Fatalf("progress was not logged before the failure: %q", logs.String())
	}
}

// TestRequestBuildObeysTheConnection pins that a builder without a Podman
// connection fails before sending anything.
func TestRequestBuildObeysTheConnection(t *testing.T) {
	builder := Builder{Context: context.Background()}
	if err := builder.requestBuild(buildRequest{ImageID: "dev", Tag: "t", Containerfile: "FROM scratch\n"}); err == nil {
		t.Fatal("expected an error without a Podman connection")
	}
}
