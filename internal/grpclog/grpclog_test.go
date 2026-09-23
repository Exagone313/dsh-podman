// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpclog

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"

	"google.golang.org/grpc"
)

func discardLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func TestUnaryPassesThrough(t *testing.T) {
	interceptor := Unary(discardLogger())
	called := false
	handler := func(ctx context.Context, req any) (any, error) { called = true; return "value", nil }
	result, err := interceptor(context.Background(), nil, &grpc.UnaryServerInfo{FullMethod: "/test/Method"}, handler)
	if err != nil || result != "value" || !called {
		t.Fatalf("interceptor did not pass through: %v %v %v", result, err, called)
	}
}

func TestUnaryPropagatesTheError(t *testing.T) {
	interceptor := Unary(discardLogger())
	handler := func(ctx context.Context, req any) (any, error) { return nil, errors.New("boom") }
	if _, err := interceptor(context.Background(), nil, &grpc.UnaryServerInfo{FullMethod: "/test/Method"}, handler); err == nil || err.Error() != "boom" {
		t.Fatalf("unexpected error: %v", err)
	}
}

// streamStub is the minimal grpc.ServerStream a stream interceptor needs; the
// test handlers never touch it.
type streamStub struct{ grpc.ServerStream }

func TestStreamPassesThrough(t *testing.T) {
	interceptor := Stream(discardLogger())
	called := false
	handler := func(server any, stream grpc.ServerStream) error { called = true; return nil }
	if err := interceptor(nil, streamStub{}, &grpc.StreamServerInfo{FullMethod: "/test/Method"}, handler); err != nil || !called {
		t.Fatalf("stream interceptor did not pass through: %v %v", err, called)
	}
}
