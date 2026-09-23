// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// Package grpclog logs the gRPC calls a server handles: the method and the
// outcome. It is deliberately generic so the orchestrator and the guest agent
// report calls the same way.
package grpclog

import (
	"context"
	"fmt"
	"log/slog"

	"google.golang.org/grpc"
)

// Unary logs one unary call and its outcome.
func Unary(logger *slog.Logger) grpc.UnaryServerInterceptor {
	if logger == nil {
		logger = slog.Default()
	}
	return func(ctx context.Context, request any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
		logger.Info("gRPC request", "method", info.FullMethod, "request_type", fmt.Sprintf("%T", request))
		response, err := handler(ctx, request)
		if err != nil {
			logger.Error("gRPC request failed", "method", info.FullMethod, "error", err)
			return response, err
		}
		logger.Info("gRPC request completed", "method", info.FullMethod)
		return response, nil
	}
}

// Stream logs one streaming call and its outcome.
func Stream(logger *slog.Logger) grpc.StreamServerInterceptor {
	if logger == nil {
		logger = slog.Default()
	}
	return func(server any, stream grpc.ServerStream, info *grpc.StreamServerInfo, handler grpc.StreamHandler) error {
		logger.Info("gRPC stream", "method", info.FullMethod)
		err := handler(server, stream)
		if err != nil {
			logger.Error("gRPC stream failed", "method", info.FullMethod, "error", err)
			return err
		}
		logger.Info("gRPC stream completed", "method", info.FullMethod)
		return nil
	}
}
