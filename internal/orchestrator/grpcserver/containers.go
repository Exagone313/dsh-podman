// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"context"
	"sort"

	ctl "github.com/Exagone313/dsh-podman/internal/genproto/dshctl/v1"
	"github.com/Exagone313/dsh-podman/internal/orchestrator/state"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

func (s *Server) ListContainers(context.Context, *ctl.ListContainersRequest) (*ctl.ListContainersResponse, error) {
	s.log().Info("control request", "method", "ListContainers")
	workspaces, err := s.Store.Workspaces()
	if err != nil {
		s.log().Error("control request failed", "method", "ListContainers", "error", err)
		return nil, status.Error(codes.Internal, err.Error())
	}
	// The listing is a pure view: stored containers whose podman container no
	// longer exists are hidden and statuses are refreshed in memory. Nothing is
	// written, so listing (or opening the settings card) cannot change state.
	if s.Podman != nil {
		workspaces, _ = s.containerView(workspaces, s.Podman.ContainerExists, s.Podman.ContainerRunning)
	}
	containers := containerRows(workspaces)
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
	row := &ctl.Container{ContainerName: c.Name, PodmanName: c.PodmanName, WorkspaceSlug: ws.WorkspaceSlug, ImageId: c.ImageID, Status: c.Status, CreatedAt: c.CreatedAt, AgentSocketPath: c.AgentSocketPath, AgentToken: c.AgentToken, Env: cloneMap(c.Env), SecretEnv: cloneMap(c.SecretEnv), Paths: append([]string(nil), c.Paths...)}
	for _, mount := range containerMounts(ws, c) {
		mode := ctl.MountMode_MOUNT_MODE_READ_ONLY
		if mount.Mode == "read_write" {
			mode = ctl.MountMode_MOUNT_MODE_READ_WRITE
		}
		row.Mounts = append(row.Mounts, &ctl.ProjectMount{ProjectName: mount.ProjectName, Destination: mount.Destination, Mode: mode, Kind: mountKindToProto(mount.Kind), Volume: mount.Volume, Secret: mount.Secret})
	}
	return row
}

// containerRows projects stored workspace containers onto the control plane's
// Container messages. It is state-driven: every stored container is included
// with its stored status.
func containerRows(workspaces []state.Workspace) []*ctl.Container {
	result := make([]*ctl.Container, 0, len(workspaces))
	for _, ws := range workspaces {
		for _, container := range ws.Containers {
			result = append(result, containerProto(ws, container))
		}
	}
	return result
}

// containerView returns the live view of the stored workspaces: containers
// whose podman container no longer exists are hidden, and each surviving
// container's status is refreshed from the run state. It never writes, so read
// paths stay stateless; changed reports whether the view differs from the
// stored workspaces, letting a mutating caller persist the reconciliation.
func (s *Server) containerView(workspaces []state.Workspace, exists func(podmanName string) (bool, error), running func(podmanName string) (bool, error)) ([]state.Workspace, bool) {
	changed := false
	next := make([]state.Workspace, 0, len(workspaces))
	for _, ws := range workspaces {
		kept := make([]state.Container, 0, len(ws.Containers))
		for _, container := range ws.Containers {
			found, lookupErr := exists(container.PodmanName)
			if lookupErr != nil {
				s.log().Warn("podman container lookup failed", "podman_name", container.PodmanName, "error", lookupErr)
				kept = append(kept, container)
				continue
			}
			if !found {
				s.log().Info("container deleted outside dsh-podman", "workspace_slug", ws.WorkspaceSlug, "container", container.Name, "podman_name", container.PodmanName)
				changed = true
				continue
			}
			if running != nil {
				isRunning, runErr := running(container.PodmanName)
				if runErr != nil {
					s.log().Warn("podman container inspect failed", "podman_name", container.PodmanName, "error", runErr)
				} else {
					status := "stopped"
					if isRunning {
						status = "running"
					}
					if container.Status != status {
						container.Status = status
						changed = true
					}
				}
			}
			kept = append(kept, container)
		}
		if len(kept) == 0 {
			s.log().Info("workspace has no containers left in podman", "workspace_slug", ws.WorkspaceSlug)
			changed = true
			continue
		}
		ws.Containers = kept
		syncDefaultFields(&ws)
		next = append(next, ws)
	}
	return next, changed
}

// reconcileContainers persists the live view: it drops stored containers whose
// podman container no longer exists (for example deleted outside dsh-podman)
// and refreshes each surviving container's status. Only mutating paths call it
// (the removal guards), so a dead record neither blocks a removal nor lingers;
// read paths use containerView. When nothing changed, the input is returned
// unwritten.
func (s *Server) reconcileContainers(workspaces []state.Workspace, exists func(podmanName string) (bool, error), running func(podmanName string) (bool, error)) ([]state.Workspace, error) {
	next, changed := s.containerView(workspaces, exists, running)
	if !changed {
		return workspaces, nil
	}
	if err := s.Store.UpdateWorkspaces(func([]state.Workspace) ([]state.Workspace, error) {
		return next, nil
	}); err != nil {
		return nil, err
	}
	return next, nil
}
