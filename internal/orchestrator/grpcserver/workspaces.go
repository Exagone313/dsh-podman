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
			if s.Podman != nil {
				exists, containerErr := s.Podman.ContainerExists(workspace.ContainerName)
				if containerErr != nil {
					return nil, status.Error(codes.Internal, containerErr.Error())
				}
				if !exists {
					s.log().Warn("DescribeWorkspace found stale state", "workspace_slug", workspace.WorkspaceSlug, "container_name", workspace.ContainerName)
					return nil, status.Error(codes.NotFound, fmt.Sprintf("guest container %q not found", workspace.ContainerName))
				}
				running, runningErr := s.Podman.ContainerRunning(workspace.ContainerName)
				if runningErr != nil {
					return nil, status.Error(codes.Internal, runningErr.Error())
				}
				if !running {
					// A stopped container (podman/host restart, manual stop,
					// crash) would otherwise leave every resolve waiting on a
					// socket nobody listens on. Recreate it so the guest agent
					// comes back before the socket is handed out.
					refreshed, recreateErr := s.recreateStoppedContainer(workspace)
					if recreateErr != nil {
						return nil, recreateErr
					}
					workspace = refreshed
				}
			}
			s.log().Info("control request completed", "method", "DescribeWorkspace", "workspace_slug", workspace.WorkspaceSlug, "status", workspace.Status)
			return toProto(workspace), nil
		}
	}
	s.log().Warn("control request failed", "method", "DescribeWorkspace", "workspace_slug", request.GetWorkspaceSlug(), "reason", "not found")
	return nil, status.Error(codes.NotFound, fmt.Sprintf("workspace %q not found", request.GetWorkspaceSlug()))
}

// recreateStoppedContainer recreates a workspace's stopped default container
// (podman/host restart, manual stop, or crash) so its guest agent comes back,
// and returns the refreshed workspace. Only called from DescribeWorkspace,
// which has already established that the container exists but is not running.
func (s *Server) recreateStoppedContainer(workspace state.Workspace) (state.Workspace, error) {
	record, ok := containerByLogical(&workspace, "default")
	if !ok {
		return workspace, status.Error(codes.NotFound, fmt.Sprintf("guest container %q not found", workspace.ContainerName))
	}
	imageTag, err := s.resolveImageTag(record.ImageID)
	if err != nil {
		return workspace, err
	}
	token, err := s.ensureAgentToken(record)
	if err != nil {
		return workspace, status.Error(codes.Internal, err.Error())
	}
	if err := s.recreateContainer(workspace, record, imageTag, token, record.Env); err != nil {
		s.log().Error("recreating stopped guest container failed", "workspace_slug", workspace.WorkspaceSlug, "container", record.Name, "error", err)
		return workspace, status.Error(codes.Internal, err.Error())
	}
	record.Status = "running"
	record.AgentToken = token
	updated, err := s.upsertContainer(workspace, *record)
	if err != nil {
		return workspace, status.Error(codes.Internal, err.Error())
	}
	s.log().Info("recreated stopped guest container", "workspace_slug", workspace.WorkspaceSlug, "container", record.Name)
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
func (s *Server) upsertContainer(workspace state.Workspace, record state.Container) (state.Workspace, error) {
	replaced := false
	for i := range workspace.Containers {
		if workspace.Containers[i].Name == record.Name {
			workspace.Containers[i] = record
			replaced = true
		}
	}
	if !replaced {
		workspace.Containers = append(workspace.Containers, record)
	}
	syncDefaultFields(&workspace)
	if err := s.Store.UpdateWorkspaces(func(all []state.Workspace) ([]state.Workspace, error) {
		for i := range all {
			if all[i].WorkspaceSlug == workspace.WorkspaceSlug {
				all[i] = workspace
				return all, nil
			}
		}
		return append(all, workspace), nil
	}); err != nil {
		return state.Workspace{}, err
	}
	return workspace, nil
}

// syncDefaultFields projects the default container record onto the workspace's
// legacy single-container fields so existing consumers stay consistent.
func syncDefaultFields(ws *state.Workspace) {
	for i := range ws.Containers {
		if ws.Containers[i].Name == "default" {
			ws.ContainerName = ws.Containers[i].PodmanName
			ws.ImageID = ws.Containers[i].ImageID
			ws.Status = ws.Containers[i].Status
			ws.AgentSocketPath = ws.Containers[i].AgentSocketPath
			ws.AgentToken = ws.Containers[i].AgentToken
			ws.CreatedAt = ws.Containers[i].CreatedAt
			return
		}
	}
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
	if !validProjectName(projectName) {
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
	if existing, storeErr := s.Store.Workspaces(); storeErr == nil {
		for _, workspace := range existing {
			if workspace.WorkspaceSlug == request.GetWorkspaceSlug() {
				if record, ok := containerByLogical(&workspace, "default"); ok && len(record.Mounts) > 0 {
					defaultMounts = record.Mounts
				}
				break
			}
		}
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
	if err := s.Podman.CreateWorkspace(podNameFor(request.GetWorkspaceSlug()), name, imageTag, secret, podmanMounts, secrets, envSecrets, userEnv); err != nil {
		s.log().Error("control request failed", "method", "CreateWorkspace", "workspace_slug", request.GetWorkspaceSlug(), "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	agentSocket := filepath.Join(s.SocketsRoot, name, "guest.sock")
	createdAt := time.Now().UTC().Format(time.RFC3339)
	workspace := state.Workspace{WorkspaceSlug: request.GetWorkspaceSlug(), ProjectName: projectName, ContainerName: name, ImageID: imageID, Mounts: defaultMounts, Status: "running", AgentSocketPath: agentSocket, AgentToken: secret, CreatedAt: createdAt, Containers: []state.Container{{Name: "default", PodmanName: name, ImageID: imageID, Mounts: defaultMounts, Status: "running", CreatedAt: createdAt, AgentSocketPath: agentSocket, AgentToken: secret, Env: userEnv, SecretEnv: userSecretEnv}}}
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

func toProto(workspace state.Workspace) *ctl.Workspace {
	result := &ctl.Workspace{WorkspaceSlug: workspace.WorkspaceSlug, ProjectName: workspace.ProjectName, ContainerName: workspace.ContainerName, ImageId: workspace.ImageID, Status: workspace.Status, AgentSocketPath: workspace.AgentSocketPath, AgentToken: workspace.AgentToken, CreatedAt: workspace.CreatedAt}
	if defaultContainer, ok := containerByLogical(&workspace, "default"); ok {
		result.Env = cloneMap(defaultContainer.Env)
		result.SecretEnv = cloneMap(defaultContainer.SecretEnv)
	}
	for _, mount := range workspace.Mounts {
		mode := ctl.MountMode_MOUNT_MODE_READ_ONLY
		if mount.Mode == "read_write" {
			mode = ctl.MountMode_MOUNT_MODE_READ_WRITE
		}
		result.Mounts = append(result.Mounts, &ctl.ProjectMount{ProjectName: mount.ProjectName, Path: mount.Path, Destination: mount.Destination, Mode: mode, Kind: mountKindToProto(mount.Kind), Volume: mount.Volume})
	}
	return result
}
