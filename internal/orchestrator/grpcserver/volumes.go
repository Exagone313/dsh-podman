// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"context"
	"fmt"
	"strings"

	ctl "github.com/Exagone313/dsh-podman/internal/genproto/dshctl/v1"
	"github.com/Exagone313/dsh-podman/internal/orchestrator/state"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// volumeInUse reports the first container whose effective mounts include the
// named volume.
func volumeInUse(workspaces []state.Workspace, name string) (slug, container string, ok bool) {
	for _, ws := range workspaces {
		for _, c := range ws.Containers {
			for _, mount := range containerMounts(ws, c) {
				if mount.Kind == "volume" && mount.Volume == name {
					return ws.WorkspaceSlug, c.Name, true
				}
			}
		}
	}
	return "", "", false
}

// ListVolumes lists the orchestrator-managed named volumes, exposing only
// their unprefixed short names.
func (s *Server) ListVolumes(_ context.Context, _ *ctl.ListVolumesRequest) (*ctl.ListVolumesResponse, error) {
	s.log().Info("control request", "method", "ListVolumes")
	if s.Podman == nil {
		return nil, status.Error(codes.FailedPrecondition, "podman is not configured")
	}
	names, err := s.Podman.VolumeList()
	if err != nil {
		s.log().Error("control request failed", "method", "ListVolumes", "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	result := &ctl.ListVolumesResponse{}
	for _, name := range names {
		if !strings.HasPrefix(name, s.VolumePrefix) {
			continue
		}
		result.Volumes = append(result.Volumes, &ctl.Volume{Name: name[len(s.VolumePrefix):]})
	}
	s.log().Info("control request completed", "method", "ListVolumes", "count", len(result.Volumes))
	return result, nil
}

// CreateVolume creates a named volume under the orchestrator's prefix.
func (s *Server) CreateVolume(_ context.Context, request *ctl.CreateVolumeRequest) (*ctl.Volume, error) {
	s.log().Info("control request", "method", "CreateVolume", "name", request.GetName())
	if !volumeName.MatchString(request.GetName()) {
		return nil, status.Error(codes.InvalidArgument, fmt.Sprintf("invalid volume name %q", request.GetName()))
	}
	if s.Podman == nil {
		return nil, status.Error(codes.FailedPrecondition, "podman is not configured")
	}
	full := s.VolumePrefix + request.GetName()
	exists, err := s.Podman.VolumeExists(full)
	if err != nil {
		s.log().Error("control request failed", "method", "CreateVolume", "name", request.GetName(), "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	if exists {
		return nil, status.Error(codes.AlreadyExists, fmt.Sprintf("volume %q already exists", request.GetName()))
	}
	if err := s.Podman.VolumeCreate(full); err != nil {
		s.log().Error("control request failed", "method", "CreateVolume", "name", request.GetName(), "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	s.log().Info("control request completed", "method", "CreateVolume", "name", request.GetName())
	return &ctl.Volume{Name: request.GetName()}, nil
}

// RemoveVolume deletes a named volume under the orchestrator's prefix.
func (s *Server) RemoveVolume(_ context.Context, request *ctl.RemoveVolumeRequest) (*ctl.RemoveVolumeResponse, error) {
	s.log().Info("control request", "method", "RemoveVolume", "name", request.GetName())
	if !volumeName.MatchString(request.GetName()) {
		return nil, status.Error(codes.InvalidArgument, fmt.Sprintf("invalid volume name %q", request.GetName()))
	}
	workspaces, err := s.Store.Workspaces()
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	// Reconcile first so a container deleted outside dsh-podman does not keep
	// the volume "in use" (and its dead record is dropped).
	if s.Podman != nil {
		workspaces, err = s.reconcileContainers(workspaces, s.Podman.ContainerExists, s.Podman.ContainerRunning)
		if err != nil {
			s.log().Error("control request failed", "method", "RemoveVolume", "name", request.GetName(), "error", err)
			return nil, status.Error(codes.Internal, err.Error())
		}
	}
	if slug, container, inUse := volumeInUse(workspaces, request.GetName()); inUse {
		return nil, status.Error(codes.FailedPrecondition, fmt.Sprintf("volume %q is mounted in workspace %q container %q", request.GetName(), slug, container))
	}
	if s.Podman == nil {
		return nil, status.Error(codes.FailedPrecondition, "podman is not configured")
	}
	full := s.VolumePrefix + request.GetName()
	exists, err := s.Podman.VolumeExists(full)
	if err != nil {
		s.log().Error("control request failed", "method", "RemoveVolume", "name", request.GetName(), "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	if !exists {
		return nil, status.Error(codes.NotFound, fmt.Sprintf("volume %q not found", request.GetName()))
	}
	if err := s.Podman.VolumeRemove(full); err != nil {
		s.log().Error("control request failed", "method", "RemoveVolume", "name", request.GetName(), "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	s.log().Info("control request completed", "method", "RemoveVolume", "name", request.GetName())
	return &ctl.RemoveVolumeResponse{}, nil
}
