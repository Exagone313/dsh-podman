// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"context"
	"crypto/rand"
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

	"github.com/containers/podman/v5/pkg/specgen"
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

// secretName restricts short secret names to the same shape podman accepts
// when the orchestrator prefixes them.
var secretName = volumeName

// shortImageNamePattern restricts short image ids to letters, digits, '_',
// '.', and '-', starting with an alphanumeric or '_', and at most 64
// characters. Slashes and colons are excluded: every image reference is a
// bare short name.
var shortImageNamePattern = regexp.MustCompile(`^[a-zA-Z0-9_][a-zA-Z0-9_.\-]{0,63}$`)

func shortImageName(s string) bool {
	return s != "." && s != ".." && shortImageNamePattern.MatchString(s)
}

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
	ProjectsRoot     string
	HostProjectsRoot string
	SocketsRoot      string
	Store            *state.Store
	Podman           *podman.Client
	ImageBuilder     *imagebuild.Builder
	BaseImagePrefix  string
	VolumePrefix     string
	SecretPrefix     string
	Logger           *slog.Logger
}

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
	result := &ctl.ListImagesResponse{}
	for _, base := range imagebuild.BaseImages {
		resolved, err := s.resolveImage(base.ID)
		if err != nil {
			s.log().Error("control request failed", "method", "ListImages", "base_image", base.ID, "error", err)
			return nil, err
		}
		result.Images = append(result.Images, imageProto(resolved))
	}
	images, err := s.Store.Images()
	if err != nil {
		s.log().Error("control request failed", "method", "ListImages", "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	for _, image := range images {
		resolved, err := s.resolveImage(image.ImageID)
		if err != nil {
			s.log().Error("control request failed", "method", "ListImages", "image_id", image.ImageID, "error", err)
			return nil, err
		}
		result.Images = append(result.Images, imageProto(resolved))
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
	row := &ctl.Container{ContainerName: c.Name, PodmanName: c.PodmanName, WorkspaceSlug: ws.WorkspaceSlug, ImageId: c.ImageID, Status: c.Status, CreatedAt: c.CreatedAt, AgentSocketPath: c.AgentSocketPath, AgentToken: c.AgentToken, Env: cloneMap(c.Env), SecretEnv: cloneMap(c.SecretEnv)}
	for _, mount := range containerMounts(ws, c) {
		mode := ctl.MountMode_MOUNT_MODE_READ_ONLY
		if mount.Mode == "read_write" {
			mode = ctl.MountMode_MOUNT_MODE_READ_WRITE
		}
		row.Mounts = append(row.Mounts, &ctl.ProjectMount{ProjectName: mount.ProjectName, Path: mount.Path, Destination: mount.Destination, Mode: mode, Kind: mountKindToProto(mount.Kind), Volume: mount.Volume, Secret: mount.Secret})
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
	secrets, err := s.podmanSecrets(record.Mounts)
	if err != nil {
		return err
	}
	envSecrets := s.containerEnvSecrets(record.SecretEnv)
	return s.Podman.RecreateWorkspace(podNameFor(workspace.WorkspaceSlug), record.PodmanName, imageTag, newToken, podmanMounts, secrets, envSecrets, env)
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
	imageID := request.GetImageId()
	if imageID == "" {
		imageID = defaultImageShort()
	}
	recordMounts := workspace.Mounts
	if len(request.GetMounts()) > 0 {
		recordMounts = stateMounts(request.GetMounts())
	}
	record := state.Container{Name: container, PodmanName: podmanContainerName(workspace.WorkspaceSlug, container), ImageID: imageID, Mounts: recordMounts}
	podmanMounts, err := s.podmanMounts(containerMounts(workspace, record))
	if err != nil {
		s.log().Error("StartContainer project validation failed", "workspace_slug", workspace.WorkspaceSlug, "error", err)
		return nil, err
	}
	secrets, err := s.podmanSecrets(recordMounts)
	if err != nil {
		s.log().Error("StartContainer secret validation failed", "workspace_slug", workspace.WorkspaceSlug, "error", err)
		return nil, err
	}
	record.SecretEnv = cloneMap(request.GetSecretEnv())
	if err := validateSecretEnv(record.SecretEnv); err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}
	envSecrets := s.containerEnvSecrets(record.SecretEnv)
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
	if err := s.Podman.CreateWorkspace(podNameFor(workspace.WorkspaceSlug), record.PodmanName, imageTag, secret, podmanMounts, secrets, envSecrets, record.Env); err != nil {
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
	exists, imageErr := s.Podman.ImageExists(imageTag)
	if imageErr != nil {
		return nil, status.Error(codes.Internal, imageErr.Error())
	}
	if !exists {
		s.log().Warn("CreateWorkspace image state is stale", "image_id", imageID, "image_tag", imageTag)
		return nil, status.Error(codes.NotFound, "built image not found")
	}
	name := "dsh-workspace-" + request.GetWorkspaceSlug()
	if err := s.Podman.CreateWorkspace(podNameFor(request.GetWorkspaceSlug()), name, imageTag, secret, podmanMounts, secrets, envSecrets, userEnv); err != nil {
		s.log().Error("control request failed", "method", "CreateWorkspace", "workspace_slug", request.GetWorkspaceSlug(), "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	agentSocket := filepath.Join(s.SocketsRoot, name, "guest.sock")
	createdAt := time.Now().UTC().Format(time.RFC3339)
	workspace := state.Workspace{WorkspaceSlug: request.GetWorkspaceSlug(), ContainerName: name, ImageID: imageID, Mounts: mounts, Status: "running", AgentSocketPath: agentSocket, AgentToken: secret, CreatedAt: createdAt, Containers: []state.Container{{Name: "default", PodmanName: name, ImageID: imageID, Mounts: defaultMounts, Status: "running", CreatedAt: createdAt, AgentSocketPath: agentSocket, AgentToken: secret, Env: userEnv, SecretEnv: userSecretEnv}}}
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
	s.log().Info("control request", "method", "BuildImage", "image_id", request.GetImageId(), "parent", request.GetParent(), "package_count", len(request.GetPackages()))
	imageID := request.GetImageId()
	if !shortImageName(imageID) {
		return nil, status.Error(codes.InvalidArgument, "invalid image id")
	}
	if _, ok := imagebuild.BaseImageByID(imageID); ok {
		return nil, status.Error(codes.InvalidArgument, "image id is a reserved base image name")
	}
	if s.ImageBuilder == nil {
		return nil, status.Error(codes.FailedPrecondition, "image builder is not configured")
	}
	image := state.Image{ImageID: imageID, Parent: request.GetParent(), Packages: append([]string(nil), request.GetPackages()...)}
	stored, err := s.buildCustomImage(image)
	if err != nil {
		s.log().Error("control request failed", "method", "BuildImage", "image_id", imageID, "error", err)
		return nil, grpcError(err)
	}
	s.log().Info("control request completed", "method", "BuildImage", "image_id", stored.ImageID, "image_tag", stored.ImageTag)
	return imageProto(resolvedImage{ImageID: stored.ImageID, IsBase: false, PackageManager: stored.PackageManager, ImageTag: stored.ImageTag, Parent: stored.Parent, Packages: stored.Packages, BuiltAt: stored.BuiltAt, Status: "built"}), nil
}
func (s *Server) RebuildImage(_ context.Context, request *ctl.RebuildImageRequest) (*ctl.Image, error) {
	s.log().Info("control request", "method", "RebuildImage", "image_id", request.GetImageId())
	imageID := request.GetImageId()
	if imageID == "" {
		return nil, status.Error(codes.InvalidArgument, "image id is required")
	}
	if _, ok := imagebuild.BaseImageByID(imageID); ok {
		return nil, status.Error(codes.InvalidArgument, "base images are rebuilt from the settings")
	}
	if s.ImageBuilder == nil {
		return nil, status.Error(codes.FailedPrecondition, "image builder is not configured")
	}
	resolved, err := s.resolveImage(imageID)
	if err != nil {
		s.log().Warn("control request failed", "method", "RebuildImage", "image_id", imageID, "reason", "not found")
		return nil, err
	}
	if resolved.IsBase {
		return nil, status.Error(codes.InvalidArgument, "base images are rebuilt from the settings")
	}
	stored, err := s.buildCustomImage(state.Image{ImageID: imageID, Parent: resolved.Parent, PackageManager: resolved.PackageManager, Packages: resolved.Packages})
	if err != nil {
		s.log().Error("control request failed", "method", "RebuildImage", "image_id", imageID, "error", err)
		return nil, grpcError(err)
	}
	s.log().Info("control request completed", "method", "RebuildImage", "image_id", stored.ImageID, "image_tag", stored.ImageTag)
	return imageProto(resolvedImage{ImageID: stored.ImageID, IsBase: false, PackageManager: stored.PackageManager, ImageTag: stored.ImageTag, Parent: stored.Parent, Packages: stored.Packages, BuiltAt: stored.BuiltAt, Status: "built"}), nil
}
func (s *Server) RebuildAllImages(_ context.Context, _ *ctl.RebuildAllImagesRequest) (*ctl.RebuildAllImagesResponse, error) {
	s.log().Info("control request", "method", "RebuildAllImages")
	if s.Podman == nil {
		return nil, status.Error(codes.FailedPrecondition, "podman is not configured")
	}
	if s.ImageBuilder == nil {
		return nil, status.Error(codes.FailedPrecondition, "image builder is not configured")
	}
	images, err := s.Store.Images()
	if err != nil {
		s.log().Error("control request failed", "method", "RebuildAllImages", "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	for _, base := range imagebuild.BaseImages {
		if _, _, err := s.ensureBase(base.ID); err != nil {
			s.log().Error("control request failed", "method", "RebuildAllImages", "base_image", base.ID, "error", err)
		}
	}
	_, dependents := rebuildGraph(images)
	ordered, skipped := rebuildPlan(images)
	settled := make(map[string]bool, len(images))
	for _, id := range skipped {
		settled[id] = true
	}
	rebuilt := make([]string, 0, len(ordered))
	for _, image := range ordered {
		if settled[image.ImageID] {
			continue
		}
		if _, err := s.buildCustomImage(image); err != nil {
			s.log().Error("control request failed", "method", "RebuildAllImages", "image_id", image.ImageID, "error", err)
			for _, id := range skipDependents(dependents, image.ImageID) {
				if settled[id] {
					continue
				}
				settled[id] = true
				skipped = append(skipped, id)
			}
			continue
		}
		settled[image.ImageID] = true
		rebuilt = append(rebuilt, image.ImageID)
	}
	s.log().Info("control request completed", "method", "RebuildAllImages", "rebuilt", len(rebuilt), "skipped", len(skipped))
	return &ctl.RebuildAllImagesResponse{Rebuilt: rebuilt, Skipped: skipped}, nil
}
func (s *Server) RebuildBaseImage(_ context.Context, request *ctl.RebuildBaseImageRequest) (*ctl.Image, error) {
	s.log().Info("control request", "method", "RebuildBaseImage", "name", request.GetName())
	base, ok := imagebuild.BaseImageByID(request.GetName())
	if !ok {
		return nil, status.Error(codes.NotFound, "base image not found")
	}
	if s.baseImagesPublic() {
		return nil, status.Error(codes.InvalidArgument, "base images are pulled, not built, in this mode")
	}
	if s.Podman == nil {
		return nil, status.Error(codes.FailedPrecondition, "podman is not configured")
	}
	if s.ImageBuilder == nil {
		return nil, status.Error(codes.FailedPrecondition, "image builder is not configured")
	}
	spec := imagebuild.BuildSpec{ImageID: base.ID, From: base.Primitive, PackageManager: base.PackageManager, Packages: base.Packages, IsBase: true, PostInstall: base.PostInstall, GuestAgent: s.ImageBuilder.GuestAgentImage}
	tag, err := s.ImageBuilder.Build(spec)
	if err != nil {
		s.log().Error("control request failed", "method", "RebuildBaseImage", "name", request.GetName(), "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	s.log().Info("control request completed", "method", "RebuildBaseImage", "name", request.GetName(), "image_tag", tag)
	return imageProto(resolvedImage{ImageID: base.ID, IsBase: true, PackageManager: base.PackageManager, ImageTag: tag, Primitive: base.Primitive, Packages: append([]string(nil), base.Packages...), Status: "built", BuiltAt: s.Podman.ImageCreated(tag), BasePublic: false}), nil
}
func (s *Server) PullBaseImage(_ context.Context, request *ctl.PullBaseImageRequest) (*ctl.Image, error) {
	s.log().Info("control request", "method", "PullBaseImage", "name", request.GetName())
	base, ok := imagebuild.BaseImageByID(request.GetName())
	if !ok {
		return nil, status.Error(codes.NotFound, "base image not found")
	}
	if !s.baseImagesPublic() {
		return nil, status.Error(codes.InvalidArgument, "base images are built, not pulled, in this mode")
	}
	if s.Podman == nil {
		return nil, status.Error(codes.FailedPrecondition, "podman is not configured")
	}
	tag := s.baseTag(base.ID)
	if err := s.Podman.ImagePull(tag); err != nil {
		s.log().Error("control request failed", "method", "PullBaseImage", "name", request.GetName(), "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	s.log().Info("control request completed", "method", "PullBaseImage", "name", request.GetName(), "image_tag", tag)
	return imageProto(resolvedImage{ImageID: base.ID, IsBase: true, PackageManager: base.PackageManager, ImageTag: tag, Primitive: base.Primitive, Packages: append([]string(nil), base.Packages...), Status: "pulled", BuiltAt: s.Podman.ImageCreated(tag), BasePublic: true}), nil
}
func (s *Server) RemoveImage(_ context.Context, request *ctl.RemoveImageRequest) (*ctl.RemoveImageResponse, error) {
	s.log().Info("control request", "method", "RemoveImage", "image_id", request.GetImageId())
	imageID := request.GetImageId()
	if imageID == "" {
		return nil, status.Error(codes.InvalidArgument, "image id is required")
	}
	if _, ok := imagebuild.BaseImageByID(imageID); ok {
		return nil, status.Error(codes.InvalidArgument, "base images are rebuilt from the settings")
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
		if imageRefsMatch(workspace.ImageID, imageID) {
			return nil, status.Error(codes.FailedPrecondition, fmt.Sprintf("image %q is in use by workspace %q container %q", imageID, workspace.WorkspaceSlug, "default"))
		}
		for _, container := range workspace.Containers {
			if imageRefsMatch(container.ImageID, imageID) {
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
			if image.ImageID != imageID {
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

// resolvedImage is the control-plane-ready projection of an image reference:
// either a synthesized base image or a stored custom image.
type resolvedImage struct {
	ImageID        string
	IsBase         bool
	PackageManager string
	ImageTag       string
	Parent         string
	Packages       []string
	BuiltAt        string
	Primitive      string
	Status         string
	BasePublic     bool
}

// imageProto projects a resolved image onto the control plane's Image message.
func imageProto(image resolvedImage) *ctl.Image {
	return &ctl.Image{ImageId: image.ImageID, Parent: image.Parent, Packages: image.Packages, ImageTag: image.ImageTag, BuiltAt: image.BuiltAt, IsBase: image.IsBase, Status: image.Status, Primitive: image.Primitive, PackageManager: image.PackageManager, BasePublic: image.BasePublic}
}

// buildCustomImage builds a custom image from its stored description,
// resolving its short-name parent to a tag, stamps BuiltAt, upserts the
// record in the store (replacing the record with the same id, else appending),
// and returns the stored image. The caller is responsible for builder
// availability checks.
func (s *Server) buildCustomImage(image state.Image) (state.Image, error) {
	parentTag, parentPM, err := s.resolveParent(image.Parent)
	if err != nil {
		return state.Image{}, err
	}
	spec := imagebuild.BuildSpec{ImageID: image.ImageID, From: parentTag, PackageManager: parentPM, Packages: image.Packages, IsBase: false}
	tag, err := s.ImageBuilder.Build(spec)
	if err != nil {
		return state.Image{}, err
	}
	image.ImageTag = tag
	image.PackageManager = parentPM
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

// rebuildGraph indexes stored images for rebuild planning: byID maps short
// image ids to their records (last occurrence wins) and dependents maps each
// short image id to the sorted list of image ids whose parent is that id.
func rebuildGraph(images []state.Image) (byID map[string]state.Image, dependents map[string][]string) {
	byID = make(map[string]state.Image, len(images))
	for _, image := range images {
		byID[image.ImageID] = image
	}
	dependents = make(map[string][]string)
	for _, image := range images {
		if owner, ok := byID[image.Parent]; ok {
			dependents[owner.ImageID] = append(dependents[owner.ImageID], image.ImageID)
		}
	}
	for owner := range dependents {
		sort.Strings(dependents[owner])
	}
	return byID, dependents
}

// rebuildPlan computes the deterministic rebuild plan for the stored custom
// images. It returns the ordered list of images to rebuild, with every parent
// preceding its dependents, and the list of image ids to skip.
//
// A parent that names a base image is always usable: bases are ensured before
// custom images are rebuilt. A parent that cannot be resolved to a stored
// custom image is skipped, as are any images left over by a dependency cycle.
func rebuildPlan(images []state.Image) (ordered []state.Image, skipped []string) {
	byID, dependents := rebuildGraph(images)

	settled := make(map[string]bool, len(images))
	rebuilt := make(map[string]bool, len(images))

	var markSkipped func(id string)
	markSkipped = func(id string) {
		if settled[id] {
			return
		}
		settled[id] = true
		skipped = append(skipped, id)
		for _, dependent := range dependents[id] {
			markSkipped(dependent)
		}
	}

	candidates := make([]string, 0, len(images))
	for _, image := range images {
		candidates = append(candidates, image.ImageID)
	}
	sort.Strings(candidates)
	remaining := make(map[string]bool, len(candidates))
	for _, id := range candidates {
		remaining[id] = true
	}

	for len(remaining) > 0 {
		progress := false
		for _, id := range candidates {
			if !remaining[id] {
				continue
			}
			if settled[id] {
				delete(remaining, id)
				continue
			}
			image := byID[id]
			if image.Parent == "" {
				markSkipped(id)
				delete(remaining, id)
				progress = true
				continue
			}
			if _, isBase := imagebuild.BaseImageByID(image.Parent); isBase {
				settled[id] = true
				rebuilt[id] = true
				ordered = append(ordered, image)
				delete(remaining, id)
				progress = true
				continue
			}
			owner, ok := byID[image.Parent]
			if !ok {
				markSkipped(id)
				delete(remaining, id)
				progress = true
				continue
			}
			if !settled[owner.ImageID] {
				continue
			}
			if !rebuilt[owner.ImageID] {
				markSkipped(id)
				delete(remaining, id)
				progress = true
				continue
			}
			settled[id] = true
			rebuilt[id] = true
			ordered = append(ordered, image)
			delete(remaining, id)
			progress = true
		}
		if !progress {
			leftover := make([]string, 0, len(remaining))
			for id := range remaining {
				leftover = append(leftover, id)
			}
			sort.Strings(leftover)
			for _, id := range leftover {
				markSkipped(id)
			}
			break
		}
	}
	return ordered, skipped
}

// skipDependents returns failedID and all of its transitive dependents: the
// image ids that must be skipped when failedID's rebuild fails.
func skipDependents(dependents map[string][]string, failedID string) []string {
	skipped := make([]string, 0)
	seen := make(map[string]bool)
	var walk func(id string)
	walk = func(id string) {
		if seen[id] {
			return
		}
		seen[id] = true
		skipped = append(skipped, id)
		for _, dependent := range dependents[id] {
			walk(dependent)
		}
	}
	walk(failedID)
	return skipped
}

// defaultImageShort is the short name of the built-in default workspace image.
func defaultImageShort() string {
	return "archlinux"
}

// baseTag computes the fully-qualified tag for a base image short name under
// the server's base image prefix.
func (s *Server) baseTag(short string) string {
	prefix := s.BaseImagePrefix
	if prefix == "" {
		prefix = "localhost/dsh-podman/base/"
	}
	if !strings.HasSuffix(prefix, "/") {
		prefix += "/"
	}
	return prefix + short + ":latest"
}

// baseImagesPublic reports whether base images are pulled from a public
// registry rather than built locally. A prefix starting with "localhost/"
// designates a local build prefix; an empty prefix defaults to the local
// prefix.
func (s *Server) baseImagesPublic() bool {
	prefix := s.BaseImagePrefix
	if prefix == "" {
		prefix = "localhost/dsh-podman/base/"
	}
	return !strings.HasPrefix(prefix, "localhost/")
}

// baseStatus reports the current status of a base image: "built" (local mode)
// or "pulled" (public mode) when the image is present, else "missing".
func (s *Server) baseStatus(short string) (string, error) {
	if _, ok := imagebuild.BaseImageByID(short); !ok {
		return "", status.Error(codes.NotFound, "base image not found")
	}
	if s.Podman == nil {
		return "", status.Error(codes.FailedPrecondition, "podman is not configured")
	}
	exists, err := s.Podman.ImageExists(s.baseTag(short))
	if err != nil {
		return "", status.Error(codes.Internal, err.Error())
	}
	if !exists {
		return "missing", nil
	}
	if s.baseImagesPublic() {
		return "pulled", nil
	}
	return "built", nil
}

// ensureBase makes sure the named base image exists, building it locally or
// pulling it from a public registry as appropriate, and returns the base
// definition and its fully-qualified tag.
func (s *Server) ensureBase(short string) (*imagebuild.BaseImage, string, error) {
	base, ok := imagebuild.BaseImageByID(short)
	if !ok {
		return nil, "", status.Error(codes.NotFound, "base image not found")
	}
	if s.Podman == nil {
		return nil, "", status.Error(codes.FailedPrecondition, "podman is not configured")
	}
	tag := s.baseTag(short)
	exists, err := s.Podman.ImageExists(tag)
	if err != nil {
		return nil, "", status.Error(codes.Internal, err.Error())
	}
	if exists {
		return base, tag, nil
	}
	if s.baseImagesPublic() {
		if err := s.Podman.ImagePull(tag); err != nil {
			return nil, "", status.Error(codes.Internal, err.Error())
		}
		return base, tag, nil
	}
	if s.ImageBuilder == nil {
		return nil, "", status.Error(codes.FailedPrecondition, "image builder is not configured")
	}
	spec := imagebuild.BuildSpec{ImageID: short, From: base.Primitive, PackageManager: base.PackageManager, Packages: base.Packages, IsBase: true, PostInstall: base.PostInstall, GuestAgent: s.ImageBuilder.GuestAgentImage}
	if _, err := s.ImageBuilder.Build(spec); err != nil {
		return nil, "", status.Error(codes.Internal, err.Error())
	}
	s.log().Info("auto-provisioned base image", "base_image", short, "image_tag", tag)
	return base, tag, nil
}

// resolveImage resolves a short image reference to control-plane-ready
// information. Base short names synthesize a base row (with its registry
// package manager and primitive reference); any other short name must match a
// stored custom image.
func (s *Server) resolveImage(short string) (resolvedImage, error) {
	if base, ok := imagebuild.BaseImageByID(short); ok {
		status := "missing"
		builtAt := ""
		if s.Podman != nil {
			st, err := s.baseStatus(short)
			if err != nil {
				return resolvedImage{}, err
			}
			status = st
			if status != "missing" {
				builtAt = s.Podman.ImageCreated(s.baseTag(short))
			}
		}
		return resolvedImage{ImageID: short, IsBase: true, PackageManager: base.PackageManager, ImageTag: s.baseTag(short), Primitive: base.Primitive, Packages: append([]string(nil), base.Packages...), Status: status, BuiltAt: builtAt, BasePublic: s.baseImagesPublic()}, nil
	}
	images, err := s.Store.Images()
	if err != nil {
		return resolvedImage{}, status.Error(codes.Internal, err.Error())
	}
	for _, image := range images {
		if image.ImageID == short {
			return resolvedImage{ImageID: image.ImageID, IsBase: false, PackageManager: image.PackageManager, ImageTag: image.ImageTag, Parent: image.Parent, Packages: image.Packages, BuiltAt: image.BuiltAt, Status: "built"}, nil
		}
	}
	return resolvedImage{}, status.Error(codes.NotFound, "image not found")
}

// resolveImageTag returns the fully-qualified tag for a short image
// reference, auto-provisioning base images. Custom images must be stored with
// a non-empty tag.
func (s *Server) resolveImageTag(short string) (string, error) {
	if _, ok := imagebuild.BaseImageByID(short); ok {
		_, tag, err := s.ensureBase(short)
		if err != nil {
			return "", err
		}
		return tag, nil
	}
	images, err := s.Store.Images()
	if err != nil {
		return "", status.Error(codes.Internal, err.Error())
	}
	for _, image := range images {
		if image.ImageID == short && image.ImageTag != "" {
			return image.ImageTag, nil
		}
	}
	return "", status.Error(codes.NotFound, "built image not found")
}

// resolveParent resolves a short parent reference to its fully-qualified tag
// and package manager: a base short name is ensured (built or pulled), a
// stored custom image contributes its tag and recorded package manager.
func (s *Server) resolveParent(parent string) (tag, packageManager string, err error) {
	if base, ok := imagebuild.BaseImageByID(parent); ok {
		_, tag, err := s.ensureBase(parent)
		if err != nil {
			return "", "", err
		}
		return tag, base.PackageManager, nil
	}
	images, err := s.Store.Images()
	if err != nil {
		return "", "", status.Error(codes.Internal, err.Error())
	}
	for _, image := range images {
		if image.ImageID == parent {
			if image.ImageTag == "" {
				return "", "", status.Error(codes.NotFound, fmt.Sprintf("parent image %q not found", parent))
			}
			return image.ImageTag, image.PackageManager, nil
		}
	}
	return "", "", status.Error(codes.NotFound, fmt.Sprintf("parent image %q not found", parent))
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

// grpcError maps a plain error to an Internal status error, passing through
// status errors produced by the resolution helpers unchanged.
func grpcError(err error) error {
	if code := status.Code(err); code != codes.Unknown {
		return err
	}
	return status.Error(codes.Internal, err.Error())
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

// validateEnvKey rejects a user environment variable key that is empty,
// contains '=' or a NUL byte, or collides with the reserved DSH_PODMAN
// namespace.
func validateEnvKey(key string) error {
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
	return nil
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
		if err := validateEnvKey(key); err != nil {
			return err
		}
		if strings.ContainsRune(env[key], '\x00') {
			return fmt.Errorf("env value for key %q contains a NUL byte", key)
		}
	}
	return nil
}

// validateSecretEnv validates container secret env vars (env var name to
// secret short name). Keys must satisfy validateEnvKey and values must be
// well-formed secret names. Keys are visited in sorted order so the returned
// message is deterministic.
func validateSecretEnv(secretEnv map[string]string) error {
	keys := make([]string, 0, len(secretEnv))
	for key := range secretEnv {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if err := validateEnvKey(key); err != nil {
			return err
		}
		if !secretName.MatchString(secretEnv[key]) {
			return fmt.Errorf("invalid secret name %q for env var %q", secretEnv[key], key)
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
	if kind == "secret" {
		return state.Mount{Kind: kind, Secret: mount.GetSecret(), Destination: mount.GetDestination()}
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
	case ctl.MountKind_MOUNT_KIND_SECRET:
		return "secret", nil
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
	case "secret":
		return ctl.MountKind_MOUNT_KIND_SECRET
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
		case "secret":
			// Secret mounts are applied through podmanSecrets,
			// not as OCI mounts.
			continue
		default:
			return nil, status.Error(codes.InvalidArgument, "invalid mount kind")
		}
	}
	return podmanMounts, nil
}

// podmanSecrets builds the secrets handed to podman from the stored mounts.
// Each secret mount must carry a valid short secret name and an absolute
// destination that never lands under ProjectsRoot.
func (s *Server) podmanSecrets(mounts []state.Mount) ([]specgen.Secret, error) {
	secrets := make([]specgen.Secret, 0, len(mounts))
	for _, mount := range mounts {
		if mount.Kind != "secret" {
			continue
		}
		if !secretName.MatchString(mount.Secret) {
			return nil, status.Error(codes.InvalidArgument, "invalid secret name")
		}
		if mount.Destination == "" {
			return nil, status.Error(codes.InvalidArgument, "secret mount needs a destination")
		}
		if err := nonProjectDestination(s.ProjectsRoot, mount.Destination); err != nil {
			return nil, status.Error(codes.InvalidArgument, err.Error())
		}
		secrets = append(secrets, specgen.Secret{Source: s.SecretPrefix + mount.Secret, Target: mount.Destination})
	}
	return secrets, nil
}

// containerEnvSecrets maps container secret env vars (env var name to short
// secret name) onto the podman environment secret form (env var name to the
// prefixed podman secret name).
func (s *Server) containerEnvSecrets(secretEnv map[string]string) map[string]string {
	if len(secretEnv) == 0 {
		return nil
	}
	result := make(map[string]string, len(secretEnv))
	for key, name := range secretEnv {
		result[key] = s.SecretPrefix + name
	}
	return result
}

// secretAlphabets are the character sets randomSecret may draw from.
var secretAlphabets = map[string]string{
	"alphanumeric": "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
	"hex":          "0123456789abcdef",
	"base64url":    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_",
}

// randomSecret generates a random secret of exactly length bytes drawn from
// the given charset. A zero length defaults to 32; the empty charset defaults
// to "alphanumeric". Bytes are produced with rejection sampling per byte to
// keep the distribution uniform.
func randomSecret(length int, charset string) (string, error) {
	if length == 0 {
		length = 32
	}
	if length < 1 || length > 1024 {
		return "", fmt.Errorf("invalid secret length")
	}
	if charset == "" {
		charset = "alphanumeric"
	}
	alphabet, ok := secretAlphabets[charset]
	if !ok {
		return "", fmt.Errorf("invalid secret charset")
	}
	result := make([]byte, length)
	modulus := len(alphabet)
	limit := 256 - 256%modulus
	buf := make([]byte, 1)
	for i := range result {
		for {
			if _, err := rand.Read(buf); err != nil {
				return "", fmt.Errorf("generate secret: %w", err)
			}
			if b := int(buf[0]); b < limit {
				result[i] = alphabet[b%modulus]
				break
			}
		}
	}
	return string(result), nil
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
		s.log().Warn("control request failed", "method", "RemoveContainer", "workspace_slug", request.GetWorkspaceSlug(), "container", container, "reason", "container not found")
		return nil, status.Error(codes.NotFound, "container not found")
	}
	if s.Podman == nil {
		return nil, status.Error(codes.FailedPrecondition, "podman is not configured")
	}
	s.stopContainerDaemons(context.Background(), *record)
	exists, err := s.Podman.ContainerExists(record.PodmanName)
	if err != nil {
		s.log().Error("control request failed", "method", "RemoveContainer", "workspace_slug", request.GetWorkspaceSlug(), "container", container, "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	if exists {
		if err := s.Podman.Stop(record.PodmanName); err != nil {
			s.log().Warn("RemoveContainer stop failed", "workspace_slug", request.GetWorkspaceSlug(), "container", container, "error", err)
		}
		if err := s.Podman.Remove(record.PodmanName); err != nil {
			s.log().Error("control request failed", "method", "RemoveContainer", "workspace_slug", request.GetWorkspaceSlug(), "container", container, "error", err)
			return nil, status.Error(codes.Internal, err.Error())
		}
	}
	if err := s.Store.UpdateWorkspaces(func(all []state.Workspace) ([]state.Workspace, error) {
		for i := range all {
			if all[i].WorkspaceSlug == workspace.WorkspaceSlug {
				remaining := make([]state.Container, 0, len(all[i].Containers))
				for _, c := range all[i].Containers {
					if c.Name != container {
						remaining = append(remaining, c)
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
	s.log().Info("control request completed", "method", "RemoveContainer", "workspace_slug", request.GetWorkspaceSlug(), "container", container)
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

// ListSecrets lists the orchestrator-managed secrets, exposing only their
// unprefixed short names. Secret values are never exposed to clients.
func (s *Server) ListSecrets(_ context.Context, _ *ctl.ListSecretsRequest) (*ctl.ListSecretsResponse, error) {
	s.log().Info("control request", "method", "ListSecrets")
	if s.Podman == nil {
		return nil, status.Error(codes.FailedPrecondition, "podman is not configured")
	}
	names, err := s.Podman.SecretList()
	if err != nil {
		s.log().Error("control request failed", "method", "ListSecrets", "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	result := &ctl.ListSecretsResponse{}
	for _, name := range names {
		if !strings.HasPrefix(name, s.SecretPrefix) {
			continue
		}
		result.Secrets = append(result.Secrets, &ctl.Secret{Name: name[len(s.SecretPrefix):]})
	}
	s.log().Info("control request completed", "method", "ListSecrets", "count", len(result.Secrets))
	return result, nil
}

// CreateSecret generates a random secret value and stores it under the
// orchestrator's prefix. The generated value is never logged and never
// returned to the client.
func (s *Server) CreateSecret(_ context.Context, request *ctl.CreateSecretRequest) (*ctl.Secret, error) {
	s.log().Info("control request", "method", "CreateSecret", "name", request.GetName(), "length", request.GetLength(), "charset", request.GetCharset())
	if !secretName.MatchString(request.GetName()) {
		return nil, status.Error(codes.InvalidArgument, "invalid secret name")
	}
	if length := int(request.GetLength()); length != 0 && (length < 1 || length > 1024) {
		return nil, status.Error(codes.InvalidArgument, "invalid secret length")
	}
	switch request.GetCharset() {
	case "", "alphanumeric", "hex", "base64url":
	default:
		return nil, status.Error(codes.InvalidArgument, "invalid secret charset")
	}
	if s.Podman == nil {
		return nil, status.Error(codes.FailedPrecondition, "podman is not configured")
	}
	full := s.SecretPrefix + request.GetName()
	exists, err := s.Podman.SecretExists(full)
	if err != nil {
		s.log().Error("control request failed", "method", "CreateSecret", "name", request.GetName(), "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	if exists {
		return nil, status.Error(codes.AlreadyExists, "secret already exists")
	}
	value, err := randomSecret(int(request.GetLength()), request.GetCharset())
	if err != nil {
		s.log().Error("control request failed", "method", "CreateSecret", "name", request.GetName(), "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	if err := s.Podman.SecretCreate(full, value); err != nil {
		s.log().Error("control request failed", "method", "CreateSecret", "name", request.GetName(), "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	s.log().Info("control request completed", "method", "CreateSecret", "name", request.GetName())
	return &ctl.Secret{Name: request.GetName()}, nil
}

// WriteSecretValue overwrites a secret's value with a client-supplied one
// (used by the UI to write generated values). The value is never logged.
func (s *Server) WriteSecretValue(_ context.Context, request *ctl.WriteSecretValueRequest) (*ctl.Secret, error) {
	s.log().Info("control request", "method", "WriteSecretValue", "name", request.GetName())
	if !secretName.MatchString(request.GetName()) {
		return nil, status.Error(codes.InvalidArgument, "invalid secret name")
	}
	if request.GetValue() == "" || strings.ContainsRune(request.GetValue(), '\x00') {
		return nil, status.Error(codes.InvalidArgument, "invalid secret value")
	}
	if s.Podman == nil {
		return nil, status.Error(codes.FailedPrecondition, "podman is not configured")
	}
	full := s.SecretPrefix + request.GetName()
	exists, err := s.Podman.SecretExists(full)
	if err != nil {
		s.log().Error("control request failed", "method", "WriteSecretValue", "name", request.GetName(), "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	if exists {
		if err := s.Podman.SecretRemove(full); err != nil {
			s.log().Error("control request failed", "method", "WriteSecretValue", "name", request.GetName(), "error", err)
			return nil, status.Error(codes.Internal, err.Error())
		}
	}
	if err := s.Podman.SecretCreate(full, request.GetValue()); err != nil {
		s.log().Error("control request failed", "method", "WriteSecretValue", "name", request.GetName(), "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	s.log().Info("control request completed", "method", "WriteSecretValue", "name", request.GetName())
	return &ctl.Secret{Name: request.GetName()}, nil
}

// RemoveSecret deletes a secret under the orchestrator's prefix.
func (s *Server) RemoveSecret(_ context.Context, request *ctl.RemoveSecretRequest) (*ctl.RemoveSecretResponse, error) {
	s.log().Info("control request", "method", "RemoveSecret", "name", request.GetName())
	if !secretName.MatchString(request.GetName()) {
		return nil, status.Error(codes.InvalidArgument, "invalid secret name")
	}
	if s.Podman == nil {
		return nil, status.Error(codes.FailedPrecondition, "podman is not configured")
	}
	full := s.SecretPrefix + request.GetName()
	exists, err := s.Podman.SecretExists(full)
	if err != nil {
		s.log().Error("control request failed", "method", "RemoveSecret", "name", request.GetName(), "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	if !exists {
		return nil, status.Error(codes.NotFound, "secret not found")
	}
	if err := s.Podman.SecretRemove(full); err != nil {
		s.log().Error("control request failed", "method", "RemoveSecret", "name", request.GetName(), "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	s.log().Info("control request completed", "method", "RemoveSecret", "name", request.GetName())
	return &ctl.RemoveSecretResponse{}, nil
}

// AddContainerSecret attaches an existing secret to a container as an
// environment variable and recreates the container so the change takes
// effect.
func (s *Server) AddContainerSecret(ctx context.Context, request *ctl.AddContainerSecretRequest) (*ctl.Container, error) {
	s.log().Info("control request", "method", "AddContainerSecret", "workspace_slug", request.GetWorkspaceSlug(), "container", request.GetContainer(), "env", request.GetEnv(), "secret", request.GetSecret())
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
		s.log().Warn("control request failed", "method", "AddContainerSecret", "workspace_slug", request.GetWorkspaceSlug(), "container", container, "reason", "container not found")
		return nil, status.Error(codes.NotFound, "container not found")
	}
	if err := validateEnvKey(request.GetEnv()); err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}
	if !secretName.MatchString(request.GetSecret()) {
		return nil, status.Error(codes.InvalidArgument, "invalid secret name")
	}
	if record.SecretEnv == nil {
		record.SecretEnv = map[string]string{}
	}
	if _, exists := record.SecretEnv[request.GetEnv()]; exists {
		return nil, status.Error(codes.AlreadyExists, "secret already set on this env var")
	}
	record.SecretEnv[request.GetEnv()] = request.GetSecret()
	if _, err := s.podmanMounts(record.Mounts); err != nil {
		return nil, err
	}
	if _, err := s.podmanSecrets(record.Mounts); err != nil {
		return nil, err
	}
	s.containerEnvSecrets(record.SecretEnv)
	if s.Podman == nil {
		return nil, status.Error(codes.FailedPrecondition, "podman is not configured")
	}
	imageTag, err := s.resolveImageTag(record.ImageID)
	if err != nil {
		return nil, err
	}
	secretToken, err := token.New()
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	if err := s.recreateContainer(workspace, record, imageTag, secretToken, record.Env); err != nil {
		s.log().Error("control request failed", "method", "AddContainerSecret", "workspace_slug", request.GetWorkspaceSlug(), "container", container, "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	record.Status = "running"
	record.AgentToken = secretToken
	updated, err := s.upsertContainer(workspace, *record)
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	s.log().Info("control request completed", "method", "AddContainerSecret", "workspace_slug", request.GetWorkspaceSlug(), "container", container, "env", request.GetEnv())
	return containerProto(updated, *record), nil
}

// RemoveContainerSecret detaches a secret environment variable from a
// container and recreates the container so the change takes effect.
func (s *Server) RemoveContainerSecret(ctx context.Context, request *ctl.RemoveContainerSecretRequest) (*ctl.Container, error) {
	s.log().Info("control request", "method", "RemoveContainerSecret", "workspace_slug", request.GetWorkspaceSlug(), "container", request.GetContainer(), "env", request.GetEnv())
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
		s.log().Warn("control request failed", "method", "RemoveContainerSecret", "workspace_slug", request.GetWorkspaceSlug(), "container", container, "reason", "container not found")
		return nil, status.Error(codes.NotFound, "container not found")
	}
	if err := validateEnvKey(request.GetEnv()); err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}
	if _, ok := record.SecretEnv[request.GetEnv()]; !ok {
		return nil, status.Error(codes.NotFound, "secret not found")
	}
	delete(record.SecretEnv, request.GetEnv())
	if _, err := s.podmanMounts(record.Mounts); err != nil {
		return nil, err
	}
	if _, err := s.podmanSecrets(record.Mounts); err != nil {
		return nil, err
	}
	s.containerEnvSecrets(record.SecretEnv)
	if s.Podman == nil {
		return nil, status.Error(codes.FailedPrecondition, "podman is not configured")
	}
	imageTag, err := s.resolveImageTag(record.ImageID)
	if err != nil {
		return nil, err
	}
	secretToken, err := token.New()
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	if err := s.recreateContainer(workspace, record, imageTag, secretToken, record.Env); err != nil {
		s.log().Error("control request failed", "method", "RemoveContainerSecret", "workspace_slug", request.GetWorkspaceSlug(), "container", container, "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	record.Status = "running"
	record.AgentToken = secretToken
	updated, err := s.upsertContainer(workspace, *record)
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	s.log().Info("control request completed", "method", "RemoveContainerSecret", "workspace_slug", request.GetWorkspaceSlug(), "container", container, "env", request.GetEnv())
	return containerProto(updated, *record), nil
}

func toProto(workspace state.Workspace) *ctl.Workspace {
	result := &ctl.Workspace{WorkspaceSlug: workspace.WorkspaceSlug, ContainerName: workspace.ContainerName, ImageId: workspace.ImageID, Status: workspace.Status, AgentSocketPath: workspace.AgentSocketPath, AgentToken: workspace.AgentToken, CreatedAt: workspace.CreatedAt}
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
