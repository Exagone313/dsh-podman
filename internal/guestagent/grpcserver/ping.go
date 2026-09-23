// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"context"

	guest "github.com/Exagone313/dsh-podman/internal/genproto/dshguest/v1"
	"github.com/Exagone313/dsh-podman/internal/version"
)

// Ping reports the agent's build. It is the readiness probe callers use before
// issuing work: it passes through the auth interceptor, so a successful Ping
// means the agent is reachable and accepts the caller's credential.
func (s *Server) Ping(_ context.Context, _ *guest.PingRequest) (*guest.PingResponse, error) {
	return &guest.PingResponse{Version: version.Version, Commit: version.Commit}, nil
}
