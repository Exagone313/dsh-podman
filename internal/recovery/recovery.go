// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// Package recovery turns a panic in a gRPC handler into a failed call.
//
// grpc-go does not recover from handler panics, so one would take the whole
// process down: in a guest agent that kills every running exec and daemon in
// the container, and in the orchestrator it drops the control plane.
package recovery

import (
	"context"
	"log/slog"
	"runtime/debug"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// Unary recovers from a panic in a unary handler.
func Unary(logger *slog.Logger) grpc.UnaryServerInterceptor {
	return func(ctx context.Context, request any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (response any, err error) {
		defer func() {
			if recovered := recover(); recovered != nil {
				response = nil
				err = recoveredError(logger, info.FullMethod, recovered)
			}
		}()
		return handler(ctx, request)
	}
}

// Stream recovers from a panic in a streaming handler.
func Stream(logger *slog.Logger) grpc.StreamServerInterceptor {
	return func(srv any, stream grpc.ServerStream, info *grpc.StreamServerInfo, handler grpc.StreamHandler) (err error) {
		defer func() {
			if recovered := recover(); recovered != nil {
				err = recoveredError(logger, info.FullMethod, recovered)
			}
		}()
		return handler(srv, stream)
	}
}

func recoveredError(logger *slog.Logger, method string, recovered any) error {
	if logger == nil {
		logger = slog.Default()
	}
	logger.Error("gRPC handler panicked", "method", method, "panic", recovered, "stack", string(debug.Stack()))
	return status.Error(codes.Internal, "internal error")
}
