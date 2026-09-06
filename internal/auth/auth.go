// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"math/big"
	"strings"
	"time"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

// Jitter bounds applied before reporting a rejected token. The comparison
// itself is already constant time, so this only covers the work around it
// (metadata lookup, header shape) and keeps the failure latency well above
// any signal a caller could measure.
const (
	minRejectDelay = 5 * time.Millisecond
	maxRejectDelay = 50 * time.Millisecond
)

func Unary(token string) grpc.UnaryServerInterceptor {
	return func(ctx context.Context, req any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
		if !valid(ctx, token) {
			return nil, reject(ctx)
		}
		return handler(ctx, req)
	}
}
func Stream(token string) grpc.StreamServerInterceptor {
	return func(srv any, stream grpc.ServerStream, info *grpc.StreamServerInfo, handler grpc.StreamHandler) error {
		if !valid(stream.Context(), token) {
			return reject(stream.Context())
		}
		return handler(srv, stream)
	}
}

// valid reports whether the request carries the expected bearer token. An
// empty expected token never matches, so a component started without one
// rejects every call rather than serving unauthenticated requests.
func valid(ctx context.Context, expected string) bool {
	if expected == "" {
		return false
	}
	values, ok := metadata.FromIncomingContext(ctx)
	if !ok {
		return false
	}
	header := values.Get("authorization")
	if len(header) == 0 {
		return false
	}
	return tokensEqual(strings.TrimSpace(header[0]), "bearer "+expected)
}

// tokensEqual compares two credentials without leaking their contents through
// timing. Both sides are hashed first: subtle.ConstantTimeCompare returns
// early when the lengths differ, so comparing the raw strings would still
// reveal the token's length.
func tokensEqual(got, want string) bool {
	gotSum := sha256.Sum256([]byte(got))
	wantSum := sha256.Sum256([]byte(want))
	return subtle.ConstantTimeCompare(gotSum[:], wantSum[:]) == 1
}

// reject waits for a random interval before reporting the failure, so that
// the response time carries no usable signal about how far the credential got
// through validation. The wait is abandoned as soon as the caller goes away,
// so a flood of bad credentials cannot pin goroutines past disconnection.
func reject(ctx context.Context) error {
	select {
	case <-time.After(rejectDelay()):
	case <-ctx.Done():
	}
	return status.Error(codes.Unauthenticated, "invalid agent token")
}

func rejectDelay() time.Duration {
	span := int64(maxRejectDelay - minRejectDelay)
	offset, err := rand.Int(rand.Reader, big.NewInt(span))
	if err != nil {
		return maxRejectDelay
	}
	return minRejectDelay + time.Duration(offset.Int64())
}
