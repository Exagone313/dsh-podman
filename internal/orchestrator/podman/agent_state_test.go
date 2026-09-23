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

// TestContainerAgentState pins the staleness and credential probe: the
// container's guest-agent image volume is compared with the configured image,
// and its DSH_PODMAN_GUEST_TOKEN is read back in the same inspect.
func TestContainerAgentState(t *testing.T) {
	cases := []struct {
		name       string
		image      string
		hostBinary string
		token      string
		mounts     string
		wantStale  bool
		wantToken  string
	}{
		{"current image", "img:1", "", "tok-1", `[{"Type":"image","Source":"img:1","Destination":"/opt/agent"}]`, false, "tok-1"},
		{"outdated image", "img:2", "", "tok-1", `[{"Type":"image","Source":"img:1","Destination":"/opt/agent"}]`, true, "tok-1"},
		{"no image volume", "img:1", "", "", `[{"Type":"bind","Source":"/bin/agent","Destination":"/opt/agent/bin/agent"}]`, true, ""},
		{"no image configured", "", "", "tok-1", `[]`, false, "tok-1"},
		{"host binary takes precedence", "img:1", "/bin/agent", "", `[]`, false, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			body := fmt.Sprintf(
				`{"Config":{"Env":["PATH=/bin","DSH_PODMAN_GUEST_TOKEN=%s"]},"Mounts":%s}`,
				tc.token, tc.mounts,
			)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				fmt.Fprint(w, body)
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
			stale, token, err := client.ContainerAgentState("dsh-podman-proj-default")
			if err != nil {
				t.Fatal(err)
			}
			if stale != tc.wantStale || token != tc.wantToken {
				t.Fatalf("stale = %v, token = %q; want %v, %q", stale, token, tc.wantStale, tc.wantToken)
			}
		})
	}
}
