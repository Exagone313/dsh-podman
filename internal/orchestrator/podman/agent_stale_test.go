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
	"testing"

	"go.podman.io/podman/v6/pkg/bindings"
)

// TestContainerAgentStale pins the staleness probe: the container's
// guest-agent image volume is compared with the configured image, and a
// container without one counts as stale unless no image (or a host binary) is
// configured.
func TestContainerAgentStale(t *testing.T) {
	cases := []struct {
		name       string
		image      string
		hostBinary string
		mounts     string
		want       bool
	}{
		{"current image", "img:1", "", `[{"Type":"image","Source":"img:1","Destination":"/opt/agent"}]`, false},
		{"outdated image", "img:2", "", `[{"Type":"image","Source":"img:1","Destination":"/opt/agent"}]`, true},
		{"no image volume", "img:1", "", `[{"Type":"bind","Source":"/bin/agent","Destination":"/opt/agent/bin/agent"}]`, true},
		{"no image configured", "", "", `[]`, false},
		{"host binary takes precedence", "img:1", "/bin/agent", `[]`, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				fmt.Fprintf(w, `{"Mounts":%s}`, tc.mounts)
			}))
			t.Cleanup(server.Close)
			ctx, err := bindings.NewConnection(context.Background(), "tcp://"+server.Listener.Addr().String())
			if err != nil {
				t.Fatal(err)
			}
			client := &Client{
				ctx:             ctx,
				logger:          slog.New(slog.NewTextHandler(io.Discard, nil)),
				guestAgentImage: tc.image,
				guestAgentMount: "/opt/agent",
				hostGuestBinary: tc.hostBinary,
			}
			stale, err := client.ContainerAgentStale("dsh-podman-proj-default")
			if err != nil {
				t.Fatal(err)
			}
			if stale != tc.want {
				t.Fatalf("stale = %v, want %v", stale, tc.want)
			}
		})
	}
}
