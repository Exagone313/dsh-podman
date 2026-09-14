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

// AddContainerMount adds a project, tmpfs, or named-volume mount to a
// container's mount list and recreates the podman container so the change
// takes effect.
func (s *Server) AddContainerMount(ctx context.Context, request *ctl.AddContainerMountRequest) (*ctl.Container, error) {
	s.log().Info("control request", "method", "AddContainerMount", "workspace_slug", request.GetWorkspaceSlug(), "container", request.GetContainer(), "project", request.GetProject(), "kind", request.GetKind(), "volume", request.GetVolume())
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
		newMount = state.Mount{ProjectName: request.GetProject(), Destination: request.GetDestination(), Mode: mode}
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
			duplicate = existing.ProjectName == newMount.ProjectName
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
	s.log().Info("control request completed", "method", "AddContainerMount", "workspace_slug", request.GetWorkspaceSlug(), "container", request.GetContainer(), "project", request.GetProject())
	return containerProto(updated, *record), nil
}

// RemoveContainerMount removes a project, tmpfs, or named-volume mount from a
// container's mount list and recreates the podman container so the change
// takes effect.
func (s *Server) RemoveContainerMount(ctx context.Context, request *ctl.RemoveContainerMountRequest) (*ctl.Container, error) {
	s.log().Info("control request", "method", "RemoveContainerMount", "workspace_slug", request.GetWorkspaceSlug(), "container", request.GetContainer(), "project", request.GetProject(), "kind", request.GetKind(), "volume", request.GetVolume())
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
	requested := state.Mount{Kind: kind, ProjectName: request.GetProject(), Volume: request.GetVolume(), Secret: request.GetSecret(), Destination: request.GetDestination()}
	if !mountSelectorIdentifies(kind, request) {
		return nil, status.Error(codes.InvalidArgument, fmt.Sprintf("a %s mount is identified by %s", mountKindName(kind), mountSelectorHandles(kind)))
	}
	matches := make([]int, 0, 1)
	for i, existing := range effective {
		if mountSelectorMatches(kind, existing, request) {
			matches = append(matches, i)
		}
	}
	switch {
	case len(matches) == 0:
		s.log().Warn("control request failed", "method", "RemoveContainerMount", "workspace_slug", request.GetWorkspaceSlug(), "container", request.GetContainer(), "reason", "mount not found")
		return nil, status.Error(codes.NotFound, mountNotFoundMessage(kind, requested, effective))
	case len(matches) > 1:
		s.log().Warn("control request failed", "method", "RemoveContainerMount", "workspace_slug", request.GetWorkspaceSlug(), "container", request.GetContainer(), "reason", "ambiguous mount")
		return nil, status.Error(codes.InvalidArgument, ambiguousMountMessage(requested, effective, matches))
	}
	index := matches[0]
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
	s.log().Info("control request completed", "method", "RemoveContainerMount", "workspace_slug", request.GetWorkspaceSlug(), "container", request.GetContainer(), "project", request.GetProject())
	return containerProto(updated, *record), nil
}

