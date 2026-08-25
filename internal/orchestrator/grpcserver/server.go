package grpcserver

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/opencontainers/runtime-spec/specs-go"
	ctl "gitlab.com/Exagone313/dsh-container-plugin/internal/genproto/dshctl/v1"
	"gitlab.com/Exagone313/dsh-container-plugin/internal/orchestrator/podman"
	"gitlab.com/Exagone313/dsh-container-plugin/internal/orchestrator/projects"
	"gitlab.com/Exagone313/dsh-container-plugin/internal/orchestrator/state"
	"gitlab.com/Exagone313/dsh-container-plugin/internal/orchestrator/token"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

type Server struct {
	ctl.UnimplementedOrchestratorControlServer
	ProjectsRoot string
	Store        *state.Store
	Podman       *podman.Client
}

func (s *Server) ListProjects(context.Context, *ctl.ListProjectsRequest) (*ctl.ListProjectsResponse, error) {
	found, err := projects.List(s.ProjectsRoot)
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	result := &ctl.ListProjectsResponse{}
	for _, project := range found {
		result.Projects = append(result.Projects, &ctl.Project{Name: project.Name, HostPath: project.HostPath})
	}
	return result, nil
}
func (s *Server) DescribeWorkspace(_ context.Context, request *ctl.DescribeWorkspaceRequest) (*ctl.Workspace, error) {
	workspaces, err := s.Store.Workspaces()
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	for _, workspace := range workspaces {
		if workspace.WorkspaceSlug == request.GetWorkspaceSlug() {
			return toProto(workspace), nil
		}
	}
	return nil, status.Error(codes.NotFound, "workspace not found")
}
func (s *Server) ListWorkspaces(context.Context, *ctl.ListWorkspacesRequest) (*ctl.ListWorkspacesResponse, error) {
	workspaces, err := s.Store.Workspaces()
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	result := &ctl.ListWorkspacesResponse{}
	for _, workspace := range workspaces {
		result.Workspaces = append(result.Workspaces, toProto(workspace))
	}
	return result, nil
}
func (s *Server) CreateWorkspace(_ context.Context, request *ctl.CreateWorkspaceRequest) (*ctl.Workspace, error) {
	if request.GetWorkspaceSlug() == "" || filepath.Base(request.GetWorkspaceSlug()) != request.GetWorkspaceSlug() {
		return nil, status.Error(codes.InvalidArgument, "invalid workspace slug")
	}
	images, err := s.Store.Images()
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	found := false
	for _, image := range images {
		if image.ImageID == request.GetImageId() && image.ImageTag != "" {
			found = true
		}
	}
	if !found {
		return nil, status.Error(codes.NotFound, "built image not found")
	}
	secret, err := token.New()
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	mounts := make([]state.Mount, 0, len(request.GetMounts()))
	podmanMounts := make([]specs.Mount, 0, len(request.GetMounts()))
	for _, mount := range request.GetMounts() {
		path, pathErr := ValidateProject(s.ProjectsRoot, mount.GetProjectName())
		if pathErr != nil {
			return nil, status.Error(codes.InvalidArgument, pathErr.Error())
		}
		mode := "read_only"
		options := []string{"ro"}
		if mount.GetMode() == ctl.MountMode_MOUNT_MODE_READ_WRITE {
			mode, options = "read_write", []string{"rw"}
		}
		mounts = append(mounts, state.Mount{ProjectName: mount.GetProjectName(), Mode: mode})
		podmanMounts = append(podmanMounts, specs.Mount{Type: "bind", Source: path, Destination: filepath.Join("/workspace", mount.GetProjectName()), Options: options})
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
		return nil, status.Error(codes.Internal, err.Error())
	}
	workspace := state.Workspace{WorkspaceSlug: request.GetWorkspaceSlug(), ContainerName: name, ImageID: request.GetImageId(), Mounts: mounts, Status: "running", AgentSocketPath: "/run/dsh-sockets/agent.sock", AgentToken: secret, CreatedAt: time.Now().UTC().Format(time.RFC3339)}
	all, _ := s.Store.Workspaces()
	all = append(all, workspace)
	if err := s.Store.SaveWorkspaces(all); err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	return toProto(workspace), nil
}
func (s *Server) StopWorkspace(_ context.Context, request *ctl.StopWorkspaceRequest) (*ctl.StopWorkspaceResponse, error) {
	workspace, err := s.DescribeWorkspace(context.Background(), &ctl.DescribeWorkspaceRequest{WorkspaceSlug: request.GetWorkspaceSlug()})
	if err != nil {
		return nil, err
	}
	if s.Podman == nil {
		return nil, status.Error(codes.FailedPrecondition, "podman is not configured")
	}
	if err := s.Podman.Stop(workspace.GetContainerName()); err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
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
		return "", fmt.Errorf("project does not exist")
	}
	return filepath.Abs(path)
}
