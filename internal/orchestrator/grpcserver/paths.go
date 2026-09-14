// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"

	ctl "github.com/Exagone313/dsh-podman/internal/genproto/dshctl/v1"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// SetContainerPaths replaces the directories the guest agent prepends to every
// process's PATH. The container is not recreated: the caller applies the list
// to the running guest agent, and the persisted list is handed to the guest as
// part of the container environment on the next create or recreate.
func (s *Server) SetContainerPaths(_ context.Context, request *ctl.SetContainerPathsRequest) (*ctl.Container, error) {
	s.log().Info("control request", "method", "SetContainerPaths", "workspace_slug", request.GetWorkspaceSlug(), "container", request.GetContainer(), "path_count", len(request.GetPaths()))
	workspace, err := workspaceBySlug(s.Store, request.GetWorkspaceSlug())
	if err != nil {
		return nil, status.Error(codes.NotFound, err.Error())
	}
	record, ok := containerByLogical(&workspace, request.GetContainer())
	if !ok {
		s.log().Warn("control request failed", "method", "SetContainerPaths", "workspace_slug", request.GetWorkspaceSlug(), "container", request.GetContainer(), "reason", "container not found")
		return nil, containerNotFoundError(request.GetContainer(), request.GetWorkspaceSlug())
	}
	paths, err := validPathAdditions(request.GetPaths())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}
	record.Paths = paths
	updated, err := s.upsertContainer(workspace, *record)
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	s.log().Info("control request completed", "method", "SetContainerPaths", "workspace_slug", request.GetWorkspaceSlug(), "container", request.GetContainer(), "path_count", len(paths))
	return containerProto(updated, *record), nil
}

// validPathAdditions validates and deduplicates a PATH-addition list. Every
// entry must be an absolute, lexically clean directory that carries no PATH
// separator or control character; the first occurrence wins, so the caller's
// priority order is kept.
func validPathAdditions(paths []string) ([]string, error) {
	seen := make(map[string]struct{}, len(paths))
	result := make([]string, 0, len(paths))
	for _, path := range paths {
		if path == "" {
			continue
		}
		if strings.ContainsAny(path, ":\x00\n") {
			return nil, fmt.Errorf("invalid path %q: it must not contain ':', NUL, or a newline", path)
		}
		if !filepath.IsAbs(path) {
			return nil, fmt.Errorf("invalid path %q: it must be absolute", path)
		}
		if cleaned := filepath.Clean(path); cleaned != path {
			return nil, fmt.Errorf("invalid path %q: it must be lexically clean (got %q)", path, cleaned)
		}
		if _, ok := seen[path]; ok {
			continue
		}
		seen[path] = struct{}{}
		result = append(result, path)
	}
	return result, nil
}
