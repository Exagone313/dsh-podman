// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/opencontainers/runtime-spec/specs-go"
	ctl "gitlab.com/Exagone313/dsh-podman/internal/genproto/dshctl/v1"
	guest "gitlab.com/Exagone313/dsh-podman/internal/genproto/dshguest/v1"
	imagebuild "gitlab.com/Exagone313/dsh-podman/internal/orchestrator/images"
	"gitlab.com/Exagone313/dsh-podman/internal/orchestrator/podman"
	"gitlab.com/Exagone313/dsh-podman/internal/orchestrator/projects"
	"gitlab.com/Exagone313/dsh-podman/internal/orchestrator/state"
	"gitlab.com/Exagone313/dsh-podman/internal/orchestrator/token"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

// workspaceSlugName restricts workspace slugs to characters podman accepts in
// a container name; the container name is derived from the slug, so this is
// the boundary against a client injecting arbitrary container names.
var workspaceSlugName = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$`)

// containerLogicalName restricts the logical names clients may assign to
// named guest containers (e.g. "dev", "web", "api-2").
var containerLogicalName = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,30}$`)

// containerPodmanName is the exact shape of orchestrator-created guest
// containers (dsh-workspace-<slug> or dsh-workspace-<slug>-<name>); any
// workspace state that does not match it is treated as invalid rather than
// acted upon.
var containerPodmanName = regexp.MustCompile(`^dsh-workspace-[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}(?:-[a-z0-9][a-z0-9-]{0,30})?$`)

// containerNamePattern is the exact shape of orchestrator-created guest
// containers; see containerPodmanName.
var containerNamePattern = containerPodmanName

