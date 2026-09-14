// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"context"
	"errors"
	"os"

	guest "github.com/Exagone313/dsh-podman/internal/genproto/dshguest/v1"
)

// SetPaths replaces the additions prepended to every process the agent starts.
// It returns the stored additions (deduplicated, first occurrence wins) and the
// agent's own PATH, which they are prepended to.
func (s *Server) SetPaths(_ context.Context, request *guest.SetPathsRequest) (*guest.PathsResponse, error) {
	if s.Paths == nil {
		return nil, errors.New("path additions are not configured")
	}
	return &guest.PathsResponse{Paths: s.Paths.Set(request.GetPaths()), DefaultPath: os.Getenv("PATH")}, nil
}

// GetPaths reports the current additions and the agent's own PATH.
func (s *Server) GetPaths(_ context.Context, _ *guest.GetPathsRequest) (*guest.PathsResponse, error) {
	return &guest.PathsResponse{Paths: s.Paths.List(), DefaultPath: os.Getenv("PATH")}, nil
}
