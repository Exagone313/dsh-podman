// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package auth

import (
	"context"
	"testing"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

func TestUnaryAcceptsValidToken(t *testing.T) {
	ctx := metadata.NewIncomingContext(context.Background(), metadata.Pairs("authorization", "bearer secret"))
	interceptor := Unary("secret")
	handler := func(ctx context.Context, req any) (any, error) { return "ok", nil }
	result, err := interceptor(ctx, nil, &grpc.UnaryServerInfo{}, handler)
	if err != nil || result != "ok" {
		t.Fatalf("interceptor rejected valid token: %v %v", result, err)
	}
}

func TestUnaryRejectsInvalidCredentials(t *testing.T) {
	interceptor := Unary("secret")
	handler := func(ctx context.Context, req any) (any, error) { return "ok", nil }
	cases := []struct {
		name    string
		ctx     context.Context
		inter   grpc.UnaryServerInterceptor
	}{
		{name: "no metadata", ctx: context.Background(), inter: interceptor},
		{name: "missing header", ctx: metadata.NewIncomingContext(context.Background(), metadata.Pairs("x-other", "1")), inter: interceptor},
		{name: "wrong token", ctx: metadata.NewIncomingContext(context.Background(), metadata.Pairs("authorization", "bearer nope")), inter: interceptor},
		{name: "malformed header", ctx: metadata.NewIncomingContext(context.Background(), metadata.Pairs("authorization", "secret")), inter: interceptor},
		{name: "empty expected", ctx: metadata.NewIncomingContext(context.Background(), metadata.Pairs("authorization", "bearer ")), inter: Unary("")},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := tc.inter(tc.ctx, nil, &grpc.UnaryServerInfo{}, handler)
			if status.Code(err) != codes.Unauthenticated {
				t.Fatalf("expected Unauthenticated, got %v", err)
			}
		})
	}
}

type fakeStream struct {
	grpc.ServerStream
	ctx context.Context
}

func (s *fakeStream) Context() context.Context { return s.ctx }

func TestStreamAcceptsValidToken(t *testing.T) {
	ctx := metadata.NewIncomingContext(context.Background(), metadata.Pairs("authorization", "bearer secret"))
	interceptor := Stream("secret")
	handler := func(srv any, stream grpc.ServerStream) error { return nil }
	if err := interceptor(nil, &fakeStream{ctx: ctx}, &grpc.StreamServerInfo{}, handler); err != nil {
		t.Fatalf("interceptor rejected valid token: %v", err)
	}
}

func TestStreamRejectsMissingToken(t *testing.T) {
	interceptor := Stream("secret")
	handler := func(srv any, stream grpc.ServerStream) error { return nil }
	err := interceptor(nil, &fakeStream{ctx: context.Background()}, &grpc.StreamServerInfo{}, handler)
	if status.Code(err) != codes.Unauthenticated {
		t.Fatalf("expected Unauthenticated, got %v", err)
	}
}
