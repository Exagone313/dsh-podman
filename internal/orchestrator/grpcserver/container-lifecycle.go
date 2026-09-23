// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"context"
	"fmt"
	"path/filepath"
	"sync"
	"time"

	ctl "github.com/Exagone313/dsh-podman/internal/genproto/dshctl/v1"
	guest "github.com/Exagone313/dsh-podman/internal/genproto/dshguest/v1"
	"github.com/Exagone313/dsh-podman/internal/orchestrator/state"
	"github.com/Exagone313/dsh-podman/internal/orchestrator/token"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
)

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

// ensureAgentToken returns the container's existing agent token, minting a
// fresh one only when the record predates token storage. Recreates keep the
// token stable so clients that cached it (the plugin's workspace binding) stay
// valid across mount, secret, and start changes.
func (s *Server) ensureAgentToken(record *state.Container) (string, error) {
	if record.AgentToken != "" {
		return record.AgentToken, nil
	}
	secret, err := token.New()
	if err != nil {
		return "", err
	}
	record.AgentToken = secret
	return secret, nil
}

// recreateContainer gracefully stops the container's daemons, then recreates
// the podman container with the given image tag and agent token, using the
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
	return s.Podman.RecreateWorkspace(podNameFor(workspace.WorkspaceSlug), record.PodmanName, imageTag, newToken, podmanMounts, secrets, envSecrets, env, record.Paths)
}

// recreateOrRestore recreates a container and, when the recreate fails,
// best-effort restores the pre-mutation snapshot so a failed mutation does not
// leave the container gone. The store is untouched here; callers persist only
// on success, and the original error is returned either way.
func (s *Server) recreateOrRestore(workspace state.Workspace, record *state.Container, imageTag, token string, snapshot *state.Container) error {
	err := s.recreateContainer(workspace, record, imageTag, token, record.Env)
	if err == nil || snapshot == nil {
		return err
	}
	s.restoreSnapshot(workspace, snapshot)
	return err
}

// restoreSnapshot best-effort recreates a container from a pre-mutation
// snapshot after a failed recreate, so a failed mutation does not leave the
// container gone. Failures are logged, never returned.
func (s *Server) restoreSnapshot(workspace state.Workspace, snapshot *state.Container) {
	if snapshot == nil {
		return
	}
	restore := *snapshot
	restoreTag, err := s.resolveImageTag(restore.ImageID)
	if err != nil {
		s.log().Warn("cannot resolve the image for a container restore", "workspace_slug", workspace.WorkspaceSlug, "container", restore.Name, "error", err)
		return
	}
	if err := s.recreateContainer(workspace, &restore, restoreTag, restore.AgentToken, restore.Env); err != nil {
		s.log().Warn("failed to restore container after failed recreate", "workspace_slug", workspace.WorkspaceSlug, "container", restore.Name, "error", err)
	}
}

