// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"context"
	"fmt"

	guest "github.com/Exagone313/dsh-podman/internal/genproto/dshguest/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// ptcContainerName is the reserved logical name of the shared PTC container,
// matching the orchestrator's own reserved name. It only appears in the
// restricted-mode error, which names the container a refused call was denied in.
const ptcContainerName = "ptc"

// ptcAllowedMethods is the complete set of guest RPCs the reserved PTC
// container may call. A PTC child only needs to start an exec (Exec, whose
// first frame is the ExecStart message), attach its control channel, probe the
// capability that announces ExecControl, and answer the plugin's readiness
// Ping. Every other RPC is refused, so a PTC program cannot start daemons,
// browse or edit the filesystem, manage mounts, publish ports, open terminals,
// or read secrets.
var ptcAllowedMethods = map[string]struct{}{
	guest.WorkspaceGuestAgent_Exec_FullMethodName:            {},
	guest.WorkspaceGuestAgent_ExecControl_FullMethodName:     {},
	guest.WorkspaceGuestAgent_GetCapabilities_FullMethodName: {},
	guest.WorkspaceGuestAgent_Ping_FullMethodName:            {},
}

// PTCUnary returns the unary interceptor enforcing restricted mode. It is
// installed only on the reserved PTC container's agent.
func PTCUnary() grpc.UnaryServerInterceptor { return ptcUnary(true) }

// PTCStream returns the stream interceptor enforcing restricted mode. It is
// mandatory in addition to PTCUnary: Exec, ExecControl and the other streaming
// RPCs never pass through a unary interceptor.
func PTCStream() grpc.StreamServerInterceptor { return ptcStream(true) }

// ptcUnary builds the unary guard. enabled lets tests prove that the guard is
// inert when it is not installed (that is, outside PTC mode).
func ptcUnary(enabled bool) grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
		if enabled && !ptcAllowed(info.FullMethod) {
			return nil, ptcDenied(info.FullMethod)
		}
		return handler(ctx, req)
	}
}

// ptcStream builds the stream guard.
func ptcStream(enabled bool) grpc.StreamServerInterceptor {
	return func(srv any, stream grpc.ServerStream, info *grpc.StreamServerInfo, handler grpc.StreamHandler) error {
		if enabled && !ptcAllowed(info.FullMethod) {
			return ptcDenied(info.FullMethod)
		}
		return handler(srv, stream)
	}
}

// ptcAllowed reports whether a full method name is in the PTC allow-list.
func ptcAllowed(fullMethod string) bool {
	_, ok := ptcAllowedMethods[fullMethod]
	return ok
}

// ptcDenied names both the refused method and the container it was refused in,
// so a caller can tell a PTC restriction from an authentication failure.
func ptcDenied(fullMethod string) error {
	return status.Error(codes.PermissionDenied, fmt.Sprintf(
		"guest method %q is not available in the reserved PTC container %q",
		fullMethod, ptcContainerName,
	))
}
