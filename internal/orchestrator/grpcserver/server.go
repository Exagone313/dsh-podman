package grpcserver

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"time"

	"github.com/opencontainers/runtime-spec/specs-go"
	ctl "gitlab.com/Exagone313/dsh-container-plugin/internal/genproto/dshctl/v1"
	imagebuild "gitlab.com/Exagone313/dsh-container-plugin/internal/orchestrator/images"
	"gitlab.com/Exagone313/dsh-container-plugin/internal/orchestrator/podman"
	"gitlab.com/Exagone313/dsh-container-plugin/internal/orchestrator/projects"
	"gitlab.com/Exagone313/dsh-container-plugin/internal/orchestrator/state"
	"gitlab.com/Exagone313/dsh-container-plugin/internal/orchestrator/token"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type Server struct {
	ctl.UnimplementedOrchestratorControlServer
	ProjectsRoot     string
	HostProjectsRoot string
	SocketsRoot      string
	Store            *state.Store
	Podman           *podman.Client
	ImageBuilder     *imagebuild.Builder
	Logger           *slog.Logger
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
func (s *Server) CreateWorkspace(ctx context.Context, request *ctl.CreateWorkspaceRequest) (*ctl.Workspace, error) {
	s.log().Info("control request", "method", "CreateWorkspace", "workspace_slug", request.GetWorkspaceSlug(), "image_id", request.GetImageId(), "mount_count", len(request.GetMounts()))
	if request.GetWorkspaceSlug() == "" || filepath.Base(request.GetWorkspaceSlug()) != request.GetWorkspaceSlug() {
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
		if s.ImageBuilder == nil {
			s.log().Error("CreateWorkspace cannot auto-provision default image", "image_id", request.GetImageId(), "reason", "podman image builder is not configured")
			return nil, status.Error(codes.FailedPrecondition, "podman image builder is not configured")
		}
		image := state.Image{ImageID: request.GetImageId(), BaseImage: "docker.io/library/archlinux:latest", Packages: append([]string(nil), defaultPackages...)}
		image.ImageTag, err = s.ImageBuilder.Build(image)
		if err != nil {
			return nil, status.Error(codes.Internal, fmt.Sprintf("build default image: %v", err))
		}
		images = append(images, image)
		s.log().Info("CreateWorkspace auto-provisioned image", "image_id", image.ImageID, "image_tag", image.ImageTag)
		if err := s.Store.SaveImages(images); err != nil {
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
			hostPath, pathErr = ValidateProject(s.HostProjectsRoot, mount.GetProjectName())
			if pathErr != nil {
				s.log().Error("CreateWorkspace host project validation failed", "project_name", mount.GetProjectName(), "root", s.HostProjectsRoot, "error", pathErr)
				return nil, status.Error(codes.InvalidArgument, pathErr.Error())
			}
		}
		podmanMounts = append(podmanMounts, specs.Mount{Type: "bind", Source: hostPath, Destination: filepath.Join(s.ProjectsRoot, mount.GetProjectName()), Options: options})
	}
	if s.Podman == nil {
		return nil, status.Error(codes.FailedPrecondition, "podman is not configured")
	}
	name := "dsh-workspace-" + request.GetWorkspaceSlug()
	imageTag := ""
	for _, image := range images {
		if image.ImageID == request.GetImageId() {
			imageTag = image.ImageTag
		}
	}
	if err := s.Podman.CreateWorkspace(name, imageTag, secret, podmanMounts); err != nil {
		s.log().Error("control request failed", "method", "CreateWorkspace", "workspace_slug", request.GetWorkspaceSlug(), "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	agentSocket := filepath.Join(s.SocketsRoot, name, "agent.sock")
	workspace := state.Workspace{WorkspaceSlug: request.GetWorkspaceSlug(), ContainerName: name, ImageID: request.GetImageId(), Mounts: mounts, Status: "running", AgentSocketPath: agentSocket, AgentToken: secret, CreatedAt: time.Now().UTC().Format(time.RFC3339)}
	all, _ := s.Store.Workspaces()
	all = append(all, workspace)
	if err := s.Store.SaveWorkspaces(all); err != nil {
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
	all, err := s.Store.Images()
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
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
	if err := s.Store.SaveImages(all); err != nil {
		s.log().Error("control request failed", "method", "RebuildImage", "image_id", image.ImageID, "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	s.log().Info("control request completed", "method", "RebuildImage", "image_id", image.ImageID, "image_tag", image.ImageTag)
	return &ctl.Image{ImageId: image.ImageID, BaseImage: image.BaseImage, Packages: image.Packages, ImageTag: image.ImageTag, BuiltAt: image.BuiltAt}, nil
}
func defaultImageID() string {
	if value := os.Getenv("DSH_ORCH_DEFAULT_IMAGE"); value != "" {
		return value
	}
	return "arch-base"
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
	if name == "" || filepath.Base(name) != name {
		return "", fmt.Errorf("invalid project name")
	}
	path := filepath.Join(root, name)
	info, err := os.Stat(path)
	if err != nil || !info.IsDir() {
		return "", fmt.Errorf("project %q does not exist under %q", name, root)
	}
	return filepath.Abs(path)
}