// UpdateContainerMount changes the mode of one existing mount and recreates the
// podman container so the change takes effect. Only kinds that carry a mode can
// be updated: project and volume mounts. tmpfs is always read-write and secret
// mounts carry no mode, so both are rejected. The default container's primary
// project mount is updateable — that is how a workspace's project is remounted
// read-only.
func (s *Server) UpdateContainerMount(ctx context.Context, request *ctl.UpdateContainerMountRequest) (*ctl.Container, error) {
	s.log().Info("control request", "method", "UpdateContainerMount", "workspace_slug", request.GetWorkspaceSlug(), "container", request.GetContainer(), "project", request.GetProject(), "kind", request.GetKind(), "volume", request.GetVolume())
	workspace, err := workspaceBySlug(s.Store, request.GetWorkspaceSlug())
	if err != nil {
		return nil, status.Error(codes.NotFound, err.Error())
	}
	record, ok := containerByLogical(&workspace, request.GetContainer())
	if !ok {
		s.log().Warn("control request failed", "method", "UpdateContainerMount", "workspace_slug", request.GetWorkspaceSlug(), "container", request.GetContainer(), "reason", "container not found")
		return nil, containerNotFoundError(request.GetContainer(), request.GetWorkspaceSlug())
	}
	snapshot := snapshotContainer(*record)
	kind, err := mountKindFromProto(request.GetKind())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}
	switch kind {
	case "", "volume":
	default:
		return nil, status.Error(codes.InvalidArgument, fmt.Sprintf("%s mounts have no mode to update", mountKindName(kind)))
	}
	mode, err := mountModeFromProto(request.GetMode())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}
	effective := containerMounts(workspace, *record)
	requested := state.Mount{Kind: kind, ProjectName: request.GetProject(), Volume: request.GetVolume(), Secret: request.GetSecret(), Destination: request.GetDestination()}
	if !mountSelectorIdentifies(kind, request) {
		return nil, status.Error(codes.InvalidArgument, fmt.Sprintf("a %s mount is identified by %s", mountKindName(kind), mountSelectorHandles(kind)))
	}
	matches := make([]int, 0, 1)
	for i, existing := range effective {
		if mountSelectorMatches(kind, existing, request) {
			matches = append(matches, i)
		}
	}
	switch {
	case len(matches) == 0:
		s.log().Warn("control request failed", "method", "UpdateContainerMount", "workspace_slug", request.GetWorkspaceSlug(), "container", request.GetContainer(), "reason", "mount not found")
		return nil, status.Error(codes.NotFound, mountNotFoundMessage(kind, requested, effective))
	case len(matches) > 1:
		s.log().Warn("control request failed", "method", "UpdateContainerMount", "workspace_slug", request.GetWorkspaceSlug(), "container", request.GetContainer(), "reason", "ambiguous mount")
		return nil, status.Error(codes.InvalidArgument, ambiguousMountMessage(requested, effective, matches))
	}
	if effective[matches[0]].Mode == mode {
		return nil, status.Error(codes.AlreadyExists, fmt.Sprintf("mount already has mode %q", mode))
	}
	record.Mounts = append([]state.Mount(nil), effective...)
	record.Mounts[matches[0]].Mode = mode
	if _, err := s.podmanMounts(record.Mounts); err != nil {
		s.log().Error("UpdateContainerMount project validation failed", "workspace_slug", workspace.WorkspaceSlug, "error", err)
		return nil, err
	}
	if _, err := s.podmanSecrets(record.Mounts); err != nil {
		s.log().Error("UpdateContainerMount secret validation failed", "workspace_slug", workspace.WorkspaceSlug, "error", err)
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
		s.log().Error("control request failed", "method", "UpdateContainerMount", "workspace_slug", request.GetWorkspaceSlug(), "container", request.GetContainer(), "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	record.Status = "running"
	record.AgentToken = secret
	updated, err := s.upsertContainer(workspace, *record)
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	s.log().Info("control request completed", "method", "UpdateContainerMount", "workspace_slug", request.GetWorkspaceSlug(), "container", request.GetContainer(), "project", request.GetProject())
	return containerProto(updated, *record), nil
}

// mountSelectorRequest is the shared selector surface of the mount mutations
// that identify exactly one mount (remove and update). Both generated request
// types carry the same handles.
type mountSelectorRequest interface {
	GetProject() string
	GetVolume() string
	GetSecret() string
	GetDestination() string
}

// mountSelectorMatches reports whether a stored mount is identified by the
// removal request: the kind must agree and every handle the caller supplied
// must agree too. A handle the caller omitted matches any value, so a name
// alone selects the mount whenever it is unambiguous (the caller then gets
// every match and RemoveContainerMount rejects an ambiguous selection).
func mountSelectorMatches(kind string, existing state.Mount, request mountSelectorRequest) bool {
	switch kind {
	case "":
		return existing.Kind == "" && existing.ProjectName == request.GetProject()
	case "tmpfs":
		return existing.Kind == "tmpfs" && existing.Destination == request.GetDestination()
	case "volume":
		if existing.Kind != "volume" {
			return false
		}
		if request.GetVolume() != "" && existing.Volume != request.GetVolume() {
			return false
		}
		return request.GetDestination() == "" || existing.Destination == request.GetDestination()
	case "secret":
		if existing.Kind != "secret" {
			return false
		}
		if request.GetSecret() != "" && existing.Secret != request.GetSecret() {
			return false
		}
		return request.GetDestination() == "" || existing.Destination == request.GetDestination()
	}
	return false
}

// mountSelectorIdentifies reports whether the request carries a handle for its
// kind, so a handle-free request cannot match (and remove) an arbitrary mount.
func mountSelectorIdentifies(kind string, request mountSelectorRequest) bool {
	switch kind {
	case "":
		return request.GetProject() != ""
	case "tmpfs":
		return request.GetDestination() != ""
	case "volume":
		return request.GetVolume() != "" || request.GetDestination() != ""
	case "secret":
		return request.GetSecret() != "" || request.GetDestination() != ""
	}
	return false
}

// mountSelectorHandles names the handles a removal request needs, for the
// under-specified-request error.
func mountSelectorHandles(kind string) string {
	switch kind {
	case "tmpfs":
		return "destination"
	case "volume":
		return "volume or destination"
	case "secret":
		return "secret or destination"
	default:
		return "project"
	}
}

// mountKindName names a mount kind the way a caller sees it (the empty kind is
// the legacy project kind).
func mountKindName(kind string) string {
	if kind == "" {
		return "project"
	}
	return kind
}

// mountNotFoundMessage builds the NotFound reason for a removal that matched
// nothing, listing the container's mounts of the same kind that the caller's
// name filters still allow, so a missing destination is visible.
func mountNotFoundMessage(kind string, requested state.Mount, mounts []state.Mount) string {
	candidates := mountCandidates(kind, requested, mounts)
	if len(candidates) == 0 {
		return fmt.Sprintf("mount not found: %s", mountLabel(requested))
	}
	return fmt.Sprintf("mount not found: %s; the container mounts %s", mountLabel(requested), strings.Join(candidates, ", "))
}

// ambiguousMountMessage builds the InvalidArgument reason for a name that
// selects more than one mount, naming the handle that would disambiguate.
func ambiguousMountMessage(requested state.Mount, mounts []state.Mount, matches []int) string {
	distinguishers := make([]string, 0, len(matches))
	for _, index := range matches {
		distinguishers = append(distinguishers, mountDistinguisher(mounts[index]))
	}
	return fmt.Sprintf("ambiguous mount: %s matches %s; pass %s", mountLabel(requested), strings.Join(distinguishers, ", "), mountDisambiguator())
}

// mountCandidates labels the container's mounts of the requested kind that the
// caller's name filters (volume, secret, project) still allow.
func mountCandidates(kind string, requested state.Mount, mounts []state.Mount) []string {
	labels := make([]string, 0, len(mounts))
	for _, mount := range mounts {
		if mount.Kind != kind {
			continue
		}
		if requested.ProjectName != "" && mount.ProjectName != requested.ProjectName {
			continue
		}
		if requested.Volume != "" && mount.Volume != requested.Volume {
			continue
		}
		if requested.Secret != "" && mount.Secret != requested.Secret {
			continue
		}
		labels = append(labels, mountLabel(mount))
	}
	return labels
}

// mountDistinguisher renders the value that tells two mounts of the same kind
// apart: their destination. A project mount is unique by project path, so it
// never needs disambiguating.
func mountDistinguisher(mount state.Mount) string {
	return fmt.Sprintf("%q", mount.Destination)
}

// mountDisambiguator names the handle that distinguishes two mounts of the
// same kind.
func mountDisambiguator() string {
	return "destination"
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
	return ws.ProjectName != "" && mount.Kind == "" && mount.ProjectName == ws.ProjectName
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
