// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package gateway

import (
	"context"
	"log/slog"
	"sync"

	"github.com/Exagone313/dsh-podman/internal/version"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

// OrchestratorVersionHeader carries the orchestrator's version on every gateway
// call, mirroring the plugin version header on the control plane. The gateway
// and the orchestrator are deployed separately (two images, two Quadlets), so
// the gateway refuses an orchestrator from another major version rather than
// serving a request whose meaning it may misread.
const OrchestratorVersionHeader = "x-dsh-podman-orchestrator-version"

// GetVersionFullMethod is exempt from the check so a caller can always learn
// the gateway's version, even when the two are incompatible.
const GetVersionFullMethod = "/dshgateway.v1.Gateway/GetVersion"

// maxWarnedVersions bounds the set of orchestrator versions the "compatible but
// different" warning remembers, so a stream of distinct versions cannot grow it
// without limit.
const maxWarnedVersions = 64

// UnaryVersion rejects a gateway call whose orchestrator version is
// incompatible: a missing header, a version without a parseable core, or a
// different major version. A minor or patch difference is compatible and only
// logged once per observed version. A gateway built without a version tag (a
// local build) cannot compare, so it accepts any orchestrator.
func UnaryVersion(logger *slog.Logger) grpc.UnaryServerInterceptor {
	check := newVersionCheck(logger)
	return func(ctx context.Context, request any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
		if err := check(ctx, info.FullMethod); err != nil {
			return nil, err
		}
		return handler(ctx, request)
	}
}

// StreamVersion is the stream counterpart: the Lease stream carries no unary
// call to check, so the header is read from the stream context.
func StreamVersion(logger *slog.Logger) grpc.StreamServerInterceptor {
	check := newVersionCheck(logger)
	return func(srv any, stream grpc.ServerStream, info *grpc.StreamServerInfo, handler grpc.StreamHandler) error {
		if err := check(stream.Context(), info.FullMethod); err != nil {
			return err
		}
		return handler(srv, stream)
	}
}

func newVersionCheck(logger *slog.Logger) func(context.Context, string) error {
	if logger == nil {
		logger = slog.Default()
	}
	var mu sync.Mutex
	warned := map[string]struct{}{}
	return func(ctx context.Context, fullMethod string) error {
		if fullMethod == GetVersionFullMethod {
			return nil
		}
		if version.Core(version.Version) == "" {
			logger.Debug("gateway has no comparable version; skipping the orchestrator version check")
			return nil
		}
		orchestrator := orchestratorVersion(ctx)
		if orchestrator == "" {
			return status.Error(codes.FailedPrecondition, "the dsh-podman orchestrator did not report its version; update dsh-podman")
		}
		if version.Core(orchestrator) == "" {
			return status.Errorf(codes.FailedPrecondition, "the dsh-podman orchestrator reports an unusable version %q; update dsh-podman", orchestrator)
		}
		if version.Major(orchestrator) != version.Major(version.Version) {
			return status.Errorf(codes.FailedPrecondition, "the dsh-podman orchestrator and gateway have incompatible major versions (orchestrator %s, gateway %s); update both together", orchestrator, version.Version)
		}
		if version.Compare(orchestrator, version.Version) != 0 {
			mu.Lock()
			_, seen := warned[orchestrator]
			if !seen {
				if len(warned) >= maxWarnedVersions {
					// Bound the memory a long stream of distinct versions
					// could pin; after a reset a version is logged once more,
					// which is harmless for a warning.
					warned = map[string]struct{}{}
				}
				warned[orchestrator] = struct{}{}
			}
			mu.Unlock()
			if !seen {
				logger.Warn("orchestrator and gateway versions differ", "orchestrator", orchestrator, "gateway", version.Version)
			}
		}
		return nil
	}
}

func orchestratorVersion(ctx context.Context) string {
	values, ok := metadata.FromIncomingContext(ctx)
	if !ok {
		return ""
	}
	header := values.Get(OrchestratorVersionHeader)
	if len(header) == 0 {
		return ""
	}
	return header[0]
}
