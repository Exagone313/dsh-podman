// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"fmt"

	"github.com/Exagone313/dsh-podman/internal/orchestrator/state"
	"github.com/opencontainers/runtime-spec/specs-go"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// projectBinds returns the bind mounts in mounts. podmanMounts emits a bind
// mount only for a project mount, so these are the project directories the
// container would reach.
func projectBinds(mounts []specs.Mount) []specs.Mount {
	var binds []specs.Mount
	for _, mount := range mounts {
		if mount.Type == "bind" {
			binds = append(binds, mount)
		}
	}
	return binds
}

// bindReadWrite reports whether a bind mount is mounted read-write.
func bindReadWrite(mount specs.Mount) bool {
	for _, option := range mount.Options {
		if option == "rw" {
			return true
		}
	}
	return false
}

// checkProjectMountConflicts refuses a new container when one of its project
// mounts and a project mount of an existing orchestrator container are nested,
// and the outer one of the pair is read-write. It applies in both directions:
// the existing container's read-write mount may be the outer one, or the new
// container's.
//
// Podman takes a path, not a file descriptor, and resolves it again whenever it
// performs the mount: on this create, and on every later start, including the
// restarts its restart policy performs on its own. A container with a
// read-write mount at a strict ancestor of another container's mount path can
// rename the next component of that path to a symlink before podman resolves
// it, redirecting the inner mount. Refusing the pair whichever container comes
// first keeps the invariant that no container can write above another
// container's mount, so neither this create nor a later restart of either
// container can be redirected. A read-only outer mount cannot be written by the
// container's own processes, so it is safe; equal mounts cannot rename their
// own root, so they are safe too.
//
// excludePodmanName is the container being created or replaced: its own mounts
// must not conflict with themselves. Until it stops, though, its processes can
// still write to its read-write mounts, so the caller stops it and resolves the
// mounts again (podmanMounts) before creating: a component swapped for a
// symlink before the stop is caught there, and after it no running container
// can write above the new mounts. The caller holds lockProjectMounts,
// so the check and the create it guards cannot interleave with another create.
func (s *Server) checkProjectMountConflicts(mounts []specs.Mount, excludePodmanName string) error {
	projects := projectBinds(mounts)
	if len(projects) == 0 {
		return nil
	}
	existing, err := s.Podman.ListContainerBindMounts(containerNamePrefix)
	if err != nil {
		return grpcError(err)
	}
	for name, binds := range existing {
		if name == excludePodmanName {
			continue
		}
		// Name the container by its logical name and workspace, never by the
		// podman name: the internal name must not reach a caller.
		slug, logical, ok := logicalContainerName(name)
		if !ok {
			continue
		}
		for _, bind := range binds {
			for _, project := range projects {
				if bindReadWrite(bind) && pathsStrictAncestor(bind.Source, project.Source) {
					return status.Error(codes.FailedPrecondition, fmt.Sprintf("project mount %q is inside the read-write mount %q of container %q in workspace %q; stop that container or mount a disjoint project", project.Source, bind.Source, logical, slug))
				}
				if bindReadWrite(project) && pathsStrictAncestor(project.Source, bind.Source) {
					return status.Error(codes.FailedPrecondition, fmt.Sprintf("read-write project mount %q contains the mount %q of container %q in workspace %q; mount it read-only, remove that container, or mount a disjoint project", project.Source, bind.Source, logical, slug))
				}
			}
		}
	}
	return nil
}

// checkExistingMountConflicts runs checkProjectMountConflicts for a container
// that already exists, against every other orchestrator container. It holds
// the project-mount lock only for the check, so it may be called under a
// per-container lock.
func (s *Server) checkExistingMountConflicts(workspace state.Workspace, record state.Container) error {
	mounts, err := s.podmanMounts(containerMounts(workspace, record))
	if err != nil {
		return err
	}
	unlock := s.lockProjectMounts()
	defer unlock()
	return s.checkProjectMountConflicts(mounts, record.PodmanName)
}
