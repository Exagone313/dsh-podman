// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"fmt"
	"regexp"

	"github.com/Exagone313/dsh-podman/internal/orchestrator/state"
	"google.golang.org/grpc/codes"
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

// containerNotFoundError is the one not-found shape every container control
// call reports, matching the plugin's read tools. An empty name is normalized
// to "default" so the message always names a container.
func containerNotFoundError(container, slug string) error {
	if container == "" {
		container = "default"
	}
	return status.Error(codes.NotFound, fmt.Sprintf("container %q not found in workspace %q", container, slug))
}

// mountLabel names a stored mount for error messages: a project mount by its
// project and optional subpath, every other kind by its destination and (when
// present) the volume or secret it draws from.
func mountLabel(mount state.Mount) string {
	at := ""
	if mount.Destination != "" {
		at = fmt.Sprintf(" at %q", mount.Destination)
	}
	switch mount.Kind {
	case "", "project":
		label := fmt.Sprintf("project %q", mount.ProjectName)
		if mount.Path != "" {
			label += fmt.Sprintf(" path %q", mount.Path)
		}
		return label
	case "volume":
		return fmt.Sprintf("volume %q%s", mount.Volume, at)
	case "secret":
		return fmt.Sprintf("secret %q%s", mount.Secret, at)
	default:
		return fmt.Sprintf("tmpfs%s", at)
	}
}

// workspaceBySlug returns the stored workspace with the given slug, or an
// error naming the missing workspace when absent.
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
	return state.Workspace{}, fmt.Errorf("workspace %q not found", slug)
}