// snapshotContainer deep-copies the fields a recreate mutation touches, so a
// rollback restores the pre-mutation values even when a map is mutated in
// place.
func snapshotContainer(record state.Container) state.Container {
	snapshot := record
	snapshot.Mounts = append([]state.Mount(nil), record.Mounts...)
	snapshot.Paths = append([]string(nil), record.Paths...)
	snapshot.Env = cloneMap(record.Env)
	snapshot.SecretEnv = cloneMap(record.SecretEnv)
	return snapshot
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

// EnsureContainer makes the named container usable and returns it: when the
// container is missing, stopped, or runs a guest agent from an outdated
// guest-agent image, it is recreated first. This is the single attach path for
// both the default and named containers, so a caller is never handed a stale
// agent. The guest-agent image is pulled only when it is absent.
func (s *Server) EnsureContainer(_ context.Context, request *ctl.EnsureContainerRequest) (*ctl.Container, error) {
	container := request.GetContainer()
	if container == "" {
		container = "default"
	}
	s.log().Info("control request", "method", "EnsureContainer", "workspace_slug", request.GetWorkspaceSlug(), "container", container)
	if container != "default" && !validContainerName(container) {
		return nil, status.Error(codes.InvalidArgument, fmt.Sprintf("invalid container name %q", container))
	}
	workspace, err := workspaceBySlug(s.Store, request.GetWorkspaceSlug())
	if err != nil {
		return nil, status.Error(codes.NotFound, err.Error())
	}
	record, ok := containerByLogical(&workspace, container)
	if !ok {
		s.log().Warn("control request failed", "method", "EnsureContainer", "workspace_slug", request.GetWorkspaceSlug(), "container", container, "reason", "container not found")
		return nil, containerNotFoundError(container, request.GetWorkspaceSlug())
	}
	if s.Podman == nil {
		return nil, status.Error(codes.FailedPrecondition, "podman is not configured")
	}
	usable, err := s.containerUsable(record.PodmanName)
	if err != nil {
		s.log().Error("control request failed", "method", "EnsureContainer", "workspace_slug", request.GetWorkspaceSlug(), "container", container, "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	if usable {
		s.log().Info("control request completed", "method", "EnsureContainer", "workspace_slug", workspace.WorkspaceSlug, "container", container)
		return containerProto(workspace, *record), nil
	}
	refreshed, err := s.refreshContainer(workspace, record)
	if err != nil {
		s.log().Error("control request failed", "method", "EnsureContainer", "workspace_slug", request.GetWorkspaceSlug(), "container", container, "error", err)
		return nil, err
	}
	updated, ok := containerByLogical(&refreshed, container)
	if !ok {
		return nil, status.Error(codes.Internal, fmt.Sprintf("container %q is missing after a recreate", container))
	}
	s.log().Info("control request completed", "method", "EnsureContainer", "workspace_slug", refreshed.WorkspaceSlug, "container", container)
	return containerProto(refreshed, *updated), nil
}

// containerUsable reports whether the named container is running with a current
// guest agent, i.e. can be handed to a caller without a recreate.
func (s *Server) containerUsable(name string) (bool, error) {
	running, err := s.Podman.ContainerRunning(name)
	if err != nil {
		return false, err
	}
	if !running {
		return false, nil
	}
	stale, err := s.Podman.ContainerAgentStale(name)
	if err != nil {
		return false, err
	}
	return !stale, nil
}

func (s *Server) RecreateContainer(ctx context.Context, request *ctl.RecreateContainerRequest) (*ctl.Container, error) {
	s.log().Info("control request", "method", "RecreateContainer", "workspace_slug", request.GetWorkspaceSlug(), "image_id", request.GetImageId(), "container", request.GetContainer())
	container := request.GetContainer()
	if container == "" {
		container = "default"
	}
	if container != "default" && !validContainerName(container) {
		return nil, status.Error(codes.InvalidArgument, fmt.Sprintf("invalid container name %q", container))
	}
	workspace, err := workspaceBySlug(s.Store, request.GetWorkspaceSlug())
	if err != nil {
		return nil, status.Error(codes.NotFound, err.Error())
	}
	record, ok := containerByLogical(&workspace, container)
	if !ok {
		s.log().Warn("control request failed", "method", "RecreateContainer", "workspace_slug", request.GetWorkspaceSlug(), "container", container, "reason", "container not found")
		return nil, containerNotFoundError(container, request.GetWorkspaceSlug())
	}
	snapshot := snapshotContainer(*record)
	if err := validateEnv(request.GetEnv()); err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}
	if len(request.GetEnv()) > 0 {
		record.Env = cloneMap(request.GetEnv())
	}
	// A recreate request may replace the PATH additions; without them the
	// container keeps the list it had.
	if len(request.GetPaths()) > 0 {
		paths, pathErr := validPathAdditions(request.GetPaths())
		if pathErr != nil {
			return nil, status.Error(codes.InvalidArgument, pathErr.Error())
		}
		record.Paths = paths
	}
	if len(request.GetMounts()) > 0 {
		mounts, mountErr := stateMounts(request.GetMounts())
		if mountErr != nil {
			return nil, status.Error(codes.InvalidArgument, mountErr.Error())
		}
		record.Mounts = mounts
	} else {
		record.Mounts = containerMounts(workspace, *record)
	}
	if container == "default" {
		record.Mounts = ensureWorkspaceProjectMount(record.Mounts, workspace)
	}
	if _, err := s.podmanMounts(record.Mounts); err != nil {
		s.log().Error("RecreateContainer project validation failed", "workspace_slug", workspace.WorkspaceSlug, "error", err)
		return nil, err
	}
	if _, err := s.podmanSecrets(record.Mounts); err != nil {
		s.log().Error("RecreateContainer secret validation failed", "workspace_slug", workspace.WorkspaceSlug, "error", err)
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
	if err := s.validateSecretReferences(record.SecretEnv, record.Mounts); err != nil {
		return nil, err
	}
	secret, err := s.ensureAgentToken(record)
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	if err := s.recreateOrRestore(workspace, record, imageTag, secret, &snapshot); err != nil {
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
	return containerProto(updated, *record), nil
}

func (s *Server) StartContainer(ctx context.Context, request *ctl.StartContainerRequest) (*ctl.Container, error) {
	s.log().Info("control request", "method", "StartContainer", "workspace_slug", request.GetWorkspaceSlug(), "container", request.GetContainer(), "image_id", request.GetImageId(), "mount_count", len(request.GetMounts()))
	container := request.GetContainer()
	if container == "" {
		container = "default"
	}
	if container != "default" && !validContainerName(container) {
		return nil, status.Error(codes.InvalidArgument, fmt.Sprintf("invalid container name %q", container))
	}
	workspace, err := workspaceBySlug(s.Store, request.GetWorkspaceSlug())
	if err != nil {
		return nil, status.Error(codes.NotFound, err.Error())
	}
	imageID := request.GetImageId()
	if imageID == "" {
		imageID = defaultImageShort()
	}
	recordMounts := []state.Mount(nil)
	if container == "default" {
		recordMounts = workspace.Mounts
	}
	if existing, ok := containerByLogical(&workspace, container); ok && len(request.GetMounts()) == 0 {
		// Restarting an existing container keeps its current mounts unless
		// the request replaces them.
		recordMounts = containerMounts(workspace, *existing)
	}
	if len(request.GetMounts()) > 0 {
		mounts, mountErr := stateMounts(request.GetMounts())
		if mountErr != nil {
			return nil, status.Error(codes.InvalidArgument, mountErr.Error())
		}
		recordMounts = mounts
	}
	if container == "default" {
		recordMounts = ensureWorkspaceProjectMount(recordMounts, workspace)
	}
	record := state.Container{Name: container, PodmanName: podmanContainerName(workspace.WorkspaceSlug, container), ImageID: imageID, Mounts: recordMounts}
	if existing, ok := containerByLogical(&workspace, container); ok {
		// Replacing a container keeps its PATH additions, environment, and
		// secret environment; an omitted map cannot express a clear.
		record.Paths = append([]string(nil), existing.Paths...)
		record.Env = cloneMap(existing.Env)
		record.SecretEnv = cloneMap(existing.SecretEnv)
	}
	// A start request may replace the PATH additions; without them a replaced
	// container keeps the list it had.
	if len(request.GetPaths()) > 0 {
		paths, pathErr := validPathAdditions(request.GetPaths())
		if pathErr != nil {
			return nil, status.Error(codes.InvalidArgument, pathErr.Error())
		}
		record.Paths = paths
	}
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
	// A start request may replace the environment and secret environment;
	// without them the replaced container keeps what it had, matching mounts
	// and PATH additions.
	if len(request.GetSecretEnv()) > 0 {
		record.SecretEnv = cloneMap(request.GetSecretEnv())
	}
	if err := validateSecretEnv(record.SecretEnv); err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}
	envSecrets := s.containerEnvSecrets(record.SecretEnv)
	if err := validateEnv(request.GetEnv()); err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}
	if len(request.GetEnv()) > 0 {
		record.Env = cloneMap(request.GetEnv())
	}
	imageTag, err := s.resolveImageTag(imageID)
	if err != nil {
		return nil, err
	}
	if s.Podman == nil {
		return nil, status.Error(codes.FailedPrecondition, "podman is not configured")
	}
	if err := s.validateSecretReferences(record.SecretEnv, recordMounts); err != nil {
		return nil, err
	}
	var existingSnapshot *state.Container
	if existing, ok := containerByLogical(&workspace, request.GetContainer()); ok {
		snapshot := snapshotContainer(*existing)
		existingSnapshot = &snapshot
		s.stopContainerDaemons(context.Background(), *existing)
		record.AgentToken = existing.AgentToken
		if err := s.Podman.Stop(existing.PodmanName); err != nil {
			s.log().Warn("StartContainer replace stop failed", "workspace_slug", workspace.WorkspaceSlug, "container", request.GetContainer(), "error", err)
		}
		if err := s.Podman.Remove(record.PodmanName); err != nil {
			s.log().Error("control request failed", "method", "StartContainer", "workspace_slug", workspace.WorkspaceSlug, "container", request.GetContainer(), "error", err)
			return nil, status.Error(codes.Internal, err.Error())
		}
	} else {
		// No stored record owns the derived name, but a podman container may
		// still exist (an earlier create failed after making it, or it was
		// removed outside dsh-podman). Drop it so the create below is not
		// blocked by an untracked container.
		untracked, existsErr := s.Podman.ContainerExists(record.PodmanName)
		if existsErr != nil {
			return nil, status.Error(codes.Internal, existsErr.Error())
		}
		if untracked {
			s.log().Warn("StartContainer removing untracked container", "workspace_slug", workspace.WorkspaceSlug, "container", request.GetContainer(), "podman_name", record.PodmanName)
			if err := s.Podman.Remove(record.PodmanName); err != nil {
				s.log().Error("control request failed", "method", "StartContainer", "workspace_slug", workspace.WorkspaceSlug, "container", request.GetContainer(), "error", err)
				return nil, status.Error(codes.Internal, err.Error())
			}
		}
	}
	secret, err := s.ensureAgentToken(&record)
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	if err := s.Podman.CreateWorkspace(podNameFor(workspace.WorkspaceSlug), record.PodmanName, imageTag, secret, podmanMounts, secrets, envSecrets, record.Env, record.Paths); err != nil {
		// A failed create may have left a container behind; remove it so a retry
		// is not blocked by a stale name, then restore the container this call
		// replaced (when there was one).
		if removeErr := s.Podman.Remove(record.PodmanName); removeErr != nil {
			s.log().Warn("StartContainer cleanup after create failure failed", "workspace_slug", workspace.WorkspaceSlug, "container", request.GetContainer(), "error", removeErr)
		}
		s.restoreSnapshot(workspace, existingSnapshot)
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

func (s *Server) RemoveContainer(_ context.Context, request *ctl.RemoveContainerRequest) (*ctl.RemoveContainerResponse, error) {
	s.log().Info("control request", "method", "RemoveContainer", "workspace_slug", request.GetWorkspaceSlug(), "container", request.GetContainer())
	container := request.GetContainer()
	if container == "" {
		container = "default"
	}
	if container != "default" && !validContainerName(container) {
		return nil, status.Error(codes.InvalidArgument, fmt.Sprintf("invalid container name %q", container))
	}
	workspace, err := workspaceBySlug(s.Store, request.GetWorkspaceSlug())
	if err != nil {
		return nil, status.Error(codes.NotFound, err.Error())
	}
	record, ok := containerByLogical(&workspace, container)
	if !ok {
		// The stored record may already be gone (reconciled after a failed
		// create) while an untracked podman container survives. Remove it so an
		// orphan is cleanable; otherwise report not found.
		if s.Podman == nil {
			return nil, containerNotFoundError(container, request.GetWorkspaceSlug())
		}
		podmanName := podmanContainerName(workspace.WorkspaceSlug, container)
		orphan, existsErr := s.Podman.ContainerExists(podmanName)
		if existsErr != nil {
			return nil, status.Error(codes.Internal, existsErr.Error())
		}
		if !orphan {
			s.log().Warn("control request failed", "method", "RemoveContainer", "workspace_slug", request.GetWorkspaceSlug(), "container", container, "reason", "container not found")
			return nil, containerNotFoundError(container, request.GetWorkspaceSlug())
		}
		s.log().Warn("RemoveContainer removing untracked container", "workspace_slug", workspace.WorkspaceSlug, "container", container, "podman_name", podmanName)
		if err := s.Podman.Stop(podmanName); err != nil {
			s.log().Warn("RemoveContainer stop failed", "workspace_slug", request.GetWorkspaceSlug(), "container", container, "error", err)
		}
		if err := s.Podman.Remove(podmanName); err != nil {
			s.log().Error("control request failed", "method", "RemoveContainer", "workspace_slug", request.GetWorkspaceSlug(), "container", container, "error", err)
			return nil, status.Error(codes.Internal, err.Error())
		}
		s.removeSocketDir(podmanName)
		s.removePodIfEmpty(workspace.WorkspaceSlug)
		return &ctl.RemoveContainerResponse{}, nil
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
	s.removeSocketDir(record.PodmanName)
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
	s.removePodIfEmpty(workspace.WorkspaceSlug)
	s.log().Info("control request completed", "method", "RemoveContainer", "workspace_slug", request.GetWorkspaceSlug(), "container", container)
	return &ctl.RemoveContainerResponse{}, nil
}
