// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"context"
	"fmt"

	ctl "github.com/Exagone313/dsh-podman/internal/genproto/dshctl/v1"
	"github.com/Exagone313/dsh-podman/internal/orchestrator/state"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// AddContainerMount adds a project, tmpfs, or named-volume mount to a
// container's mount list and recreates the podman container so the change
// takes effect.
func (s *Server) AddContainerMount(ctx context.Context, request *ctl.AddContainerMountRequest) (*ctl.Container, error) {
	s.log().Info("control request", "method", "AddContainerMount", "workspace_slug", request.GetWorkspaceSlug(), "container", request.GetContainer(), "project", request.GetProject(), "path", request.GetPath(), "kind", request.GetKind(), "volume", request.GetVolume())
	workspace, err := workspaceBySlug(s.Store, request.GetWorkspaceSlug())
	if err != nil {
		return nil, status.Error(codes.NotFound, err.Error())
	}
	record, ok := containerByLogical(&workspace, request.GetContainer())
	if !ok {
		s.log().Warn("control request failed", "method", "AddContainerMount", "workspace_slug", request.GetWorkspaceSlug(), "container", request.GetContainer(), "reason", "container not found")
		return nil, containerNotFoundError(request.GetContainer(), request.GetWorkspaceSlug())
	}
	snapshot := snapshotContainer(*record)
	kind, err := mountKindFromProto(request.GetKind())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}
	// Secret mounts carry no mode; every other kind requires one.
	mode := ""
	if kind != "secret" {
		if mode, err = mountModeFromProto(request.GetMode()); err != nil {
			return nil, status.Error(codes.InvalidArgument, err.Error())
		}
	}
	var newMount state.Mount
	switch kind {
	case "":
		newMount = state.Mount{ProjectName: request.GetProject(), Path: request.GetPath(), Destination: request.GetDestination(), Mode: mode}
		if _, _, err := resolveMount(s.ProjectsRoot, s.HostProjectsRoot, newMount); err != nil {
			s.log().Error("AddContainerMount project validation failed", "workspace_slug", workspace.WorkspaceSlug, "error", err)
			return nil, status.Error(codes.InvalidArgument, err.Error())
		}
	case "tmpfs":
		if mode != "read_write" {
			return nil, status.Error(codes.InvalidArgument, "tmpfs mounts must be read-write")
		}
		newMount = state.Mount{Kind: "tmpfs", Destination: request.GetDestination(), Mode: mode}
	case "volume":
		newMount = state.Mount{Kind: "volume", Volume: request.GetVolume(), Destination: request.GetDestination(), Mode: mode}
	case "secret":
		if !secretName.MatchString(request.GetSecret()) {
			return nil, status.Error(codes.InvalidArgument, fmt.Sprintf("invalid secret name %q", request.GetSecret()))
		}
		newMount = state.Mount{Kind: "secret", Secret: request.GetSecret(), Destination: request.GetDestination()}
	default:
		// Unreachable while mountKindFromProto is exhaustive, and kept so a
		// new kind cannot silently append a zero-valued mount.
		return nil, status.Error(codes.InvalidArgument, fmt.Sprintf("invalid mount kind %q", kind))
	}
	effective := containerMounts(workspace, *record)
	for _, existing := range effective {
		duplicate := false
		switch kind {
		case "":
			duplicate = existing.ProjectName == newMount.ProjectName && existing.Path == newMount.Path
		case "tmpfs":
			duplicate = existing.Kind == "tmpfs" && existing.Destination == newMount.Destination
		case "volume":
			duplicate = existing.Kind == "volume" && existing.Volume == newMount.Volume && existing.Destination == newMount.Destination
		case "secret":
			duplicate = existing.Kind == "secret" && existing.Destination == newMount.Destination
		}
		if duplicate {
			return nil, status.Error(codes.AlreadyExists, fmt.Sprintf("mount already exists: %s", mountLabel(newMount)))
		}
	}
	record.Mounts = append(append([]state.Mount(nil), effective...), newMount)
	if _, err := s.podmanMounts(record.Mounts); err != nil {
		s.log().Error("AddContainerMount project validation failed", "workspace_slug", workspace.WorkspaceSlug, "error", err)
		return nil, err
	}
	if _, err := s.podmanSecrets(record.Mounts); err != nil {
		s.log().Error("AddContainerMount secret validation failed", "workspace_slug", workspace.WorkspaceSlug, "error", err)
		return nil, err
	}
	if s.Podman == nil {
		return nil, status.Error(codes.FailedPrecondition, "podman is not configured")
	}
	if err := s.validateSecretReferences(nil, record.Mounts); err != nil {
		return nil, err
	}
	imageTag, err := s.resolveImageTag(record.ImageID)
	if err != nil {
		return nil, err
	}
	secret, err := s.ensureAgentToken(record)
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	if err := s.recreateOrRestore(workspace, record, imageTag, secret, &snapshot); err != nil {
		s.log().Error("control request failed", "method", "AddContainerMount", "workspace_slug", request.GetWorkspaceSlug(), "container", request.GetContainer(), "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	record.Status = "running"
	record.AgentToken = secret
	updated, err := s.upsertContainer(workspace, *record)
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	s.log().Info("control request completed", "method", "AddContainerMount", "workspace_slug", request.GetWorkspaceSlug(), "container", request.GetContainer(), "project", request.GetProject(), "path", request.GetPath())
	return containerProto(updated, *record), nil
}

// RemoveContainerMount removes a project, tmpfs, or named-volume mount from a
// container's mount list and recreates the podman container so the change
// takes effect.
func (s *Server) RemoveContainerMount(ctx context.Context, request *ctl.RemoveContainerMountRequest) (*ctl.Container, error) {
	s.log().Info("control request", "method", "RemoveContainerMount", "workspace_slug", request.GetWorkspaceSlug(), "container", request.GetContainer(), "project", request.GetProject(), "path", request.GetPath(), "kind", request.GetKind(), "volume", request.GetVolume())
	workspace, err := workspaceBySlug(s.Store, request.GetWorkspaceSlug())
	if err != nil {
		return nil, status.Error(codes.NotFound, err.Error())
	}
	record, ok := containerByLogical(&workspace, request.GetContainer())
	if !ok {
		s.log().Warn("control request failed", "method", "RemoveContainerMount", "workspace_slug", request.GetWorkspaceSlug(), "container", request.GetContainer(), "reason", "container not found")
		return nil, containerNotFoundError(request.GetContainer(), request.GetWorkspaceSlug())
	}
	snapshot := snapshotContainer(*record)
	kind, err := mountKindFromProto(request.GetKind())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}
	if !knownMountKind(kind) {
		return nil, status.Error(codes.InvalidArgument, fmt.Sprintf("invalid mount kind %q", kind))
	}
	effective := containerMounts(workspace, *record)
	index := -1
	for i, existing := range effective {
		matched := false
		switch kind {
		case "":
			matched = existing.Kind == "" && existing.ProjectName == request.GetProject() && existing.Path == request.GetPath()
		case "tmpfs":
			matched = existing.Kind == "tmpfs" && existing.Destination == request.GetDestination()
		case "volume":
			// The volume names the mount; a supplied destination must agree, so
			// the same volume at two destinations stays distinguishable.
			matched = existing.Kind == "volume" && existing.Volume == request.GetVolume()
			if matched && request.GetDestination() != "" {
				matched = existing.Destination == request.GetDestination()
			}
		case "secret":
			// The destination identifies the mount; the secret name, when
			// given, must agree.
			matched = existing.Kind == "secret" && existing.Destination == request.GetDestination()
			if matched && request.GetSecret() != "" {
				matched = existing.Secret == request.GetSecret()
			}
		}
		if matched {
			index = i
			break
		}
	}
	if index < 0 {
		s.log().Warn("control request failed", "method", "RemoveContainerMount", "workspace_slug", request.GetWorkspaceSlug(), "container", request.GetContainer(), "reason", "mount not found")
		return nil, status.Error(codes.NotFound, fmt.Sprintf("mount not found: %s", mountLabel(state.Mount{Kind: kind, ProjectName: request.GetProject(), Path: request.GetPath(), Volume: request.GetVolume(), Secret: request.GetSecret(), Destination: request.GetDestination()})))
	}
	if record.Name == "default" && isWorkspaceProjectMount(workspace, effective[index]) {
		return nil, status.Error(codes.FailedPrecondition, "the default container keeps the workspace project mount")
	}
	record.Mounts = append(append([]state.Mount(nil), effective[:index]...), effective[index+1:]...)
	if _, err := s.podmanMounts(record.Mounts); err != nil {
		s.log().Error("RemoveContainerMount project validation failed", "workspace_slug", workspace.WorkspaceSlug, "error", err)
		return nil, err
	}
	if _, err := s.podmanSecrets(record.Mounts); err != nil {
		s.log().Error("RemoveContainerMount secret validation failed", "workspace_slug", workspace.WorkspaceSlug, "error", err)
		return nil, err
	}
	if s.Podman == nil {
		return nil, status.Error(codes.FailedPrecondition, "podman is not configured")
	}
	if err := s.validateSecretReferences(record.SecretEnv, record.Mounts); err != nil {
		return nil, err
	}
	imageTag, err := s.resolveImageTag(record.ImageID)
	if err != nil {
		return nil, err
	}
	secret, err := s.ensureAgentToken(record)
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	if err := s.recreateOrRestore(workspace, record, imageTag, secret, &snapshot); err != nil {
		s.log().Error("control request failed", "method", "RemoveContainerMount", "workspace_slug", request.GetWorkspaceSlug(), "container", request.GetContainer(), "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	record.Status = "running"
	record.AgentToken = secret
	updated, err := s.upsertContainer(workspace, *record)
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	s.log().Info("control request completed", "method", "RemoveContainerMount", "workspace_slug", request.GetWorkspaceSlug(), "container", request.GetContainer(), "project", request.GetProject(), "path", request.GetPath())
	return containerProto(updated, *record), nil
}

// containerMounts returns the mounts that apply to a container: its own list
// when present, otherwise the workspace's default mounts — for the default
// container only. Named containers carry exactly the mounts they were given;
// an empty list means no mounts.
func containerMounts(ws state.Workspace, c state.Container) []state.Mount {
	if len(c.Mounts) > 0 {
		return c.Mounts
	}
	if c.Name == "" || c.Name == "default" {
		return ws.Mounts
	}
	return nil
}

// isWorkspaceProjectMount reports whether mount is the workspace's primary
// project mount: the project-kind mount at the workspace's project directory
// root. The default container always keeps it.
func isWorkspaceProjectMount(ws state.Workspace, mount state.Mount) bool {
	return ws.ProjectName != "" && mount.Kind == "" && mount.ProjectName == ws.ProjectName && mount.Path == ""
}

// ensureWorkspaceProjectMount returns mounts with the workspace's primary
// project mount present, appending it read-write when missing. It is a no-op
// when the workspace has no project name.
func ensureWorkspaceProjectMount(mounts []state.Mount, ws state.Workspace) []state.Mount {
	if ws.ProjectName == "" {
		return mounts
	}
	for _, mount := range mounts {
		if isWorkspaceProjectMount(ws, mount) {
			return mounts
		}
	}
	return append(append([]state.Mount(nil), mounts...), state.Mount{ProjectName: ws.ProjectName, Mode: "read_write"})
}
