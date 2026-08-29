// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	entities "github.com/containers/podman/v5/pkg/domain/entities/types"
	"github.com/opencontainers/runtime-spec/specs-go"
	ctl "gitlab.com/Exagone313/dsh-podman/internal/genproto/dshctl/v1"
	imagebuild "gitlab.com/Exagone313/dsh-podman/internal/orchestrator/images"
	"gitlab.com/Exagone313/dsh-podman/internal/orchestrator/podman"
	"gitlab.com/Exagone313/dsh-podman/internal/orchestrator/projects"
	"gitlab.com/Exagone313/dsh-podman/internal/orchestrator/state"
	"gitlab.com/Exagone313/dsh-podman/internal/orchestrator/token"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// workspaceSlugName restricts workspace slugs to characters podman accepts in
// a container name; the container name is derived from the slug, so this is
// the boundary against a client injecting arbitrary container names.
var workspaceSlugName = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$`)

// containerNamePattern is the exact shape of orchestrator-created guest
// containers (dsh-workspace-<slug>); any workspace state that does not match
// it is treated as invalid rather than acted upon.
var containerNamePattern = regexp.MustCompile(`^dsh-workspace-[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$`)

func validWorkspaceSlug(slug string) bool {
	return slug != "." && slug != ".." && workspaceSlugName.MatchString(slug)
}

type Server struct {
	ctl.UnimplementedOrchestratorControlServer
	ProjectsRoot      string
	HostProjectsRoot  string
	SocketsRoot       string
	Store             *state.Store
	Podman            *podman.Client
	ImageBuilder      *imagebuild.Builder
	BuildDefaultImage bool
	Logger            *slog.Logger
}

var defaultPackages = []string{"base-devel", "git", "python", "curl", "wget", "openssh", "ca-certificates", "ripgrep", "fd", "jq", "unzip", "zstd", "less", "procps-ng", "diffutils", "patch", "tree"}

func (s *Server) log() *slog.Logger {
	if s.Logger != nil {
		return s.Logger
	}
	return slog.Default()
}

func UnaryLogger(logger *slog.Logger) grpc.UnaryServerInterceptor {
	if logger == nil {
		logger = slog.Default()
	}
	return func(ctx context.Context, request any, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (any, error) {
		logger.Info("gRPC request", "method", info.FullMethod, "request_type", fmt.Sprintf("%T", request))
		response, err := handler(ctx, request)
		if err != nil {
			logger.Error("gRPC request failed", "method", info.FullMethod, "error", err)
			return response, err
		}
		logger.Info("gRPC request completed", "method", info.FullMethod)
		return response, nil
	}
}

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
				return nil, status.Error(codes.NotFound, "workspace not found")
			}
			if s.Podman != nil {
				exists, containerErr := s.Podman.ContainerExists(workspace.ContainerName)
				if containerErr != nil {
					return nil, status.Error(codes.Internal, containerErr.Error())
				}
				if !exists {
					s.log().Warn("DescribeWorkspace found stale state", "workspace_slug", workspace.WorkspaceSlug, "container_name", workspace.ContainerName)
					return nil, status.Error(codes.NotFound, "guest container not found")
				}
			}
			s.log().Info("control request completed", "method", "DescribeWorkspace", "workspace_slug", workspace.WorkspaceSlug, "status", workspace.Status)
			return toProto(workspace), nil
		}
	}
	s.log().Warn("control request failed", "method", "DescribeWorkspace", "workspace_slug", request.GetWorkspaceSlug(), "reason", "not found")
	return nil, status.Error(codes.NotFound, "workspace not found")
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
func (s *Server) ListImages(context.Context, *ctl.ListImagesRequest) (*ctl.ListImagesResponse, error) {
	s.log().Info("control request", "method", "ListImages")
	images, err := s.Store.Images()
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	result := &ctl.ListImagesResponse{}
	for _, image := range images {
		result.Images = append(result.Images, &ctl.Image{ImageId: image.ImageID, BaseImage: image.BaseImage, Packages: image.Packages, ImageTag: image.ImageTag, BuiltAt: image.BuiltAt})
	}
	s.log().Info("control request completed", "method", "ListImages", "count", len(result.Images))
	return result, nil
}
func (s *Server) RecreateWorkspace(context.Context, *ctl.RecreateWorkspaceRequest) (*ctl.Workspace, error) {
	s.log().Warn("control request failed", "method", "RecreateWorkspace", "reason", "not implemented")
	return nil, status.Error(codes.Unimplemented, "workspace recreation is not configured")
}
func (s *Server) ListContainers(context.Context, *ctl.ListContainersRequest) (*ctl.ListContainersResponse, error) {
	s.log().Info("control request", "method", "ListContainers")
	if s.Podman == nil {
		return nil, status.Error(codes.FailedPrecondition, "podman is not configured")
	}
	listed, err := s.Podman.List()
	if err != nil {
		s.log().Error("control request failed", "method", "ListContainers", "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	workspaces, err := s.Store.Workspaces()
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	byName := make(map[string]state.Workspace, len(workspaces))
	for _, workspace := range workspaces {
		byName[workspace.ContainerName] = workspace
	}
	result := &ctl.ListContainersResponse{Containers: workspaceContainerRows(listed, byName)}
	s.log().Info("control request completed", "method", "ListContainers", "count", len(result.Containers))
	return result, nil
}

// workspaceContainerRows projects the podman container list onto the guest
// containers the orchestrator owns. A container whose name does not match a
// stored workspace — i.e. one the orchestrator did not create — is skipped, so
// the plugin can only manage dsh workspaces.
func workspaceContainerRows(listed []entities.ListContainer, byName map[string]state.Workspace) []*ctl.Container {
	result := make([]*ctl.Container, 0, len(listed))
	for _, container := range listed {
		name := ""
		for _, candidate := range container.Names {
			name = strings.TrimPrefix(candidate, "/")
			break
		}
		workspace, ok := byName[name]
		if !ok {
			continue
		}
		createdAt := container.CreatedAt
		if !container.Created.IsZero() {
			createdAt = container.Created.UTC().Format(time.RFC3339)
		}
		row := &ctl.Container{ContainerName: name, Status: container.State, CreatedAt: createdAt, WorkspaceSlug: workspace.WorkspaceSlug, ImageId: workspace.ImageID}
		for _, mount := range workspace.Mounts {
			mode := ctl.MountMode_MOUNT_MODE_READ_ONLY
			if mount.Mode == "read_write" {
				mode = ctl.MountMode_MOUNT_MODE_READ_WRITE
			}
			row.Mounts = append(row.Mounts, &ctl.ProjectMount{ProjectName: mount.ProjectName, Mode: mode})
		}
		result = append(result, row)
	}
	return result
}
func (s *Server) RecreateContainer(ctx context.Context, request *ctl.RecreateContainerRequest) (*ctl.Workspace, error) {
	s.log().Info("control request", "method", "RecreateContainer", "workspace_slug", request.GetWorkspaceSlug(), "image_id", request.GetImageId())
	workspace, err := s.DescribeWorkspace(ctx, &ctl.DescribeWorkspaceRequest{WorkspaceSlug: request.GetWorkspaceSlug()})
	if err != nil {
		return nil, err
	}
	if s.Podman == nil {
		return nil, status.Error(codes.FailedPrecondition, "podman is not configured")
	}
	imageID := request.GetImageId()
	if imageID == "" {
		imageID = workspace.GetImageId()
	}
	images, err := s.Store.Images()
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	imageTag := ""
	for _, image := range images {
		if image.ImageID == imageID {
			imageTag = image.ImageTag
			break
		}
	}
	if imageTag == "" {
		s.log().Error("control request failed", "method", "RecreateContainer", "workspace_slug", request.GetWorkspaceSlug(), "reason", "built image not found", "image_id", imageID)
		return nil, status.Error(codes.NotFound, "built image not found")
	}
	exists, imageErr := s.Podman.ImageExists(imageTag)
	if imageErr != nil {
		return nil, status.Error(codes.Internal, imageErr.Error())
	}
	if !exists {
		s.log().Error("control request failed", "method", "RecreateContainer", "workspace_slug", request.GetWorkspaceSlug(), "reason", "built image tag is missing", "image_tag", imageTag)
		return nil, status.Error(codes.NotFound, "built image tag is missing")
	}
	podmanMounts := make([]specs.Mount, 0, len(workspace.GetMounts()))
	for _, mount := range workspace.GetMounts() {
		path, pathErr := ValidateProject(s.ProjectsRoot, mount.GetProjectName())
		if pathErr != nil {
			s.log().Error("RecreateContainer project validation failed", "project_name", mount.GetProjectName(), "error", pathErr)
			return nil, status.Error(codes.InvalidArgument, pathErr.Error())
		}
		hostPath := path
		if s.HostProjectsRoot != "" {
			hostPath = filepath.Join(s.HostProjectsRoot, filepath.FromSlash(mount.GetProjectName()))
		}
		options := []string{"ro"}
		if mount.GetMode() == ctl.MountMode_MOUNT_MODE_READ_WRITE {
			options = []string{"rw"}
		}
		podmanMounts = append(podmanMounts, specs.Mount{Type: "bind", Source: hostPath, Destination: filepath.Join(s.ProjectsRoot, mount.GetProjectName()), Options: options})
	}
	secret, err := token.New()
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	if err := s.Podman.RecreateWorkspace(workspace.GetContainerName(), imageTag, secret, podmanMounts); err != nil {
		s.log().Error("control request failed", "method", "RecreateContainer", "workspace_slug", request.GetWorkspaceSlug(), "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	updated := state.Workspace{WorkspaceSlug: workspace.GetWorkspaceSlug(), ContainerName: workspace.GetContainerName(), ImageID: imageID, Status: "running", AgentSocketPath: workspace.GetAgentSocketPath(), AgentToken: secret, CreatedAt: workspace.GetCreatedAt()}
	for _, mount := range workspace.GetMounts() {
		mode := "read_only"
		if mount.GetMode() == ctl.MountMode_MOUNT_MODE_READ_WRITE {
			mode = "read_write"
		}
		updated.Mounts = append(updated.Mounts, state.Mount{ProjectName: mount.GetProjectName(), Mode: mode})
	}
	if err := s.Store.UpdateWorkspaces(func(all []state.Workspace) ([]state.Workspace, error) {
		for i := range all {
			if all[i].WorkspaceSlug == updated.WorkspaceSlug {
				all[i] = updated
				return all, nil
			}
		}
		return append(all, updated), nil
	}); err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	s.log().Info("control request completed", "method", "RecreateContainer", "workspace_slug", request.GetWorkspaceSlug(), "image_id", imageID)
	return toProto(updated), nil
}

func (s *Server) CreateWorkspace(ctx context.Context, request *ctl.CreateWorkspaceRequest) (*ctl.Workspace, error) {
	s.log().Info("control request", "method", "CreateWorkspace", "workspace_slug", request.GetWorkspaceSlug(), "image_id", request.GetImageId(), "mount_count", len(request.GetMounts()))
	if !validWorkspaceSlug(request.GetWorkspaceSlug()) {
		return nil, status.Error(codes.InvalidArgument, "invalid workspace slug")
	}
	images, err := s.Store.Images()
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	found := false
	imageIndex := -1
	for i, image := range images {
		if image.ImageID == request.GetImageId() {
			imageIndex = i
		}
		if image.ImageID == request.GetImageId() && image.ImageTag != "" {
			found = true
		}
	}
	if !found {
		s.log().Info("CreateWorkspace image lookup", "image_id", request.GetImageId(), "found", false, "default_image", request.GetImageId() == defaultImageID())
		if request.GetImageId() != defaultImageID() || imageIndex >= 0 {
			return nil, status.Error(codes.NotFound, "built image not found")
		}
		if !s.BuildDefaultImage {
			s.log().Error("CreateWorkspace cannot auto-provision default image", "image_id", request.GetImageId(), "reason", "DSH_PODMAN_BUILD_DEFAULT_IMAGE is disabled")
			return nil, status.Error(codes.NotFound, "built image not found; default image auto-build is disabled")
		}
		if s.ImageBuilder == nil {
			s.log().Error("CreateWorkspace cannot auto-provision default image", "image_id", request.GetImageId(), "reason", "podman image builder is not configured")
			return nil, status.Error(codes.FailedPrecondition, "podman image builder is not configured")
		}
		image := state.Image{ImageID: request.GetImageId(), BaseImage: "docker.io/library/archlinux:latest", Packages: append([]string(nil), defaultPackages...)}
		image.ImageTag, err = s.ImageBuilder.Build(image)
		if err != nil {
			return nil, status.Error(codes.Internal, fmt.Sprintf("build default image: %v", err))
		}
		image.BuiltAt = time.Now().UTC().Format(time.RFC3339)
		images = append(images, image)
		imageIndex = len(images) - 1
		s.log().Info("CreateWorkspace auto-provisioned image", "image_id", image.ImageID, "image_tag", image.ImageTag)
		if err := s.Store.UpdateImages(func(current []state.Image) ([]state.Image, error) {
			for i := range current {
				if current[i].ImageID == image.ImageID {
					current[i] = image
					return current, nil
				}
			}
			return append(current, image), nil
		}); err != nil {
			return nil, status.Error(codes.Internal, err.Error())
		}
		found = true
	}
	secret, err := token.New()
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	mounts := make([]state.Mount, 0, len(request.GetMounts()))
	podmanMounts := make([]specs.Mount, 0, len(request.GetMounts()))
	for _, mount := range request.GetMounts() {
		s.log().Info("CreateWorkspace validating project mount", "project_name", mount.GetProjectName(), "container_projects_root", s.ProjectsRoot, "host_projects_root", s.HostProjectsRoot)
		path, pathErr := ValidateProject(s.ProjectsRoot, mount.GetProjectName())
		if pathErr != nil {
			s.log().Error("CreateWorkspace project validation failed", "project_name", mount.GetProjectName(), "root", s.ProjectsRoot, "error", pathErr)
			return nil, status.Error(codes.InvalidArgument, pathErr.Error())
		}
		mode := "read_only"
		options := []string{"ro"}
		if mount.GetMode() == ctl.MountMode_MOUNT_MODE_READ_WRITE {
			mode, options = "read_write", []string{"rw"}
		}
		mounts = append(mounts, state.Mount{ProjectName: mount.GetProjectName(), Mode: mode})
		hostPath := path
		if s.HostProjectsRoot != "" {
			hostPath = filepath.Join(s.HostProjectsRoot, filepath.FromSlash(mount.GetProjectName()))
		}
		podmanMounts = append(podmanMounts, specs.Mount{Type: "bind", Source: hostPath, Destination: filepath.Join(s.ProjectsRoot, mount.GetProjectName()), Options: options})
	}
	if s.Podman == nil {
		return nil, status.Error(codes.FailedPrecondition, "podman is not configured")
	}
	imageTag := images[imageIndex].ImageTag
	exists, imageErr := s.Podman.ImageExists(imageTag)
	if imageErr != nil {
		return nil, status.Error(codes.Internal, imageErr.Error())
	}
	if !exists {
		s.log().Warn("CreateWorkspace image state is stale", "image_id", request.GetImageId(), "image_tag", imageTag)
		if request.GetImageId() != defaultImageID() || !s.BuildDefaultImage || s.ImageBuilder == nil {
			return nil, status.Error(codes.NotFound, "built image not found")
		}
		image := images[imageIndex]
		image.ImageTag, err = s.ImageBuilder.Build(image)
		if err != nil {
			return nil, status.Error(codes.Internal, fmt.Sprintf("rebuild default image: %v", err))
		}
		image.BuiltAt = time.Now().UTC().Format(time.RFC3339)
		images[imageIndex] = image
		if err := s.Store.UpdateImages(func(current []state.Image) ([]state.Image, error) {
			for i := range current {
				if current[i].ImageID == image.ImageID {
					current[i] = image
					return current, nil
				}
			}
			return append(current, image), nil
		}); err != nil {
			return nil, status.Error(codes.Internal, err.Error())
		}
		imageTag = image.ImageTag
		s.log().Info("CreateWorkspace rebuilt stale default image", "image_id", image.ImageID, "image_tag", image.ImageTag)
	}
	name := "dsh-workspace-" + request.GetWorkspaceSlug()
	if err := s.Podman.CreateWorkspace(name, imageTag, secret, podmanMounts); err != nil {
		s.log().Error("control request failed", "method", "CreateWorkspace", "workspace_slug", request.GetWorkspaceSlug(), "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	agentSocket := filepath.Join(s.SocketsRoot, name, "guest.sock")
	workspace := state.Workspace{WorkspaceSlug: request.GetWorkspaceSlug(), ContainerName: name, ImageID: request.GetImageId(), Mounts: mounts, Status: "running", AgentSocketPath: agentSocket, AgentToken: secret, CreatedAt: time.Now().UTC().Format(time.RFC3339)}
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

func (s *Server) RebuildImage(ctx context.Context, request *ctl.RebuildImageRequest) (*ctl.Image, error) {
	s.log().Info("control request", "method", "RebuildImage", "image_id", request.GetImageId(), "base_image", request.GetBaseImage(), "package_count", len(request.GetPackages()))
	if s.ImageBuilder == nil {
		return nil, status.Error(codes.FailedPrecondition, "image builder is not configured")
	}
	base := request.GetBaseImage()
	if base == "" {
		base = "docker.io/library/archlinux:latest"
	}
	packages := append([]string(nil), request.GetPackages()...)
	if len(packages) == 0 && request.GetImageId() == defaultImageID() {
		packages = append([]string(nil), defaultPackages...)
		s.log().Info("RebuildImage using default package set", "image_id", request.GetImageId(), "package_count", len(packages))
	}
	image := state.Image{ImageID: request.GetImageId(), BaseImage: base, Packages: packages}
	tag, err := s.ImageBuilder.Build(image)
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	image.ImageTag, image.BuiltAt = tag, time.Now().UTC().Format(time.RFC3339)
	if err := s.Store.UpdateImages(func(all []state.Image) ([]state.Image, error) {
		replaced := false
		for i := range all {
			if all[i].ImageID == image.ImageID {
				all[i] = image
				replaced = true
			}
		}
		if !replaced {
			all = append(all, image)
		}
		return all, nil
	}); err != nil {
		s.log().Error("control request failed", "method", "RebuildImage", "image_id", image.ImageID, "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	s.log().Info("control request completed", "method", "RebuildImage", "image_id", image.ImageID, "image_tag", image.ImageTag)
	return &ctl.Image{ImageId: image.ImageID, BaseImage: image.BaseImage, Packages: image.Packages, ImageTag: image.ImageTag, BuiltAt: image.BuiltAt}, nil
}
func defaultImageID() string {
	if value := os.Getenv("DSH_PODMAN_DEFAULT_IMAGE"); value != "" {
		return value
	}
	return imagePrefix() + "arch-base"
}
func imagePrefix() string {
	prefix := os.Getenv("DSH_PODMAN_IMAGE_PREFIX")
	if prefix == "" {
		return "localhost/dsh-podman/"
	}
	if !strings.HasSuffix(prefix, "/") {
		prefix += "/"
	}
	return prefix
}
func (s *Server) StopWorkspace(_ context.Context, request *ctl.StopWorkspaceRequest) (*ctl.StopWorkspaceResponse, error) {
	s.log().Info("control request", "method", "StopWorkspace", "workspace_slug", request.GetWorkspaceSlug())
	workspace, err := s.DescribeWorkspace(context.Background(), &ctl.DescribeWorkspaceRequest{WorkspaceSlug: request.GetWorkspaceSlug()})
	if err != nil {
		return nil, err
	}
	if s.Podman == nil {
		return nil, status.Error(codes.FailedPrecondition, "podman is not configured")
	}
	if err := s.Podman.Stop(workspace.GetContainerName()); err != nil {
		s.log().Error("control request failed", "method", "StopWorkspace", "workspace_slug", request.GetWorkspaceSlug(), "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	s.log().Info("control request completed", "method", "StopWorkspace", "workspace_slug", request.GetWorkspaceSlug())
	return &ctl.StopWorkspaceResponse{}, nil
}
func (s *Server) RemoveContainer(_ context.Context, request *ctl.RemoveContainerRequest) (*ctl.RemoveContainerResponse, error) {
	s.log().Info("control request", "method", "RemoveContainer", "workspace_slug", request.GetWorkspaceSlug())
	workspace, err := s.DescribeWorkspace(context.Background(), &ctl.DescribeWorkspaceRequest{WorkspaceSlug: request.GetWorkspaceSlug()})
	if err != nil {
		return nil, err
	}
	if s.Podman == nil {
		return nil, status.Error(codes.FailedPrecondition, "podman is not configured")
	}
	if err := s.Podman.Remove(workspace.GetContainerName()); err != nil {
		s.log().Error("control request failed", "method", "RemoveContainer", "workspace_slug", request.GetWorkspaceSlug(), "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	s.log().Info("control request completed", "method", "RemoveContainer", "workspace_slug", request.GetWorkspaceSlug())
	return &ctl.RemoveContainerResponse{}, nil
}
func toProto(workspace state.Workspace) *ctl.Workspace {
	result := &ctl.Workspace{WorkspaceSlug: workspace.WorkspaceSlug, ContainerName: workspace.ContainerName, ImageId: workspace.ImageID, Status: workspace.Status, AgentSocketPath: workspace.AgentSocketPath, AgentToken: workspace.AgentToken, CreatedAt: workspace.CreatedAt}
	for _, mount := range workspace.Mounts {
		mode := ctl.MountMode_MOUNT_MODE_READ_ONLY
		if mount.Mode == "read_write" {
			mode = ctl.MountMode_MOUNT_MODE_READ_WRITE
		}
		result.Mounts = append(result.Mounts, &ctl.ProjectMount{ProjectName: mount.ProjectName, Mode: mode})
	}
	return result
}
func ValidateProject(root, name string) (string, error) {
	clean := filepath.Clean(filepath.FromSlash(name))
	if name == "" || filepath.IsAbs(name) || strings.ContainsRune(name, '\x00') || clean != filepath.FromSlash(name) || clean == "." || clean == ".." || strings.HasPrefix(clean, ".."+string(filepath.Separator)) {
		return "", fmt.Errorf("invalid project name")
	}
	path := filepath.Join(root, name)
	info, err := os.Stat(path)
	if err != nil || !info.IsDir() {
		return "", fmt.Errorf("project %q does not exist under %q", name, root)
	}
	return filepath.Abs(path)
}
