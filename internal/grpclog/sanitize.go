// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpclog

import (
	"context"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// internalMessage is what an unexpected Internal failure is reported as. The
// detail is logged by the Unary/Stream interceptor, which runs inside this one.
const internalMessage = "internal error"

// Sanitize rewrites an unexpected (codes.Internal) failure into a stable
// message before it reaches the client. Internal errors carry host paths,
// podman/OCI text, and state-file detail; those stay in the server log.
// Actionable codes — InvalidArgument, NotFound, FailedPrecondition,
// PermissionDenied — pass through verbatim so the model can correct itself.
//
// It is a no-op when err is nil or already sanitized, so it can wrap the logger
// without hiding anything the logger needs to record.
func Sanitize() grpc.UnaryServerInterceptor {
	return func(ctx context.Context, request any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
		response, err := handler(ctx, request)
		return response, sanitizeError(err)
	}
}

// SanitizeStream is the streaming counterpart of Sanitize.
func SanitizeStream() grpc.StreamServerInterceptor {
	return func(server any, stream grpc.ServerStream, info *grpc.StreamServerInfo, handler grpc.StreamHandler) error {
		return sanitizeError(handler(server, stream))
	}
}

func sanitizeError(err error) error {
	if err == nil {
		return nil
	}
	if status.Code(err) == codes.Internal {
		return status.Error(codes.Internal, internalMessage)
	}
	return err
}
