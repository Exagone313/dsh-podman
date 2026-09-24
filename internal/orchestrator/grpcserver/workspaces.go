// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"context"
	"fmt"
	"path/filepath"
	"time"

	ctl "github.com/Exagone313/dsh-podman/internal/genproto/dshctl/v1"
	"github.com/Exagone313/dsh-podman/internal/orchestrator/projects"
	"github.com/Exagone313/dsh-podman/internal/orchestrator/state"
	"github.com/Exagone313/dsh-podman/internal/orchestrator/token"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func (s *Server) ListProjects(context.Context, *ctl.ListProjectsRequest) (*ctl.ListProjectsResponse, error) {
	s.log().Info("control request", "method", "ListProjects", "projects_root", s.ProjectsRoot)
	found, err := projects.List(s.ProjectsRoot)
	if err != nil {
		s.log().Error("control request failed", "method", "ListProjects", "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	result := &ctl.ListProjectsResponse{}
	for _, project := range found {
		result.Projects = append(result.Projects, &ctl.Project{Name: project.Name, HostPath: project.HostPath})
	}
	s.log().Info("control request completed", "method", "ListProjects", "count", len(result.Projects))
	return result, nil
}

// DescribeWorkspace reports a stored workspace. It is a pure read: it never
// probes podman nor recreates anything, so a caller cannot change state by
// describing. Making a container usable is EnsureContainer's job.
func (s *Server) DescribeWorkspace(_ context.Context, request *ctl.DescribeWorkspaceRequest) (*ctl.Workspace, error) {
	s.log().Info("control request", "method", "DescribeWorkspace", "workspace_slug", request.GetWorkspaceSlug())
	workspaces, err := s.Store.Workspaces()
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	for _, workspace := range workspaces {
		if workspace.WorkspaceSlug == request.GetWorkspaceSlug() {
			if !containerNamePattern.MatchString(workspace.ContainerName) {
				s.log().Warn("DescribeWorkspace found invalid container name", "workspace_slug", workspace.WorkspaceSlug, "container_name", workspace.ContainerName)
				return nil, status.Error(codes.NotFound, fmt.Sprintf("workspace %q not found", request.GetWorkspaceSlug()))
			}
			s.log().Info("control request completed", "method", "DescribeWorkspace", "workspace_slug", workspace.WorkspaceSlug, "status", workspace.Status)
			return toProto(workspace), nil
		}
	}
	s.log().Warn("control request failed", "method", "DescribeWorkspace", "workspace_slug", request.GetWorkspaceSlug(), "reason", "not found")
	return nil, status.Error(codes.NotFound, fmt.Sprintf("workspace %q not found", request.GetWorkspaceSlug()))
}

// refreshContainer recreates a container that cannot be reused — stopped, or
// carrying an agent from an outdated guest-agent image — and returns the
// refreshed workspace. The guest-agent image is pulled only when it is absent
// (podman.Client.CreateWorkspace's ensureImage), so a local development image
// is never pulled.
func (s *Server) refreshContainer(workspace state.Workspace, record *state.Container) (state.Workspace, error) {
	imageTag, err := s.resolveImageTag(record.ImageID)
	if err != nil {
		return workspace, err
	}
	token, err := s.ensureAgentToken(record)
	if err != nil {
		return workspace, status.Error(codes.Internal, err.Error())
	}
	if err := s.recreateContainer(workspace, record, imageTag, token, record.Env); err != nil {
		s.log().Error("recreating guest container failed", "workspace_slug", workspace.WorkspaceSlug, "container", record.Name, "error", err)
		return workspace, status.Error(codes.Internal, err.Error())
	}
	record.Status = "running"
	record.AgentToken = token
	updated, err := s.upsertContainer(workspace, *record)
	if err != nil {
		return workspace, status.Error(codes.Internal, err.Error())
	}
	s.log().Info("recreated guest container", "workspace_slug", workspace.WorkspaceSlug, "container", record.Name)
	return updated, nil
}

func (s *Server) ListWorkspaces(context.Context, *ctl.ListWorkspacesRequest) (*ctl.ListWorkspacesResponse, error) {
	s.log().Info("control request", "method", "ListWorkspaces")
	workspaces, err := s.Store.Workspaces()
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	result := &ctl.ListWorkspacesResponse{}
	for _, workspace := range workspaces {
		result.Workspaces = append(result.Workspaces, toProto(workspace))
	}
	s.log().Info("control request completed", "method", "ListWorkspaces", "count", len(result.Workspaces))
	return result, nil
}

// upsertContainer replaces (or appends) the container record with the same
// logical name in the workspace, keeps the legacy default-container fields in
// sync, and persists the workspace.
//
// The record is merged into the workspace as the store currently holds it, not
// written back from the snapshot the caller read: callers mutate a record after
// a multi-second podman recreate, and writing the whole stale workspace would
// silently drop a concurrent change to another container.
func (s *Server) upsertContainer(workspace state.Workspace, record state.Container) (state.Workspace, error) {
	var result state.Workspace
	if err := s.Store.UpdateWorkspaces(func(all []state.Workspace) ([]state.Workspace, error) {
		for i := range all {
			if all[i].WorkspaceSlug != workspace.WorkspaceSlug {
				continue
			}
			merged := all[i]
			replaceContainerRecord(&merged, record)
			syncDefaultFields(&merged)
			all[i] = merged
			result = merged
			return all, nil
		}
		merged := workspace
		replaceContainerRecord(&merged, record)
		syncDefaultFields(&merged)
		result = merged
		return append(all, merged), nil
	}); err != nil {
		return state.Workspace{}, err
	}
	return result, nil
}

// replaceContainerRecord replaces (or appends) the container with the same
// logical name, leaving every other container record untouched.
func replaceContainerRecord(workspace *state.Workspace, record state.Container) {
	for i := range workspace.Containers {
		if workspace.Containers[i].Name == record.Name {
			workspace.Containers[i] = record
			return
		}
	}
	workspace.Containers = append(workspace.Containers, record)
}

// syncDefaultFields projects the default container record onto the workspace's
// legacy single-container fields so existing consumers stay consistent. With no
// default container left the fields are cleared, so the state store's legacy
// migration cannot re-materialize a phantom container (which would keep the
// workspace's pod alive after its last container is removed).
func syncDefaultFields(ws *state.Workspace) {
	for i := range ws.Containers {
		if ws.Containers[i].Name == "default" {
			ws.ContainerName = ws.Containers[i].PodmanName
			ws.ImageID = ws.Containers[i].ImageID
			ws.Status = ws.Containers[i].Status
			ws.AgentSocketPath = ws.Containers[i].AgentSocketPath
			ws.AgentToken = ws.Containers[i].AgentToken
			ws.CreatedAt = ws.Containers[i].CreatedAt
			// The default container's mounts are authoritative; the
			// workspace-level list is the fallback a fresh default container
			// starts from. An empty container list leaves it untouched, so a
			// mode change survives the container being removed and restarted.
			ws.Mounts = containerMounts(*ws, ws.Containers[i])
			return
		}
	}
	ws.ContainerName = ""
	ws.ImageID = ""
	ws.Status = ""
	ws.AgentSocketPath = ""
	ws.AgentToken = ""
	ws.CreatedAt = ""
}

func (s *Server) CreateWorkspace(ctx context.Context, request *ctl.CreateWorkspaceRequest) (*ctl.Workspace, error) {
	s.log().Info("control request", "method", "CreateWorkspace", "workspace_slug", request.GetWorkspaceSlug(), "image_id", request.GetImageId(), "mount_count", len(request.GetMounts()))
	if !validWorkspaceSlug(request.GetWorkspaceSlug()) {
		return nil, status.Error(codes.InvalidArgument, fmt.Sprintf("invalid workspace slug %q", request.GetWorkspaceSlug()))
	}
	projectName := request.GetProjectName()
	if projectName == "" {
		return nil, status.Error(codes.InvalidArgument, "project name is required")
	}
	if !validProjectPath(projectName) {
		return nil, status.Error(codes.InvalidArgument, fmt.Sprintf("invalid project name %q", projectName))
	}
	imageID := request.GetImageId()
	if imageID == "" {
		imageID = defaultImageShort()
	}
	imageTag, err := s.resolveImageTag(imageID)
	if err != nil {
		s.log().Info("CreateWorkspace image lookup", "image_id", imageID, "found", false, "error", err)
		return nil, err
	}
	secret, err := token.New()
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	mounts, err := stateMounts(request.GetMounts())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}
	defaultMounts := mounts
	var defaultPaths []string
	storedDefault := false
	if existing, storeErr := s.Store.Workspaces(); storeErr == nil {
		for _, workspace := range existing {
			if workspace.WorkspaceSlug == request.GetWorkspaceSlug() {
				if record, ok := containerByLogical(&workspace, "default"); ok {
					storedDefault = true
					if len(record.Mounts) > 0 {
						defaultMounts = record.Mounts
					}
					defaultPaths = append([]string(nil), record.Paths...)
				}
				break
			}
		}
	}
	// A create request may set the container's PATH additions; without them a
	// replaced default container keeps the list it had.
	if len(request.GetPaths()) > 0 {
		paths, pathErr := validPathAdditions(request.GetPaths())
		if pathErr != nil {
			return nil, status.Error(codes.InvalidArgument, pathErr.Error())
		}
		defaultPaths = paths
	}
	defaultMounts = ensureWorkspaceProjectMount(defaultMounts, state.Workspace{ProjectName: projectName})
	podmanMounts, mountErr := s.podmanMounts(defaultMounts)
	if mountErr != nil {
		s.log().Error("CreateWorkspace project validation failed", "root", s.ProjectsRoot, "error", mountErr)
		return nil, mountErr
	}
	secrets, secretErr := s.podmanSecrets(defaultMounts)
	if secretErr != nil {
		s.log().Error("CreateWorkspace secret validation failed", "root", s.ProjectsRoot, "error", secretErr)
		return nil, secretErr
	}
	userEnv := cloneMap(request.GetEnv())
	if err := validateEnv(userEnv); err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}
	userSecretEnv := cloneMap(request.GetSecretEnv())
	if err := validateSecretEnv(userSecretEnv); err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}
	envSecrets := s.containerEnvSecrets(userSecretEnv)
	if s.Podman == nil {
		return nil, status.Error(codes.FailedPrecondition, "podman is not configured")
	}
	if err := s.validateSecretReferences(userSecretEnv, defaultMounts); err != nil {
		return nil, err
	}
	exists, imageErr := s.Podman.ImageExists(imageTag)
	if imageErr != nil {
		return nil, status.Error(codes.Internal, imageErr.Error())
	}
	if !exists {
		s.log().Warn("CreateWorkspace image state is stale", "image_id", imageID, "image_tag", imageTag)
		return nil, status.Error(codes.NotFound, fmt.Sprintf("image %q not found", imageID))
	}
	name := podmanContainerName(request.GetWorkspaceSlug(), "default")
	// A stored default container whose podman container still exists means the
	// workspace is already created; report that clearly instead of letting
	// podman fail with a duplicate-name error. A container without a stored
	// record is an untracked leftover (an earlier create failed after making
	// it, or it was removed outside dsh-podman): drop it so the create below is
	// not blocked, mirroring StartContainer.
	containerExists, existsErr := s.Podman.ContainerExists(name)
	if existsErr != nil {
		return nil, status.Error(codes.Internal, existsErr.Error())
	}
	if containerExists {
		if storedDefault {
			s.log().Warn("control request failed", "method", "CreateWorkspace", "workspace_slug", request.GetWorkspaceSlug(), "reason", "default container already exists")
			return nil, status.Error(codes.AlreadyExists, fmt.Sprintf("workspace %q already has a default container", request.GetWorkspaceSlug()))
		}
		s.log().Warn("CreateWorkspace removing untracked container", "workspace_slug", request.GetWorkspaceSlug(), "container_name", name)
		if removeErr := s.Podman.Remove(name); removeErr != nil {
			return nil, status.Error(codes.Internal, removeErr.Error())
		}
	}
	if err := s.Podman.CreateWorkspace(podNameFor(request.GetWorkspaceSlug()), name, imageTag, secret, podmanMounts, secrets, envSecrets, userEnv, defaultPaths); err != nil {
		s.log().Error("control request failed", "method", "CreateWorkspace", "workspace_slug", request.GetWorkspaceSlug(), "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	agentSocket := filepath.Join(s.SocketsRoot, name, "guest.sock")
	createdAt := time.Now().UTC().Format(time.RFC3339)
	workspace := state.Workspace{WorkspaceSlug: request.GetWorkspaceSlug(), ProjectName: projectName, ContainerName: name, ImageID: imageID, Mounts: defaultMounts, Status: "running", AgentSocketPath: agentSocket, AgentToken: secret, CreatedAt: createdAt, Containers: []state.Container{{Name: "default", PodmanName: name, ImageID: imageID, Mounts: defaultMounts, Paths: defaultPaths, Status: "running", CreatedAt: createdAt, AgentSocketPath: agentSocket, AgentToken: secret, Env: userEnv, SecretEnv: userSecretEnv}}}
	if err := s.Store.UpdateWorkspaces(func(all []state.Workspace) ([]state.Workspace, error) {
		replaced := false
		for i := range all {
			if all[i].WorkspaceSlug == workspace.WorkspaceSlug {
				all[i] = workspace
				replaced = true
			}
		}
		if !replaced {
			all = append(all, workspace)
		}
		return all, nil
	}); err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	s.log().Info("control request completed", "method", "CreateWorkspace", "workspace_slug", workspace.WorkspaceSlug, "container_name", workspace.ContainerName)
	return toProto(workspace), nil
}

// RemoveWorkspace tears a workspace down: it stops the daemons of every stored
// container, removes the workspace's pod (which removes any container left in
// it), cleans the containers' socket directories, and drops the stored
// workspace. It is idempotent: an absent workspace or pod succeeds, so the
// settings card can call it for a workspace that never had a container.
func (s *Server) RemoveWorkspace(_ context.Context, request *ctl.RemoveWorkspaceRequest) (*ctl.RemoveWorkspaceResponse, error) {
	slug := request.GetWorkspaceSlug()
	s.log().Info("control request", "method", "RemoveWorkspace", "workspace_slug", slug)
	if !validWorkspaceSlug(slug) {
		return nil, status.Error(codes.InvalidArgument, fmt.Sprintf("invalid workspace slug %q", slug))
	}
	if s.Podman == nil {
		return nil, status.Error(codes.FailedPrecondition, "podman is not configured")
	}
	workspace, err := workspaceBySlug(s.Store, slug)
	if err != nil {
		// Tolerate an absent record: the pod may still exist (for example after
		// a reconcile dropped the workspace), so tear it down either way.
		s.log().Info("RemoveWorkspace has no stored workspace", "workspace_slug", slug)
		workspace = state.Workspace{WorkspaceSlug: slug}
	}
	for i := range workspace.Containers {
		s.stopContainerDaemons(context.Background(), workspace.Containers[i])
	}
	if err := s.Podman.RemovePod(podNameFor(slug)); err != nil {
		s.log().Error("control request failed", "method", "RemoveWorkspace", "workspace_slug", slug, "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	for i := range workspace.Containers {
		s.removeSocketDir(workspace.Containers[i].PodmanName)
	}
	if err := s.Store.UpdateWorkspaces(func(all []state.Workspace) ([]state.Workspace, error) {
		remaining := make([]state.Workspace, 0, len(all))
		for _, ws := range all {
			if ws.WorkspaceSlug != slug {
				remaining = append(remaining, ws)
			}
		}
		return remaining, nil
	}); err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	s.log().Info("control request completed", "method", "RemoveWorkspace", "workspace_slug", slug)
	return &ctl.RemoveWorkspaceResponse{}, nil
}

// removePodIfEmpty deletes a workspace's pod when the store no longer holds any
// container for it, so an orphan cleanup does not leave an empty pod behind.
func (s *Server) removePodIfEmpty(slug string) {
	if s.Podman == nil {
		return
	}
	workspaces, err := s.Store.Workspaces()
	if err != nil {
		s.log().Warn("pod cleanup workspace read failed", "workspace_slug", slug, "error", err)
		return
	}
	for _, ws := range workspaces {
		if ws.WorkspaceSlug != slug {
			continue
		}
		if len(ws.Containers) == 0 {
			if podErr := s.Podman.RemovePod(podNameFor(slug)); podErr != nil {
				s.log().Warn("pod cleanup failed", "workspace_slug", slug, "error", podErr)
			}
		}
		return
	}
}

// removeSocketDir deletes a removed container's socket directory, best-effort:
// a failure must not fail the control call that already removed the container.
func (s *Server) removeSocketDir(podmanName string) {
	if s.Podman == nil {
		return
	}
	if err := s.Podman.RemoveSocketDir(podmanName); err != nil {
		s.log().Warn("socket dir cleanup failed", "container_name", podmanName, "error", err)
	}
}

func toProto(workspace state.Workspace) *ctl.Workspace {
	result := &ctl.Workspace{WorkspaceSlug: workspace.WorkspaceSlug, ProjectName: workspace.ProjectName, ContainerName: workspace.ContainerName, ImageId: workspace.ImageID, Status: workspace.Status, AgentSocketPath: workspace.AgentSocketPath, AgentToken: workspace.AgentToken, CreatedAt: workspace.CreatedAt}
	// The default container's mounts are authoritative: the workspace-level
	// list is only the fallback for a workspace whose default container has
	// none. Reporting the fallback here would hide a mode change applied to
	// the default container (for example by RecreateContainer).
	mounts := workspace.Mounts
	if defaultContainer, ok := containerByLogical(&workspace, "default"); ok {
		result.Env = cloneMap(defaultContainer.Env)
		result.SecretEnv = cloneMap(defaultContainer.SecretEnv)
		mounts = containerMounts(workspace, *defaultContainer)
	}
	for _, mount := range mounts {
		mode := ctl.MountMode_MOUNT_MODE_READ_ONLY
		if mount.Mode == "read_write" {
			mode = ctl.MountMode_MOUNT_MODE_READ_WRITE
		}
		result.Mounts = append(result.Mounts, &ctl.ProjectMount{ProjectName: mount.ProjectName, Destination: mount.Destination, Mode: mode, Kind: mountKindToProto(mount.Kind), Volume: mount.Volume})
	}
	return result
}
