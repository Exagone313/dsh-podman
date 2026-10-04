// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"fmt"

	"github.com/opencontainers/runtime-spec/specs-go"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// bindSources returns the host source paths of the bind mounts in mounts.
// podmanMounts emits a bind mount only for a project mount, so these are the
// project directories the container would reach.
func bindSources(mounts []specs.Mount) []string {
	var sources []string
	for _, mount := range mounts {
		if mount.Type == "bind" {
			sources = append(sources, mount.Source)
		}
	}
	return sources
}

// checkProjectMountConflicts refuses a new container when an existing
// orchestrator container holds a read-write mount that is a strict ancestor of
// one of its project mounts.
//
// Podman takes a path, not a file descriptor, and resolves it again when it
// performs the mount. A container with a read-write mount at an ancestor of a
// new mount path can therefore rename the next component of that path to a
// symlink between validation and podman's resolution, redirecting the new
// mount. A read-only mount cannot be written by the container's own processes,
// so it is safe; a mount at the new path itself, or below it, cannot rename an
// ancestor of its own root, so it is safe too. Only the read-write strict
// ancestor is refused.
//
// excludePodmanName is the container being created or replaced: its own mounts
// must not conflict with themselves. The caller holds lockProjectMounts, so the
// check and the create it guards cannot interleave with another create.
func (s *Server) checkProjectMountConflicts(mounts []specs.Mount, excludePodmanName string) error {
	projectSources := bindSources(mounts)
	if len(projectSources) == 0 {
		return nil
	}
	existing, err := s.Podman.ListContainerWriteMounts(containerNamePrefix)
	if err != nil {
		return grpcError(err)
	}
	for name, sources := range existing {
		if name == excludePodmanName || !containerPodmanName.MatchString(name) {
			continue
		}
		for _, source := range sources {
			for _, project := range projectSources {
				if pathsStrictAncestor(source, project) {
					return status.Error(codes.FailedPrecondition, fmt.Sprintf("project mount %q is inside the read-write mount %q of container %q; stop that container or mount a disjoint project", project, source, name))
				}
			}
		}
	}
	return nil
}
