// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"context"
	"io"
	"log/slog"
	"testing"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func quietLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

type panicStream struct{ grpc.ServerStream }

func TestRecoveryUnaryTurnsPanicsIntoErrors(t *testing.T) {
	interceptor := RecoveryUnary(quietLogger())
	handler := func(ctx context.Context, req any) (any, error) { panic("boom") }
	response, err := interceptor(context.Background(), nil, &grpc.UnaryServerInfo{FullMethod: "/test/Method"}, handler)
	if status.Code(err) != codes.Internal {
		t.Fatalf("expected Internal, got %v", err)
	}
	if response != nil {
		t.Fatalf("expected no response, got %#v", response)
	}
}

func TestRecoveryUnaryPassesThrough(t *testing.T) {
	interceptor := RecoveryUnary(quietLogger())
	handler := func(ctx context.Context, req any) (any, error) { return "ok", nil }
	response, err := interceptor(context.Background(), nil, &grpc.UnaryServerInfo{FullMethod: "/test/Method"}, handler)
	if err != nil || response != "ok" {
		t.Fatalf("unexpected result: %v %v", response, err)
	}
}

func TestRecoveryStreamTurnsPanicsIntoErrors(t *testing.T) {
	interceptor := RecoveryStream(quietLogger())
	handler := func(srv any, stream grpc.ServerStream) error { panic("boom") }
	err := interceptor(nil, &panicStream{}, &grpc.StreamServerInfo{FullMethod: "/test/Stream"}, handler)
	if status.Code(err) != codes.Internal {
		t.Fatalf("expected Internal, got %v", err)
	}
}

func TestRecoveryStreamPassesThrough(t *testing.T) {
	interceptor := RecoveryStream(quietLogger())
	handler := func(srv any, stream grpc.ServerStream) error { return nil }
	if err := interceptor(nil, &panicStream{}, &grpc.StreamServerInfo{FullMethod: "/test/Stream"}, handler); err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
}
