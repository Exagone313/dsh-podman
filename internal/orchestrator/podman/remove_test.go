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

// TestRemoveToleratesAnAbsentContainer pins that a removal asks the service to
// ignore an absent container, so a container deleted outside dsh-podman does
// not block a replace or a recreate.
func TestRemoveToleratesAnAbsentContainer(t *testing.T) {
	var request http.Request
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		request = *r
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, "[]")
	}))
	t.Cleanup(server.Close)
	ctx, err := bindings.NewConnection(context.Background(), "tcp://"+server.Listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	client := &Client{ctx: ctx, logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
	if err := client.Remove("dsh-podman-proj-default"); err != nil {
		t.Fatal(err)
	}
	if request.Method != http.MethodDelete {
		t.Errorf("method = %q, want DELETE", request.Method)
	}
	if !strings.HasSuffix(request.URL.Path, "/containers/dsh-podman-proj-default") {
		t.Errorf("path = %q, want a /containers/<name> suffix", request.URL.Path)
	}
	if got := request.URL.Query().Get("ignore"); got != "true" {
		t.Errorf("ignore = %q, want true", got)
	}
	if got := request.URL.Query().Get("force"); got != "true" {
		t.Errorf("force = %q, want true", got)
	}
}
