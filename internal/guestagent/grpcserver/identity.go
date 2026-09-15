// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"fmt"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/wrapperspb"
)

// optionalID converts a request's optional uid/gid wrapper into the numeric
// pointer the guest managers take. A nil wrapper means "no override"; a
// negative value is rejected, since the wrapper only exists because proto3
// cannot distinguish an absent uint32 from 0.
func optionalID(value *wrapperspb.Int32Value, name string) (*uint32, error) {
	if value == nil {
		return nil, nil
	}
	if value.GetValue() < 0 {
		return nil, status.Error(codes.InvalidArgument, fmt.Sprintf("%s must not be negative", name))
	}
	converted := uint32(value.GetValue())
	return &converted, nil
}
