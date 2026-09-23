// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"context"
	"testing"

	guest "github.com/Exagone313/dsh-podman/internal/genproto/dshguest/v1"
	"github.com/Exagone313/dsh-podman/internal/version"
)

// TestPingReportsTheBuild pins that the readiness probe answers with the
// agent's version and commit.
func TestPingReportsTheBuild(t *testing.T) {
	response, err := New().Ping(context.Background(), &guest.PingRequest{})
	if err != nil {
		t.Fatal(err)
	}
	if response.GetVersion() != version.Version || response.GetCommit() != version.Commit {
		t.Fatalf("unexpected ping response: %#v", response)
	}
}
