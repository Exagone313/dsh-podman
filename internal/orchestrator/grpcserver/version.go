// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"context"
	"fmt"
	"log/slog"
	"sync"

	ctl "github.com/Exagone313/dsh-podman/internal/genproto/dshctl/v1"
	"github.com/Exagone313/dsh-podman/internal/version"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

// PluginVersionHeader carries the connecting plugin's version on every control
// call. The plugin and the orchestrator are deployed separately (an npm package
// inside the dsh image, and this binary), so the orchestrator refuses a plugin
// from another major version rather than serving a request it may misread.
const PluginVersionHeader = "x-dsh-podman-plugin-version"

// GetVersionFullMethod is the handshake RPC. It is exempt from the version
// check so a plugin can always learn which orchestrator it is talking to.
const GetVersionFullMethod = "/dshctl.v1.OrchestratorControl/GetVersion"

// GetVersion answers the version handshake.
func (s *Server) GetVersion(_ context.Context, _ *ctl.GetVersionRequest) (*ctl.GetVersionResponse, error) {
	return &ctl.GetVersionResponse{Version: version.Version, Commit: version.Commit}, nil
}

// UnaryVersion rejects a control call whose plugin version is incompatible with
// this orchestrator: a missing header, a plugin version without a parseable
// core, or a different major version. A minor/patch difference is compatible
// and only logged once per observed plugin version. An orchestrator built
// without a version tag (a local build) cannot compare, so it accepts any
// plugin.
func UnaryVersion(logger *slog.Logger) grpc.UnaryServerInterceptor {
	if logger == nil {
		logger = slog.Default()
	}
	var mu sync.Mutex
	warned := map[string]struct{}{}
	return func(ctx context.Context, request any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
		if info.FullMethod == GetVersionFullMethod {
			return handler(ctx, request)
		}
		if version.Core(version.Version) == "" {
			logger.Debug("orchestrator has no comparable version; skipping the plugin version check")
			return handler(ctx, request)
		}
		plugin := pluginVersion(ctx)
		if plugin == "" {
			return nil, status.Error(codes.FailedPrecondition, "the dsh-podman plugin did not report its version; update the dsh image")
		}
		if version.Core(plugin) == "" {
			return nil, status.Error(codes.FailedPrecondition, fmt.Sprintf("the dsh-podman plugin reports an unusable version %q; update the dsh image", plugin))
		}
		if version.Major(plugin) != version.Major(version.Version) {
			return nil, status.Error(codes.FailedPrecondition, mismatchReason(plugin))
		}
		if version.Compare(plugin, version.Version) != 0 {
			mu.Lock()
			_, seen := warned[plugin]
			warned[plugin] = struct{}{}
			mu.Unlock()
			if !seen {
				logger.Warn("dsh-podman plugin and orchestrator versions differ but remain compatible",
					"plugin", plugin, "orchestrator", version.Version)
			}
		}
		return handler(ctx, request)
	}
}

// mismatchReason names both versions and which side is behind, so an operator
// knows which image to update.
func mismatchReason(plugin string) string {
	if version.Compare(plugin, version.Version) < 0 {
		return fmt.Sprintf("dsh-podman plugin %s is incompatible with orchestrator %s: the plugin is older, update the dsh image", plugin, version.Version)
	}
	return fmt.Sprintf("dsh-podman plugin %s is incompatible with orchestrator %s: the orchestrator is older, update the orchestrator image", plugin, version.Version)
}

// pluginVersion reads the plugin version from the incoming call metadata.
func pluginVersion(ctx context.Context) string {
	incoming, ok := metadata.FromIncomingContext(ctx)
	if !ok {
		return ""
	}
	values := incoming.Get(PluginVersionHeader)
	if len(values) == 0 {
		return ""
	}
	return values[0]
}
