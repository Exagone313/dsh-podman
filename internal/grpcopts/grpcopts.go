// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// Package grpcopts holds gRPC server options shared by the orchestrator and the
// guest agent that are not service-specific.
package grpcopts

import (
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/keepalive"
)

// PluginPingInterval is the keepalive interval the dsh-podman plugin opens its
// channels with (`grpc.keepalive_time_ms` in src/grpc/runtime-client.ts). The
// plugin pings with and without active calls, so a half-open channel fails fast
// instead of leaving a call pending forever.
const PluginPingInterval = 30 * time.Second

// minPingInterval is the shortest spacing the servers accept. grpc-go's default
// policy (5 minutes, no pings without streams) answers the plugin's pings with
// GOAWAY "too many pings", which grpc-js logs as "rejected by server because of
// excess pings" before backing off to a 60s interval. Keeping this well below
// PluginPingInterval leaves room for timer jitter while still refusing a
// flooding client.
const minPingInterval = 10 * time.Second

// KeepalivePolicy returns the server option that permits the plugin's keepalive
// pings, with or without active calls.
func KeepalivePolicy() grpc.ServerOption {
	return grpc.KeepaliveEnforcementPolicy(keepalive.EnforcementPolicy{
		MinTime:             minPingInterval,
		PermitWithoutStream: true,
	})
}
