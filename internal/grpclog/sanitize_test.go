// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpclog

import (
	"context"
	"errors"
	"testing"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func TestSanitizeHidesInternalDetail(t *testing.T) {
	interceptor := Sanitize()
	handler := func(context.Context, any) (any, error) {
		return nil, status.Error(codes.Internal, "replace workspaces.toml: /var/lib/dsh/secret-path")
	}
	_, err := interceptor(context.Background(), nil, &grpc.UnaryServerInfo{FullMethod: "/test/Method"}, handler)
	if status.Code(err) != codes.Internal {
		t.Fatalf("code = %v, want Internal", status.Code(err))
	}
	if status.Convert(err).Message() != internalMessage {
		t.Fatalf("message = %q, want %q", status.Convert(err).Message(), internalMessage)
	}
}

func TestSanitizeKeepsActionableCodes(t *testing.T) {
	handler := func(context.Context, any) (any, error) {
		return nil, status.Error(codes.InvalidArgument, "invalid project name \"../x\"")
	}
	_, err := Sanitize()(context.Background(), nil, &grpc.UnaryServerInfo{FullMethod: "/test/Method"}, handler)
	if status.Convert(err).Message() != "invalid project name \"../x\"" {
		t.Fatalf("actionable message was rewritten: %v", err)
	}
}

func TestSanitizePassesThroughSuccessAndPlainErrors(t *testing.T) {
	if _, err := Sanitize()(context.Background(), nil, &grpc.UnaryServerInfo{}, func(context.Context, any) (any, error) {
		return "ok", nil
	}); err != nil {
		t.Fatalf("success returned an error: %v", err)
	}
	// A non-status error has no code; status.Code maps it to Unknown, which is
	// not Internal and must not be rewritten here.
	plain := errors.New("boom")
	_, err := Sanitize()(context.Background(), nil, &grpc.UnaryServerInfo{}, func(context.Context, any) (any, error) {
		return nil, plain
	})
	if !errors.Is(err, plain) {
		t.Fatalf("plain error was rewritten: %v", err)
	}
}
