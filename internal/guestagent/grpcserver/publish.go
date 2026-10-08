// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"context"
	"errors"

	guest "github.com/Exagone313/dsh-podman/internal/genproto/dshguest/v1"
	"github.com/Exagone313/dsh-podman/internal/guestagent/publish"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// PublishPort forwards a port of the pod's network namespace over a Unix socket
// in this container's socket directory. The socket name is deterministic, so
// re-publishing the same port after a container recreate lands on the same path
// and the gateway's binding keeps working.
func (s *Server) PublishPort(_ context.Context, request *guest.PublishPortRequest) (*guest.PublishPortResponse, error) {
	if s.Publish == nil {
		return nil, status.Error(codes.FailedPrecondition, "port publishing is not configured")
	}
	name, err := s.Publish.Publish(request.GetProtocol(), request.GetPort())
	if err != nil {
		return nil, publishError(err)
	}
	return &guest.PublishPortResponse{SocketName: name}, nil
}

func (s *Server) UnpublishPort(_ context.Context, request *guest.UnpublishPortRequest) (*guest.UnpublishPortResponse, error) {
	if s.Publish == nil {
		return nil, status.Error(codes.FailedPrecondition, "port publishing is not configured")
	}
	s.Publish.Unpublish(request.GetProtocol(), request.GetPort())
	return &guest.UnpublishPortResponse{}, nil
}

// publishError maps a caller error to InvalidArgument and a local failure to
// Internal.
func publishError(err error) error {
	var invalid publish.InvalidError
	if errors.As(err, &invalid) {
		return status.Error(codes.InvalidArgument, err.Error())
	}
	return status.Error(codes.Internal, err.Error())
}
