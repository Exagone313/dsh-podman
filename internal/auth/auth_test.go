// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package auth

import (
	"context"
	"testing"
	"time"

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
		name  string
		ctx   context.Context
		inter grpc.UnaryServerInterceptor
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

// TestTokensEqual covers the constant-time comparison, including the length
// mismatch that a bare subtle.ConstantTimeCompare would short-circuit on.
func TestTokensEqual(t *testing.T) {
	if !tokensEqual("bearer secret", "bearer secret") {
		t.Fatal("equal tokens compared unequal")
	}
	for _, got := range []string{"", "bearer", "bearer secre", "bearer secrets", "bearer Secret", "bearer nope"} {
		if tokensEqual(got, "bearer secret") {
			t.Errorf("token %q compared equal", got)
		}
	}
}

// TestRejectDelayWithinBounds checks the jitter stays inside its range, so a
// failure can neither answer instantly nor stall a caller.
func TestRejectDelayWithinBounds(t *testing.T) {
	for range 64 {
		delay := rejectDelay()
		if delay < minRejectDelay || delay >= maxRejectDelay {
			t.Fatalf("delay %v outside [%v, %v)", delay, minRejectDelay, maxRejectDelay)
		}
	}
}

// TestRejectWaitsBeforeReporting checks a rejection is actually delayed, so
// the response time reveals nothing about how far validation got.
func TestRejectWaitsBeforeReporting(t *testing.T) {
	interceptor := Unary("secret")
	handler := func(ctx context.Context, req any) (any, error) { return "ok", nil }
	ctx := metadata.NewIncomingContext(context.Background(), metadata.Pairs("authorization", "bearer nope"))
	start := time.Now()
	if _, err := interceptor(ctx, nil, &grpc.UnaryServerInfo{}, handler); status.Code(err) != codes.Unauthenticated {
		t.Fatalf("expected Unauthenticated, got %v", err)
	}
	if elapsed := time.Since(start); elapsed < minRejectDelay {
		t.Fatalf("rejection returned after %v, expected at least %v", elapsed, minRejectDelay)
	}
}

// TestRejectStopsWhenCallerLeaves checks the jitter is abandoned once the
// caller is gone, so bad credentials cannot pin goroutines.
func TestRejectStopsWhenCallerLeaves(t *testing.T) {
	interceptor := Unary("secret")
	handler := func(ctx context.Context, req any) (any, error) { return "ok", nil }
	ctx, cancel := context.WithCancel(metadata.NewIncomingContext(context.Background(), metadata.Pairs("authorization", "bearer nope")))
	cancel()
	start := time.Now()
	if _, err := interceptor(ctx, nil, &grpc.UnaryServerInfo{}, handler); status.Code(err) != codes.Unauthenticated {
		t.Fatalf("expected Unauthenticated, got %v", err)
	}
	if elapsed := time.Since(start); elapsed >= minRejectDelay {
		t.Fatalf("cancelled call still waited %v", elapsed)
	}
}
