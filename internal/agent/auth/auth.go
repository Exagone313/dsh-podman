package auth

import (
	"context"
	"strings"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

func Unary(token string) grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
		if !valid(ctx, token) {
			return nil, status.Error(codes.Unauthenticated, "invalid agent token")
		}
		return handler(ctx, req)
	}
}
func Stream(token string) grpc.StreamServerInterceptor {
	return func(srv any, stream grpc.ServerStream, info *grpc.StreamServerInfo, handler grpc.StreamHandler) error {
		if !valid(stream.Context(), token) {
			return status.Error(codes.Unauthenticated, "invalid agent token")
		}
		return handler(srv, stream)
	}
}
func valid(ctx context.Context, expected string) bool {
	values, ok := metadata.FromIncomingContext(ctx)
	return expected != "" && ok && len(values.Get("authorization")) > 0 && strings.TrimSpace(values.Get("authorization")[0]) == "bearer "+expected
}