// volumeName restricts short named-volume names to the shape podman accepts
// when the orchestrator prefixes them; the full podman name is never exposed
// to clients.
var volumeName = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$`)

func validWorkspaceSlug(slug string) bool {
	return slug != "." && slug != ".." && workspaceSlugName.MatchString(slug)
}

// validContainerName reports whether name is a usable logical container name:
// non-empty, not reserved for the default container, and matching the logical
// name shape.
func validContainerName(name string) bool {
	return name != "" && name != "default" && containerLogicalName.MatchString(name)
}

// podmanContainerName derives the podman container name for a workspace's
// logical container. The "default"/"" logical name maps to the workspace's
// default container (dsh-workspace-<slug>); named containers are suffixed.
func podmanContainerName(slug, logical string) string {
	if logical == "" || logical == "default" {
		return "dsh-workspace-" + slug
	}
	return "dsh-workspace-" + slug + "-" + logical
}

// podNameFor derives the podman pod name for a workspace. All containers of a
// workspace live in this pod, sharing its network namespace.
func podNameFor(slug string) string {
	return "dsh-pod-" + slug
}

// containerByLogical returns the container record for the given logical name.
// An empty name or "default" resolves to the workspace's default container.
func containerByLogical(ws *state.Workspace, name string) (*state.Container, bool) {
	if name == "" || name == "default" {
		for i := range ws.Containers {
			if ws.Containers[i].Name == "default" {
				return &ws.Containers[i], true
			}
		}
		if len(ws.Containers) > 0 {
			return &ws.Containers[0], true
		}
		return nil, false
	}
	for i := range ws.Containers {
		if ws.Containers[i].Name == name {
			return &ws.Containers[i], true
		}
	}
	return nil, false
}

// workspaceBySlug returns the stored workspace with the given slug, or an
// error whose message is "workspace not found" when absent.
func workspaceBySlug(store *state.Store, slug string) (state.Workspace, error) {
	workspaces, err := store.Workspaces()
	if err != nil {
		return state.Workspace{}, err
	}
	for _, workspace := range workspaces {
		if workspace.WorkspaceSlug == slug {
			return workspace, nil
		}
	}
	return state.Workspace{}, errors.New("workspace not found")
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
	VolumePrefix      string
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
func (s *Server) ListContainers(context.Context, *ctl.ListContainersRequest) (*ctl.ListContainersResponse, error) {
	s.log().Info("control request", "method", "ListContainers")
	workspaces, err := s.Store.Workspaces()
	if err != nil {
		s.log().Error("control request failed", "method", "ListContainers", "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	var exists func(podmanName string) bool
	if s.Podman != nil {
		exists = func(podmanName string) bool {
			found, containerErr := s.Podman.ContainerExists(podmanName)
			if containerErr != nil {
				s.log().Warn("ListContainers podman lookup failed", "podman_name", podmanName, "error", containerErr)
				return false
			}
			return found
		}
	}
	containers := containerRows(workspaces, exists)
	sort.Slice(containers, func(i, j int) bool {
		if containers[i].WorkspaceSlug != containers[j].WorkspaceSlug {
			return containers[i].WorkspaceSlug < containers[j].WorkspaceSlug
		}
		return containers[i].ContainerName < containers[j].ContainerName
	})
	result := &ctl.ListContainersResponse{Containers: containers}
	s.log().Info("control request completed", "method", "ListContainers", "count", len(result.Containers))
	return result, nil
}

// containerProto projects a container record onto the control plane's
// Container message, including the container's effective project mounts
// (its own list when present, else the workspace's default mounts).
func containerProto(ws state.Workspace, c state.Container) *ctl.Container {
	row := &ctl.Container{ContainerName: c.Name, PodmanName: c.PodmanName, WorkspaceSlug: ws.WorkspaceSlug, ImageId: c.ImageID, Status: c.Status, CreatedAt: c.CreatedAt, AgentSocketPath: c.AgentSocketPath, AgentToken: c.AgentToken, Env: cloneMap(c.Env)}
	for _, mount := range containerMounts(ws, c) {
		mode := ctl.MountMode_MOUNT_MODE_READ_ONLY
		if mount.Mode == "read_write" {
			mode = ctl.MountMode_MOUNT_MODE_READ_WRITE
		}
		row.Mounts = append(row.Mounts, &ctl.ProjectMount{ProjectName: mount.ProjectName, Path: mount.Path, Destination: mount.Destination, Mode: mode, Kind: mountKindToProto(mount.Kind), Volume: mount.Volume})
	}
	return row
}

// containerRows projects stored workspace containers onto the control plane's
// Container messages. It is state-driven: every workspace container is
// included. When exists is non-nil and reports the podman container as
// missing, the row is flagged as "not started".
func containerRows(workspaces []state.Workspace, exists func(podmanName string) bool) []*ctl.Container {
	result := make([]*ctl.Container, 0, len(workspaces))
	for _, ws := range workspaces {
		for _, container := range ws.Containers {
			row := containerProto(ws, container)
			if exists != nil && !exists(container.PodmanName) {
				row.Status = "not started"
			}
			result = append(result, row)
		}
	}
	return result
}

// stopContainerDaemons gracefully stops every daemon in the guest container by
// talking to its guest agent over its unix socket. It is best-effort: an
// unreachable agent (container already gone/stopped) or a failed call is
// logged and does not fail the caller.
func (s *Server) stopContainerDaemons(ctx context.Context, record state.Container) {
	if record.AgentSocketPath == "" || record.AgentToken == "" {
		s.log().Warn("cannot stop container daemons", "podman_name", record.PodmanName, "reason", "missing agent socket or token")
		return
	}
	conn, err := grpc.NewClient("unix://"+record.AgentSocketPath, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		s.log().Warn("daemon shutdown failed", "podman_name", record.PodmanName, "error", err)
		return
	}
	defer conn.Close()
	callCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	callCtx = metadata.AppendToOutgoingContext(callCtx, "authorization", "bearer "+record.AgentToken)
	resp, err := guest.NewWorkspaceGuestAgentClient(conn).StopAllDaemons(callCtx, &guest.StopAllDaemonsRequest{})
	if err != nil {
		s.log().Warn("daemon shutdown failed", "podman_name", record.PodmanName, "error", err)
		return
	}
	s.log().Info("daemons stopped", "podman_name", record.PodmanName, "count", len(resp.GetDaemons()))
}

// recreateContainer gracefully stops the container's daemons, then recreates
// the podman container with the given image tag and a fresh token, using the
// container's effective mounts.
func (s *Server) recreateContainer(workspace state.Workspace, record *state.Container, imageTag, newToken string, env map[string]string) error {
	s.stopContainerDaemons(context.Background(), *record)
	podmanMounts, err := s.podmanMounts(containerMounts(workspace, *record))
	if err != nil {
		return err
	}
	return s.Podman.RecreateWorkspace(podNameFor(workspace.WorkspaceSlug), record.PodmanName, imageTag, newToken, podmanMounts, env)
}

// StopAllContainerDaemons gracefully stops daemons in every container, in
// parallel, honoring ctx (the caller supplies an overall deadline).
func (s *Server) StopAllContainerDaemons(ctx context.Context) {
	workspaces, err := s.Store.Workspaces()
	if err != nil {
		s.log().Warn("cannot list workspaces for daemon shutdown", "error", err)
		return
	}
	var wg sync.WaitGroup
	for _, workspace := range workspaces {
		for _, container := range workspace.Containers {
			wg.Add(1)
			go func(container state.Container) {
				defer wg.Done()
				s.stopContainerDaemons(ctx, container)
			}(container)
		}
	}
	wg.Wait()
}

func (s *Server) RecreateContainer(ctx context.Context, request *ctl.RecreateContainerRequest) (*ctl.Workspace, error) {
	s.log().Info("control request", "method", "RecreateContainer", "workspace_slug", request.GetWorkspaceSlug(), "image_id", request.GetImageId(), "container", request.GetContainer())
	container := request.GetContainer()
	if container == "" {
		container = "default"
	}
	if container != "default" && !validContainerName(container) {
		return nil, status.Error(codes.InvalidArgument, "invalid container name")
	}
	workspace, err := workspaceBySlug(s.Store, request.GetWorkspaceSlug())
	if err != nil {
		return nil, status.Error(codes.NotFound, "workspace not found")
	}
	record, ok := containerByLogical(&workspace, container)
	if !ok {
		s.log().Warn("control request failed", "method", "RecreateContainer", "workspace_slug", request.GetWorkspaceSlug(), "container", container, "reason", "container not found")
		return nil, status.Error(codes.NotFound, "container not found")
	}
	if err := validateEnv(request.GetEnv()); err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}
	if len(request.GetEnv()) > 0 {
		record.Env = cloneMap(request.GetEnv())
	}
	if len(request.GetMounts()) > 0 {
		record.Mounts = stateMounts(request.GetMounts())
	} else {
		record.Mounts = containerMounts(workspace, *record)
	}
	if _, err := s.podmanMounts(record.Mounts); err != nil {
		s.log().Error("RecreateContainer project validation failed", "workspace_slug", workspace.WorkspaceSlug, "error", err)
		return nil, err
	}
	imageID := request.GetImageId()
	if imageID == "" {
		imageID = record.ImageID
	}
	imageTag, err := s.resolveImageTag(imageID)
	if err != nil {
		return nil, err
	}
	if s.Podman == nil {
		return nil, status.Error(codes.FailedPrecondition, "podman is not configured")
	}
	secret, err := token.New()
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	if err := s.recreateContainer(workspace, record, imageTag, secret, record.Env); err != nil {
		s.log().Error("control request failed", "method", "RecreateContainer", "workspace_slug", request.GetWorkspaceSlug(), "container", container, "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	record.ImageID = imageID
	record.Status = "running"
	record.CreatedAt = time.Now().UTC().Format(time.RFC3339)
	record.AgentToken = secret
	updated, err := s.upsertContainer(workspace, *record)
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	s.log().Info("control request completed", "method", "RecreateContainer", "workspace_slug", request.GetWorkspaceSlug(), "container", container, "image_id", imageID)
	return toProto(updated), nil
}

func (s *Server) StartContainer(ctx context.Context, request *ctl.StartContainerRequest) (*ctl.Container, error) {
	s.log().Info("control request", "method", "StartContainer", "workspace_slug", request.GetWorkspaceSlug(), "container", request.GetContainer(), "image_id", request.GetImageId(), "mount_count", len(request.GetMounts()))
	if !validContainerName(request.GetContainer()) {
		return nil, status.Error(codes.InvalidArgument, "invalid container name")
	}
	workspace, err := workspaceBySlug(s.Store, request.GetWorkspaceSlug())
	if err != nil {
		return nil, status.Error(codes.NotFound, "workspace not found")
	}
	imageID := request.GetImageId()
	if imageID == "" {
		imageID = defaultImageID()
	}
	recordMounts := workspace.Mounts
	if len(request.GetMounts()) > 0 {
		recordMounts = stateMounts(request.GetMounts())
	}
	record := state.Container{Name: request.GetContainer(), PodmanName: podmanContainerName(workspace.WorkspaceSlug, request.GetContainer()), ImageID: imageID, Mounts: recordMounts}
	podmanMounts, err := s.podmanMounts(containerMounts(workspace, record))
	if err != nil {
		s.log().Error("StartContainer project validation failed", "workspace_slug", workspace.WorkspaceSlug, "error", err)
		return nil, err
	}
	if err := validateEnv(request.GetEnv()); err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}
	record.Env = cloneMap(request.GetEnv())
	imageTag, err := s.resolveImageTag(imageID)
	if err != nil {
		return nil, err
	}
	if s.Podman == nil {
		return nil, status.Error(codes.FailedPrecondition, "podman is not configured")
	}
	if existing, ok := containerByLogical(&workspace, request.GetContainer()); ok {
		s.stopContainerDaemons(context.Background(), *existing)
		if err := s.Podman.Stop(existing.PodmanName); err != nil {
			s.log().Warn("StartContainer replace stop failed", "workspace_slug", workspace.WorkspaceSlug, "container", request.GetContainer(), "error", err)
		}
		if err := s.Podman.Remove(record.PodmanName); err != nil {
			s.log().Error("control request failed", "method", "StartContainer", "workspace_slug", workspace.WorkspaceSlug, "container", request.GetContainer(), "error", err)
			return nil, status.Error(codes.Internal, err.Error())
		}
	}
	secret, err := token.New()
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	if err := s.Podman.CreateWorkspace(podNameFor(workspace.WorkspaceSlug), record.PodmanName, imageTag, secret, podmanMounts, record.Env); err != nil {
		s.log().Error("control request failed", "method", "StartContainer", "workspace_slug", request.GetWorkspaceSlug(), "container", request.GetContainer(), "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	record.Status = "running"
	record.CreatedAt = time.Now().UTC().Format(time.RFC3339)
	record.AgentSocketPath = filepath.Join(s.SocketsRoot, record.PodmanName, "guest.sock")
	record.AgentToken = secret
	updated, err := s.upsertContainer(workspace, record)
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	s.log().Info("control request completed", "method", "StartContainer", "workspace_slug", request.GetWorkspaceSlug(), "container", request.GetContainer(), "podman_name", record.PodmanName)
	return containerProto(updated, record), nil
}

// AddContainerMount adds a project, tmpfs, or named-volume mount to a
// container's mount list and recreates the podman container so the change
// takes effect.
func (s *Server) AddContainerMount(ctx context.Context, request *ctl.AddContainerMountRequest) (*ctl.Container, error) {
	s.log().Info("control request", "method", "AddContainerMount", "workspace_slug", request.GetWorkspaceSlug(), "container", request.GetContainer(), "project", request.GetProject(), "path", request.GetPath(), "kind", request.GetKind(), "volume", request.GetVolume())
	workspace, err := workspaceBySlug(s.Store, request.GetWorkspaceSlug())
	if err != nil {
		return nil, status.Error(codes.NotFound, "workspace not found")
	}
	record, ok := containerByLogical(&workspace, request.GetContainer())
	if !ok {
		s.log().Warn("control request failed", "method", "AddContainerMount", "workspace_slug", request.GetWorkspaceSlug(), "container", request.GetContainer(), "reason", "container not found")
		return nil, status.Error(codes.NotFound, "container not found")
	}
	kind, err := mountKindFromProto(request.GetKind())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "invalid mount kind")
	}
	mode, err := mountModeFromProto(request.GetMode())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "invalid mount mode")
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
			duplicate = existing.Kind == "volume" && existing.Volume == newMount.Volume
		}
		if duplicate {
			return nil, status.Error(codes.AlreadyExists, "mount already exists")
		}
	}
	record.Mounts = append(append([]state.Mount(nil), effective...), newMount)
	if _, err := s.podmanMounts(record.Mounts); err != nil {
		s.log().Error("AddContainerMount project validation failed", "workspace_slug", workspace.WorkspaceSlug, "error", err)
		return nil, err
	}
	if s.Podman == nil {
		return nil, status.Error(codes.FailedPrecondition, "podman is not configured")
	}
	imageTag, err := s.resolveImageTag(record.ImageID)
	if err != nil {
		return nil, err
	}
	secret, err := token.New()
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	if err := s.recreateContainer(workspace, record, imageTag, secret, record.Env); err != nil {
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
		return nil, status.Error(codes.NotFound, "workspace not found")
	}
	record, ok := containerByLogical(&workspace, request.GetContainer())
	if !ok {
		s.log().Warn("control request failed", "method", "RemoveContainerMount", "workspace_slug", request.GetWorkspaceSlug(), "container", request.GetContainer(), "reason", "container not found")
		return nil, status.Error(codes.NotFound, "container not found")
	}
	kind, err := mountKindFromProto(request.GetKind())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, "invalid mount kind")
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
			matched = existing.Kind == "volume" && existing.Volume == request.GetVolume()
		}
		if matched {
			index = i
			break
		}
	}
	if index < 0 {
		s.log().Warn("control request failed", "method", "RemoveContainerMount", "workspace_slug", request.GetWorkspaceSlug(), "container", request.GetContainer(), "reason", "mount not found")
		return nil, status.Error(codes.NotFound, "mount not found")
	}
	record.Mounts = append(append([]state.Mount(nil), effective[:index]...), effective[index+1:]...)
	if _, err := s.podmanMounts(record.Mounts); err != nil {
		s.log().Error("RemoveContainerMount project validation failed", "workspace_slug", workspace.WorkspaceSlug, "error", err)
		return nil, err
	}
	if s.Podman == nil {
		return nil, status.Error(codes.FailedPrecondition, "podman is not configured")
	}
	imageTag, err := s.resolveImageTag(record.ImageID)
	if err != nil {
		return nil, err
	}
	secret, err := token.New()
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	if err := s.recreateContainer(workspace, record, imageTag, secret, record.Env); err != nil {
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
		return nil, status.Error(codes.InvalidArgument, "invalid workspace slug")
	}
	resolved, err := s.resolveImage(request.GetImageId())
	if err != nil {
		s.log().Info("CreateWorkspace image lookup", "image_id", request.GetImageId(), "found", false, "error", err)
		return nil, err
	}
	secret, err := token.New()
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	mounts := stateMounts(request.GetMounts())
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
	podmanMounts, mountErr := s.podmanMounts(defaultMounts)
	if mountErr != nil {
		s.log().Error("CreateWorkspace project validation failed", "root", s.ProjectsRoot, "error", mountErr)
		return nil, mountErr
	}
	userEnv := cloneMap(request.GetEnv())
	if err := validateEnv(userEnv); err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}
	if s.Podman == nil {
		return nil, status.Error(codes.FailedPrecondition, "podman is not configured")
	}
	imageTag := resolved.ImageTag
	exists, imageErr := s.Podman.ImageExists(imageTag)
	if imageErr != nil {
		return nil, status.Error(codes.Internal, imageErr.Error())
	}
	if !exists {
		s.log().Warn("CreateWorkspace image state is stale", "image_id", request.GetImageId(), "image_tag", imageTag)
		if !isDefaultImageID(request.GetImageId()) || !s.BuildDefaultImage || s.ImageBuilder == nil {
			return nil, status.Error(codes.NotFound, "built image not found")
		}
		image := resolved
		image, err = s.buildImage(request.GetImageId(), image)
		if err != nil {
			return nil, status.Error(codes.Internal, fmt.Sprintf("rebuild default image: %v", err))
		}
		imageTag = image.ImageTag
		s.log().Info("CreateWorkspace rebuilt stale default image", "image_id", image.ImageID, "image_tag", image.ImageTag)
	}
	name := "dsh-workspace-" + request.GetWorkspaceSlug()
	if err := s.Podman.CreateWorkspace(podNameFor(request.GetWorkspaceSlug()), name, imageTag, secret, podmanMounts, userEnv); err != nil {
		s.log().Error("control request failed", "method", "CreateWorkspace", "workspace_slug", request.GetWorkspaceSlug(), "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	agentSocket := filepath.Join(s.SocketsRoot, name, "guest.sock")
	createdAt := time.Now().UTC().Format(time.RFC3339)
	workspace := state.Workspace{WorkspaceSlug: request.GetWorkspaceSlug(), ContainerName: name, ImageID: request.GetImageId(), Mounts: mounts, Status: "running", AgentSocketPath: agentSocket, AgentToken: secret, CreatedAt: createdAt, Containers: []state.Container{{Name: "default", PodmanName: name, ImageID: request.GetImageId(), Mounts: defaultMounts, Status: "running", CreatedAt: createdAt, AgentSocketPath: agentSocket, AgentToken: secret, Env: userEnv}}}
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

func (s *Server) GetImage(_ context.Context, request *ctl.GetImageRequest) (*ctl.Image, error) {
	s.log().Info("control request", "method", "GetImage", "image_id", request.GetImageId())
	resolved, err := s.resolveImage(request.GetImageId())
	if err != nil {
		s.log().Warn("control request failed", "method", "GetImage", "image_id", request.GetImageId(), "reason", "not found")
		return nil, err
	}
	s.log().Info("control request completed", "method", "GetImage", "image_id", request.GetImageId())
	return imageProto(resolved), nil
}
func (s *Server) BuildImage(_ context.Context, request *ctl.BuildImageRequest) (*ctl.Image, error) {
	s.log().Info("control request", "method", "BuildImage", "image_id", request.GetImageId(), "base_image", request.GetBaseImage(), "package_count", len(request.GetPackages()))
	imageID := request.GetImageId()
	if imageID == "" {
		return nil, status.Error(codes.InvalidArgument, "image id is required")
	}
	if imageIDOverridesBase(imageID) {
		return nil, status.Error(codes.InvalidArgument, "cannot build over the base image")
	}
	if s.ImageBuilder == nil {
		return nil, status.Error(codes.FailedPrecondition, "image builder is not configured")
	}
	base := request.GetBaseImage()
	resolved, err := s.resolveImage(base)
	if err != nil {
		if status.Code(err) == codes.NotFound {
			return nil, status.Error(codes.NotFound, fmt.Sprintf("base image %q not found", base))
		}
		return nil, err
	}
	if resolved.ImageTag == "" {
		return nil, status.Error(codes.NotFound, fmt.Sprintf("base image %q not found", base))
	}
	base = resolved.ImageTag
	image := state.Image{ImageID: imageID, BaseImage: base, Packages: append([]string(nil), request.GetPackages()...)}
	stored, err := s.buildImage(imageID, image)
	if err != nil {
		s.log().Error("control request failed", "method", "BuildImage", "image_id", imageID, "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	s.log().Info("control request completed", "method", "BuildImage", "image_id", stored.ImageID, "image_tag", stored.ImageTag)
	return imageProto(stored), nil
}
func (s *Server) RebuildImage(_ context.Context, request *ctl.RebuildImageRequest) (*ctl.Image, error) {
	s.log().Info("control request", "method", "RebuildImage", "image_id", request.GetImageId())
	imageID := request.GetImageId()
	if imageID == "" {
		return nil, status.Error(codes.InvalidArgument, "image id is required")
	}
	if imageIDOverridesBase(imageID) {
		return nil, status.Error(codes.InvalidArgument, "cannot rebuild the base image")
	}
	if s.ImageBuilder == nil {
		return nil, status.Error(codes.FailedPrecondition, "image builder is not configured")
	}
	resolved, err := s.resolveImage(imageID)
	if err != nil {
		s.log().Warn("control request failed", "method", "RebuildImage", "image_id", imageID, "reason", "not found")
		return nil, status.Error(codes.NotFound, "built image not found")
	}
	stored, err := s.buildImage(resolved.ImageID, resolved)
	if err != nil {
		s.log().Error("control request failed", "method", "RebuildImage", "image_id", imageID, "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	s.log().Info("control request completed", "method", "RebuildImage", "image_id", stored.ImageID, "image_tag", stored.ImageTag)
	return imageProto(stored), nil
}
func (s *Server) RemoveImage(_ context.Context, request *ctl.RemoveImageRequest) (*ctl.RemoveImageResponse, error) {
	s.log().Info("control request", "method", "RemoveImage", "image_id", request.GetImageId())
	imageID := request.GetImageId()
	if imageID == "" {
		return nil, status.Error(codes.InvalidArgument, "image id is required")
	}
	if imageIDOverridesBase(imageID) {
		return nil, status.Error(codes.InvalidArgument, "cannot remove the base image")
	}
	resolved, err := s.resolveImage(imageID)
	if err != nil {
		s.log().Warn("control request failed", "method", "RemoveImage", "image_id", imageID, "reason", "not found")
		return nil, err
	}
	workspaces, err := s.Store.Workspaces()
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	for _, workspace := range workspaces {
		if imageRefsMatch(workspace.ImageID, resolved.ImageID) {
			return nil, status.Error(codes.FailedPrecondition, fmt.Sprintf("image %q is in use by workspace %q container %q", imageID, workspace.WorkspaceSlug, "default"))
		}
		for _, container := range workspace.Containers {
			if imageRefsMatch(container.ImageID, resolved.ImageID) {
				return nil, status.Error(codes.FailedPrecondition, fmt.Sprintf("image %q is in use by workspace %q container %q", imageID, workspace.WorkspaceSlug, container.Name))
			}
		}
	}
	if s.Podman == nil {
		return nil, status.Error(codes.FailedPrecondition, "podman is not configured")
	}
	if err := s.Podman.ImageRemove(resolved.ImageTag); err != nil {
		s.log().Error("control request failed", "method", "RemoveImage", "image_id", imageID, "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	if err := s.Store.UpdateImages(func(current []state.Image) ([]state.Image, error) {
		next := make([]state.Image, 0, len(current))
		for _, image := range current {
			if image.ImageID != resolved.ImageID {
				next = append(next, image)
			}
		}
		return next, nil
	}); err != nil {
		s.log().Error("control request failed", "method", "RemoveImage", "image_id", imageID, "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	s.log().Info("control request completed", "method", "RemoveImage", "image_id", imageID)
	return &ctl.RemoveImageResponse{}, nil
}

// imageProto projects a stored image onto the control plane's Image message.
func imageProto(image state.Image) *ctl.Image {
	return &ctl.Image{ImageId: image.ImageID, BaseImage: image.BaseImage, Packages: image.Packages, ImageTag: image.ImageTag, BuiltAt: image.BuiltAt}
}

// buildImage builds the given image, stamps BuiltAt, upserts it in the store
// (replacing the record with the same id, else appending), and returns the
// stored image. The caller is responsible for builder availability checks.
func (s *Server) buildImage(id string, image state.Image) (state.Image, error) {
	if id != "" {
		image.ImageID = id
	}
	if s.ImageBuilder == nil {
		return state.Image{}, fmt.Errorf("podman image builder is not configured")
	}
	tag, err := s.ImageBuilder.Build(image)
	if err != nil {
		return state.Image{}, err
	}
	image.ImageTag = tag
	image.BuiltAt = time.Now().UTC().Format(time.RFC3339)
	if err := s.Store.UpdateImages(func(current []state.Image) ([]state.Image, error) {
		for i := range current {
			if current[i].ImageID == image.ImageID {
				current[i] = image
				return current, nil
			}
		}
		return append(current, image), nil
	}); err != nil {
		return state.Image{}, err
	}
	return image, nil
}

// defaultImage returns the stored default (base) image, auto-provisioning it
// when absent and enabled. The returned record's tag may be used as the base
// for derived image builds.
func (s *Server) defaultImage() (state.Image, error) {
	images, err := s.Store.Images()
	if err != nil {
		return state.Image{}, status.Error(codes.Internal, err.Error())
	}
	for _, image := range images {
		if image.ImageID == defaultImageID() && image.ImageTag != "" {
			return image, nil
		}
	}
	if !s.BuildDefaultImage {
		return state.Image{}, status.Error(codes.NotFound, "built image not found; default image auto-build is disabled")
	}
	if s.ImageBuilder == nil {
		return state.Image{}, status.Error(codes.FailedPrecondition, "podman image builder is not configured")
	}
	image := state.Image{ImageID: defaultImageID(), BaseImage: "docker.io/library/archlinux:latest", Packages: append([]string(nil), defaultPackages...)}
	image, err = s.buildImage(defaultImageID(), image)
	if err != nil {
		return state.Image{}, status.Error(codes.Internal, fmt.Sprintf("build default image: %v", err))
	}
	s.log().Info("auto-provisioned default image", "image_id", image.ImageID, "image_tag", image.ImageTag)
	return image, nil
}

// resolveImage resolves an image reference to a stored image record. The
// reference may be a stored image id (short or fully-qualified), with or
// without a tag suffix, or an already-qualified tag such as
// "localhost/dsh-podman/valkey:latest". The default (base) image is
// auto-provisioned when absent and enabled.
func (s *Server) resolveImage(imageID string) (state.Image, error) {
	images, err := s.Store.Images()
	if err != nil {
		return state.Image{}, status.Error(codes.Internal, err.Error())
	}
	// Normalize a trailing ":tag" so ids with and without a tag both resolve.
	id := imageID
	if stripped, _, hasTag := strings.Cut(imageID, ":"); hasTag {
		id = stripped
	}
	// Exact matches (a stored tag or id) win over the default image.
	for _, image := range images {
		if image.ImageTag != "" && image.ImageTag == imageID {
			return image, nil
		}
		if image.ImageTag != "" && (image.ImageID == imageID || image.ImageID == id) {
			return image, nil
		}
	}
	// The default (base) image, auto-provisioned when absent and enabled.
	if isDefaultImageID(id) {
		def, err := s.defaultImage()
		if err != nil {
			return state.Image{}, err
		}
		return def, nil
	}
	// Fully-qualified references to a stored image id.
	for _, image := range images {
		if image.ImageTag != "" && strings.TrimPrefix(image.ImageID, imagePrefix()) == strings.TrimPrefix(id, imagePrefix()) {
			return image, nil
		}
	}
	return state.Image{}, status.Error(codes.NotFound, "built image not found")
}

// isDefaultImageID reports whether id refers to the default (base) image, in
// either its short or fully-qualified form.
func isDefaultImageID(id string) bool {
	return strings.TrimPrefix(id, imagePrefix()) == strings.TrimPrefix(defaultImageID(), imagePrefix())
}

// imageRefsMatch reports whether two stored image references denote the same
// image, ignoring a trailing ":tag" and the registry prefix.
func imageRefsMatch(a, b string) bool {
	if stripped, _, hasTag := strings.Cut(a, ":"); hasTag {
		a = stripped
	}
	if stripped, _, hasTag := strings.Cut(b, ":"); hasTag {
		b = stripped
	}
	return strings.TrimPrefix(a, imagePrefix()) == strings.TrimPrefix(b, imagePrefix())
}

// imageIDOverridesBase reports whether an image id used as a build/rebuild
// target refers to the default (base) image, allowing for a tag suffix and the
// fully-qualified form.
func imageIDOverridesBase(imageID string) bool {
	if stripped, _, hasTag := strings.Cut(imageID, ":"); hasTag {
		imageID = stripped
	}
	return isDefaultImageID(imageID)
}

// resolveImageTag returns the stored image tag for an image reference, or a
// NotFound status error when no built image with a non-empty tag is stored.
func (s *Server) resolveImageTag(imageID string) (string, error) {
	image, err := s.resolveImage(imageID)
	if err != nil {
		return "", err
	}
	if image.ImageTag == "" {
		return "", status.Error(codes.NotFound, "built image not found")
	}
	return image.ImageTag, nil
}

// containerMounts returns the mounts that apply to a container: its own list
// when present, otherwise the workspace's default mounts (read-time fallback
// for state written before per-container mounts existed).
func containerMounts(ws state.Workspace, c state.Container) []state.Mount {
	if len(c.Mounts) > 0 {
		return c.Mounts
	}
	return ws.Mounts
}

// cloneMap returns a shallow copy of a string map, or nil when the source is
// empty. A nil source yields nil.
func cloneMap(source map[string]string) map[string]string {
	if len(source) == 0 {
		return nil
	}
	result := make(map[string]string, len(source))
	for key, value := range source {
		result[key] = value
	}
	return result
}

// validateEnv rejects user environment variables whose keys are empty, contain
// '=' or a NUL byte, or collide with the reserved DSH_PODMAN namespace. Values
// containing a NUL byte are rejected as well. Keys are visited in sorted order
// so the returned message is deterministic.
func validateEnv(env map[string]string) error {
	keys := make([]string, 0, len(env))
	for key := range env {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if strings.HasPrefix(key, "DSH_PODMAN") {
			return fmt.Errorf("env key %q is reserved (DSH_PODMAN prefix)", key)
		}
		if key == "" {
			return fmt.Errorf("env key is empty")
		}
		if strings.ContainsRune(key, '=') {
			return fmt.Errorf("env key %q contains '='", key)
		}
		if strings.ContainsRune(key, '\x00') {
			return fmt.Errorf("env key %q contains a NUL byte", key)
		}
		if strings.ContainsRune(env[key], '\x00') {
			return fmt.Errorf("env value for key %q contains a NUL byte", key)
		}
	}
	return nil
}

// stateMounts projects the control plane's project mounts onto the state
// model's read_only/read_write representation.
func stateMounts(mounts []*ctl.ProjectMount) []state.Mount {
	result := make([]state.Mount, 0, len(mounts))
	for _, mount := range mounts {
		result = append(result, mountFromProto(mount))
	}
	return result
}

// mountFromProto maps a control plane project mount onto its state
// representation.
func mountFromProto(mount *ctl.ProjectMount) state.Mount {
	mode := "read_only"
	if mount.GetMode() == ctl.MountMode_MOUNT_MODE_READ_WRITE {
		mode = "read_write"
	}
	kind, err := mountKindFromProto(mount.GetKind())
	if err != nil {
		kind = ""
	}
	return state.Mount{ProjectName: mount.GetProjectName(), Path: mount.GetPath(), Destination: mount.GetDestination(), Mode: mode, Kind: kind, Volume: mount.GetVolume()}
}

// mountKindFromProto maps a control plane mount kind onto the state's string
// representation ("", "tmpfs", or "volume"), rejecting unknown kinds.
func mountKindFromProto(kind ctl.MountKind) (string, error) {
	switch kind {
	case ctl.MountKind_MOUNT_KIND_UNSPECIFIED, ctl.MountKind_MOUNT_KIND_PROJECT:
		return "", nil
	case ctl.MountKind_MOUNT_KIND_TMPFS:
		return "tmpfs", nil
	case ctl.MountKind_MOUNT_KIND_VOLUME:
		return "volume", nil
	default:
		return "", fmt.Errorf("invalid mount kind")
	}
}

// mountKindToProto projects a state mount kind onto the control plane enum;
// the empty kind (legacy project mounts) maps to MOUNT_KIND_PROJECT.
func mountKindToProto(kind string) ctl.MountKind {
	switch kind {
	case "tmpfs":
		return ctl.MountKind_MOUNT_KIND_TMPFS
	case "volume":
		return ctl.MountKind_MOUNT_KIND_VOLUME
	default:
		return ctl.MountKind_MOUNT_KIND_PROJECT
	}
}

// mountModeFromProto maps a control plane mount mode onto the state's
// read_only/read_write representation, rejecting unspecified modes.
func mountModeFromProto(mode ctl.MountMode) (string, error) {
	switch mode {
	case ctl.MountMode_MOUNT_MODE_READ_WRITE:
		return "read_write", nil
	case ctl.MountMode_MOUNT_MODE_READ_ONLY:
		return "read_only", nil
	default:
		return "", fmt.Errorf("invalid mount mode")
	}
}

// validMountSubpath reports whether path is an acceptable project subpath:
// empty (the project root), or a relative path with no "." / ".." segments,
// redundant separators, or absolute form.
func validMountSubpath(path string) bool {
	if path == "" {
		return true
	}
	raw := filepath.FromSlash(path)
	cleaned := filepath.Clean(raw)
	return !filepath.IsAbs(raw) && cleaned == raw && cleaned != "." && cleaned != ".." && !strings.HasPrefix(cleaned, ".."+string(filepath.Separator))
}

// validMountDestination reports whether dest is an acceptable container mount
// destination: an absolute path under projectsRoot with no ".." segments.
func validMountDestination(projectsRoot, dest string) bool {
	if !filepath.IsAbs(dest) {
		return false
	}
	cleaned := filepath.Clean(dest)
	if cleaned != dest {
		return false
	}
	root := filepath.Clean(projectsRoot)
	return cleaned == root || strings.HasPrefix(cleaned, root+string(filepath.Separator))
}

// nonProjectDestination validates a tmpfs or named-volume mount destination:
// it must be absolute, already cleaned (filepath.Clean equality precludes ".."
// segments, redundant separators, and trailing slashes), and must not be the
// projects root nor anything under it, which would collide with project
// mounts.
func nonProjectDestination(projectsRoot, dest string) error {
	if !filepath.IsAbs(dest) {
		return fmt.Errorf("invalid mount destination")
	}
	cleaned := filepath.Clean(dest)
	if cleaned != dest {
		return fmt.Errorf("invalid mount destination")
	}
	root := filepath.Clean(projectsRoot)
	if cleaned == root || strings.HasPrefix(cleaned, root+string(filepath.Separator)) {
		return fmt.Errorf("mount destination must not be under projects root")
	}
	return nil
}

// resolveMount resolves a single stored mount to its host source path and its
// container destination path, validating the project, the subpath, and (when
// set) the destination. The empty destination defaults to a mirror of the host
// source under projectsRoot.
func resolveMount(projectsRoot, hostProjectsRoot string, mount state.Mount) (hostPath, destination string, err error) {
	projectPath, err := ValidateProject(projectsRoot, mount.ProjectName)
	if err != nil {
		return "", "", err
	}
	if !validMountSubpath(mount.Path) {
		return "", "", fmt.Errorf("invalid mount path")
	}
	subpath := filepath.FromSlash(mount.Path)
	if info, statErr := os.Stat(filepath.Join(projectsRoot, mount.ProjectName, subpath)); statErr != nil || !info.IsDir() {
		return "", "", fmt.Errorf("mount path %q does not exist under project %q", mount.Path, mount.ProjectName)
	}
	hostPath = projectPath
	if hostProjectsRoot != "" {
		hostPath = filepath.Join(hostProjectsRoot, filepath.FromSlash(mount.ProjectName))
	}
	if subpath != "" {
		hostPath = filepath.Join(hostPath, subpath)
	}
	destination = filepath.Join(projectsRoot, mount.ProjectName, subpath)
	if mount.Destination != "" {
		if !validMountDestination(projectsRoot, mount.Destination) {
			return "", "", fmt.Errorf("invalid mount destination")
		}
		destination = mount.Destination
	}
	return hostPath, destination, nil
}

// podmanMounts builds the mounts handed to podman from the stored mounts.
// Project mounts resolve their host paths through HostProjectsRoot and
// container destinations under ProjectsRoot; tmpfs and named-volume mounts
// target arbitrary absolute container paths (never under ProjectsRoot).
func (s *Server) podmanMounts(mounts []state.Mount) ([]specs.Mount, error) {
	podmanMounts := make([]specs.Mount, 0, len(mounts))
	for _, mount := range mounts {
		switch mount.Kind {
		case "", "project":
			hostPath, destination, err := resolveMount(s.ProjectsRoot, s.HostProjectsRoot, mount)
			if err != nil {
				return nil, status.Error(codes.InvalidArgument, err.Error())
			}
			options := []string{"ro"}
			if mount.Mode == "read_write" {
				options = []string{"rw"}
			}
			podmanMounts = append(podmanMounts, specs.Mount{Type: "bind", Source: hostPath, Destination: destination, Options: options})
		case "tmpfs":
			if err := nonProjectDestination(s.ProjectsRoot, mount.Destination); err != nil {
				return nil, status.Error(codes.InvalidArgument, err.Error())
			}
			podmanMounts = append(podmanMounts, specs.Mount{Type: "tmpfs", Destination: mount.Destination, Options: []string{"rw"}})
		case "volume":
			if !volumeName.MatchString(mount.Volume) {
				return nil, status.Error(codes.InvalidArgument, "invalid volume name")
			}
			if err := nonProjectDestination(s.ProjectsRoot, mount.Destination); err != nil {
				return nil, status.Error(codes.InvalidArgument, err.Error())
			}
			options := []string{"ro"}
			if mount.Mode == "read_write" {
				options = []string{"rw"}
			}
			podmanMounts = append(podmanMounts, specs.Mount{Type: "volume", Source: s.VolumePrefix + mount.Volume, Destination: mount.Destination, Options: options})
		default:
			return nil, status.Error(codes.InvalidArgument, "invalid mount kind")
		}
	}
	return podmanMounts, nil
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
func (s *Server) RemoveContainer(_ context.Context, request *ctl.RemoveContainerRequest) (*ctl.RemoveContainerResponse, error) {
	s.log().Info("control request", "method", "RemoveContainer", "workspace_slug", request.GetWorkspaceSlug(), "container", request.GetContainer())
	if !validContainerName(request.GetContainer()) {
		return nil, status.Error(codes.InvalidArgument, "invalid container name")
	}
	workspace, err := workspaceBySlug(s.Store, request.GetWorkspaceSlug())
	if err != nil {
		return nil, status.Error(codes.NotFound, "workspace not found")
	}
	record, ok := containerByLogical(&workspace, request.GetContainer())
	if !ok {
		s.log().Warn("control request failed", "method", "RemoveContainer", "workspace_slug", request.GetWorkspaceSlug(), "container", request.GetContainer(), "reason", "container not found")
		return nil, status.Error(codes.NotFound, "container not found")
	}
	if s.Podman == nil {
		return nil, status.Error(codes.FailedPrecondition, "podman is not configured")
	}
	s.stopContainerDaemons(context.Background(), *record)
	if err := s.Podman.Stop(record.PodmanName); err != nil {
		s.log().Warn("RemoveContainer stop failed", "workspace_slug", request.GetWorkspaceSlug(), "container", request.GetContainer(), "error", err)
	}
	if err := s.Podman.Remove(record.PodmanName); err != nil {
		s.log().Error("control request failed", "method", "RemoveContainer", "workspace_slug", request.GetWorkspaceSlug(), "container", request.GetContainer(), "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	if err := s.Store.UpdateWorkspaces(func(all []state.Workspace) ([]state.Workspace, error) {
		for i := range all {
			if all[i].WorkspaceSlug == workspace.WorkspaceSlug {
				remaining := make([]state.Container, 0, len(all[i].Containers))
				for _, container := range all[i].Containers {
					if container.Name != request.GetContainer() {
						remaining = append(remaining, container)
					}
				}
				all[i].Containers = remaining
				syncDefaultFields(&all[i])
				return all, nil
			}
		}
		return all, nil
	}); err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	remaining, err := s.Store.Workspaces()
	if err != nil {
		s.log().Warn("RemoveContainer workspace re-read failed", "workspace_slug", request.GetWorkspaceSlug(), "error", err)
	}
	for _, ws := range remaining {
		if ws.WorkspaceSlug == workspace.WorkspaceSlug {
			if len(ws.Containers) == 0 {
				if podErr := s.Podman.RemovePod(podNameFor(ws.WorkspaceSlug)); podErr != nil {
					s.log().Warn("RemoveContainer pod cleanup failed", "workspace_slug", ws.WorkspaceSlug, "error", podErr)
				}
			}
			break
		}
	}
	s.log().Info("control request completed", "method", "RemoveContainer", "workspace_slug", request.GetWorkspaceSlug(), "container", request.GetContainer())
	return &ctl.RemoveContainerResponse{}, nil
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
		return nil, status.Error(codes.InvalidArgument, "invalid volume name")
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
		return nil, status.Error(codes.AlreadyExists, "volume already exists")
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
		return nil, status.Error(codes.InvalidArgument, "invalid volume name")
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
		return nil, status.Error(codes.NotFound, "volume not found")
	}
	if err := s.Podman.VolumeRemove(full); err != nil {
		s.log().Error("control request failed", "method", "RemoveVolume", "name", request.GetName(), "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	s.log().Info("control request completed", "method", "RemoveVolume", "name", request.GetName())
	return &ctl.RemoveVolumeResponse{}, nil
}
func toProto(workspace state.Workspace) *ctl.Workspace {
	result := &ctl.Workspace{WorkspaceSlug: workspace.WorkspaceSlug, ContainerName: workspace.ContainerName, ImageId: workspace.ImageID, Status: workspace.Status, AgentSocketPath: workspace.AgentSocketPath, AgentToken: workspace.AgentToken, CreatedAt: workspace.CreatedAt}
	if defaultContainer, ok := containerByLogical(&workspace, "default"); ok {
		result.Env = cloneMap(defaultContainer.Env)
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
