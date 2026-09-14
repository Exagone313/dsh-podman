// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"context"
	"fmt"

	ctl "github.com/Exagone313/dsh-podman/internal/genproto/dshctl/v1"
	imagebuild "github.com/Exagone313/dsh-podman/internal/orchestrator/images"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// ListCaches reports the size of every configured package-manager build cache.
func (s *Server) ListCaches(context.Context, *ctl.ListCachesRequest) (*ctl.ListCachesResponse, error) {
	s.log().Info("control request", "method", "ListCaches")
	if s.ImageBuilder == nil {
		return nil, status.Error(codes.FailedPrecondition, "image builder is not configured")
	}
	stats, err := s.ImageBuilder.CacheStats()
	if err != nil {
		s.log().Error("control request failed", "method", "ListCaches", "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	result := &ctl.ListCachesResponse{Caches: cacheProtos(stats)}
	s.log().Info("control request completed", "method", "ListCaches", "count", len(result.Caches))
	return result, nil
}

// CleanCaches removes cached package files according to the requested mode.
func (s *Server) CleanCaches(_ context.Context, request *ctl.CleanCachesRequest) (*ctl.CleanCachesResponse, error) {
	mode, err := cacheCleanMode(request.GetMode())
	if err != nil {
		return nil, err
	}
	s.log().Info("control request", "method", "CleanCaches", "mode", string(mode))
	if s.ImageBuilder == nil {
		return nil, status.Error(codes.FailedPrecondition, "image builder is not configured")
	}
	result, err := s.ImageBuilder.CleanCaches(mode)
	if err != nil {
		s.log().Error("control request failed", "method", "CleanCaches", "mode", string(mode), "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	s.log().Info("control request completed", "method", "CleanCaches", "mode", string(mode), "removed_files", result.Files, "removed_bytes", result.Bytes)
	return &ctl.CleanCachesResponse{
		Mode:         request.GetMode(),
		RemovedFiles: int32(result.Files),
		RemovedBytes: result.Bytes,
		Caches:       cacheProtos(result.Caches),
	}, nil
}

// cacheCleanMode maps the control plane's clean mode onto the builder's.
func cacheCleanMode(mode ctl.CacheCleanMode) (imagebuild.CacheCleanMode, error) {
	switch mode {
	case ctl.CacheCleanMode_CACHE_CLEAN_MODE_KEEP_LATEST:
		return imagebuild.CacheKeepLatest, nil
	case ctl.CacheCleanMode_CACHE_CLEAN_MODE_ALL:
		return imagebuild.CacheRemoveAll, nil
	default:
		return "", status.Error(codes.InvalidArgument, fmt.Sprintf("invalid cache clean mode %q", mode.String()))
	}
}

// cacheProtos projects builder cache stats onto the control plane's message.
func cacheProtos(stats []imagebuild.CacheStat) []*ctl.Cache {
	result := make([]*ctl.Cache, 0, len(stats))
	for _, stat := range stats {
		result = append(result, &ctl.Cache{
			Manager: stat.Manager,
			Path:    stat.Path,
			Files:   int32(stat.Files),
			Bytes:   stat.Bytes,
		})
	}
	return result
}
