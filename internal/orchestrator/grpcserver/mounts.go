// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	ctl "github.com/Exagone313/dsh-podman/internal/genproto/dshctl/v1"
	"github.com/Exagone313/dsh-podman/internal/orchestrator/state"
	"github.com/opencontainers/runtime-spec/specs-go"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// AddContainerMount adds a project, tmpfs, or named-volume mount to a
// container's mount list and recreates the podman container so the change
// takes effect.
func (s *Server) AddContainerMount(ctx context.Context, request *ctl.AddContainerMountRequest) (*ctl.Container, error) {
	s.log().Info("control request", "method", "AddContainerMount", "workspace_slug", request.GetWorkspaceSlug(), "container", request.GetContainer(), "project", request.GetProject(), "path", request.GetPath(), "kind", request.GetKind(), "volume", request.GetVolume())
	workspace, err := workspaceBySlug(s.Store, request.GetWorkspaceSlug())
	if err != nil {
		return nil, status.Error(codes.NotFound, err.Error())
	}
	record, ok := containerByLogical(&workspace, request.GetContainer())
	if !ok {
		s.log().Warn("control request failed", "method", "AddContainerMount", "workspace_slug", request.GetWorkspaceSlug(), "container", request.GetContainer(), "reason", "container not found")
		return nil, containerNotFoundError(request.GetContainer(), request.GetWorkspaceSlug())
	}
	snapshot := snapshotContainer(*record)
	kind, err := mountKindFromProto(request.GetKind())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}
	// Secret mounts carry no mode; every other kind requires one.
	mode := ""
	if kind != "secret" {
		if mode, err = mountModeFromProto(request.GetMode()); err != nil {
			return nil, status.Error(codes.InvalidArgument, err.Error())
		}
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
	case "secret":
		if !secretName.MatchString(request.GetSecret()) {
			return nil, status.Error(codes.InvalidArgument, fmt.Sprintf("invalid secret name %q", request.GetSecret()))
		}
		newMount = state.Mount{Kind: "secret", Secret: request.GetSecret(), Destination: request.GetDestination()}
	default:
		// Unreachable while mountKindFromProto is exhaustive, and kept so a
		// new kind cannot silently append a zero-valued mount.
		return nil, status.Error(codes.InvalidArgument, fmt.Sprintf("invalid mount kind %q", kind))
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
			duplicate = existing.Kind == "volume" && existing.Volume == newMount.Volume && existing.Destination == newMount.Destination
		case "secret":
			duplicate = existing.Kind == "secret" && existing.Destination == newMount.Destination
		}
		if duplicate {
			return nil, status.Error(codes.AlreadyExists, fmt.Sprintf("mount already exists: %s", mountLabel(newMount)))
		}
	}
	record.Mounts = append(append([]state.Mount(nil), effective...), newMount)
	if _, err := s.podmanMounts(record.Mounts); err != nil {
		s.log().Error("AddContainerMount project validation failed", "workspace_slug", workspace.WorkspaceSlug, "error", err)
		return nil, err
	}
	if _, err := s.podmanSecrets(record.Mounts); err != nil {
		s.log().Error("AddContainerMount secret validation failed", "workspace_slug", workspace.WorkspaceSlug, "error", err)
		return nil, err
	}
	if s.Podman == nil {
		return nil, status.Error(codes.FailedPrecondition, "podman is not configured")
	}
	if err := s.validateSecretReferences(nil, record.Mounts); err != nil {
		return nil, err
	}
	imageTag, err := s.resolveImageTag(record.ImageID)
	if err != nil {
		return nil, err
	}
	secret, err := s.ensureAgentToken(record)
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	if err := s.recreateOrRestore(workspace, record, imageTag, secret, &snapshot); err != nil {
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
		return nil, status.Error(codes.NotFound, err.Error())
	}
	record, ok := containerByLogical(&workspace, request.GetContainer())
	if !ok {
		s.log().Warn("control request failed", "method", "RemoveContainerMount", "workspace_slug", request.GetWorkspaceSlug(), "container", request.GetContainer(), "reason", "container not found")
		return nil, containerNotFoundError(request.GetContainer(), request.GetWorkspaceSlug())
	}
	snapshot := snapshotContainer(*record)
	kind, err := mountKindFromProto(request.GetKind())
	if err != nil {
		return nil, status.Error(codes.InvalidArgument, err.Error())
	}
	if !knownMountKind(kind) {
		return nil, status.Error(codes.InvalidArgument, fmt.Sprintf("invalid mount kind %q", kind))
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
			// The volume names the mount; a supplied destination must agree, so
			// the same volume at two destinations stays distinguishable.
			matched = existing.Kind == "volume" && existing.Volume == request.GetVolume()
			if matched && request.GetDestination() != "" {
				matched = existing.Destination == request.GetDestination()
			}
		case "secret":
			// The destination identifies the mount; the secret name, when
			// given, must agree.
			matched = existing.Kind == "secret" && existing.Destination == request.GetDestination()
			if matched && request.GetSecret() != "" {
				matched = existing.Secret == request.GetSecret()
			}
		}
		if matched {
			index = i
			break
		}
	}
	if index < 0 {
		s.log().Warn("control request failed", "method", "RemoveContainerMount", "workspace_slug", request.GetWorkspaceSlug(), "container", request.GetContainer(), "reason", "mount not found")
		return nil, status.Error(codes.NotFound, fmt.Sprintf("mount not found: %s", mountLabel(state.Mount{Kind: kind, ProjectName: request.GetProject(), Path: request.GetPath(), Volume: request.GetVolume(), Secret: request.GetSecret(), Destination: request.GetDestination()})))
	}
	if record.Name == "default" && isWorkspaceProjectMount(workspace, effective[index]) {
		return nil, status.Error(codes.FailedPrecondition, "the default container keeps the workspace project mount")
	}
	record.Mounts = append(append([]state.Mount(nil), effective[:index]...), effective[index+1:]...)
	if _, err := s.podmanMounts(record.Mounts); err != nil {
		s.log().Error("RemoveContainerMount project validation failed", "workspace_slug", workspace.WorkspaceSlug, "error", err)
		return nil, err
	}
	if _, err := s.podmanSecrets(record.Mounts); err != nil {
		s.log().Error("RemoveContainerMount secret validation failed", "workspace_slug", workspace.WorkspaceSlug, "error", err)
		return nil, err
	}
	if s.Podman == nil {
		return nil, status.Error(codes.FailedPrecondition, "podman is not configured")
	}
	if err := s.validateSecretReferences(record.SecretEnv, record.Mounts); err != nil {
		return nil, err
	}
	imageTag, err := s.resolveImageTag(record.ImageID)
	if err != nil {
		return nil, err
	}
	secret, err := s.ensureAgentToken(record)
	if err != nil {
		return nil, status.Error(codes.Internal, err.Error())
	}
	if err := s.recreateOrRestore(workspace, record, imageTag, secret, &snapshot); err != nil {
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

// containerMounts returns the mounts that apply to a container: its own list
// when present, otherwise the workspace's default mounts — for the default
// container only. Named containers carry exactly the mounts they were given;
// an empty list means no mounts.
func containerMounts(ws state.Workspace, c state.Container) []state.Mount {
	if len(c.Mounts) > 0 {
		return c.Mounts
	}
	if c.Name == "" || c.Name == "default" {
		return ws.Mounts
	}
	return nil
}

// isWorkspaceProjectMount reports whether mount is the workspace's primary
// project mount: the project-kind mount at the workspace's project directory
// root. The default container always keeps it.
func isWorkspaceProjectMount(ws state.Workspace, mount state.Mount) bool {
	return ws.ProjectName != "" && mount.Kind == "" && mount.ProjectName == ws.ProjectName && mount.Path == ""
}

// ensureWorkspaceProjectMount returns mounts with the workspace's primary
// project mount present, appending it read-write when missing. It is a no-op
// when the workspace has no project name.
func ensureWorkspaceProjectMount(mounts []state.Mount, ws state.Workspace) []state.Mount {
	if ws.ProjectName == "" {
		return mounts
	}
	for _, mount := range mounts {
		if isWorkspaceProjectMount(ws, mount) {
			return mounts
		}
	}
	return append(append([]state.Mount(nil), mounts...), state.Mount{ProjectName: ws.ProjectName, Mode: "read_write"})
}

// stateMounts projects the control plane's project mounts onto the state
// model's read_only/read_write representation, rejecting the whole list when
// any mount is malformed.
func stateMounts(mounts []*ctl.ProjectMount) ([]state.Mount, error) {
	result := make([]state.Mount, 0, len(mounts))
	for _, mount := range mounts {
		converted, err := mountFromProto(mount)
		if err != nil {
			return nil, err
		}
		result = append(result, converted)
	}
	return result, nil
}

// mountFromProto maps a control plane project mount onto its state
// representation.
//
// An unrecognised kind or mode is an error rather than a default. Protobuf
// keeps unknown enum numbers as-is on the wire, so coercing them would turn a
// value this build does not understand into a project mount, or an
// unspecified mode into a silent read_only, instead of telling the client.
// Secret mounts are the one kind that carries no mode.
func mountFromProto(mount *ctl.ProjectMount) (state.Mount, error) {
	kind, err := mountKindFromProto(mount.GetKind())
	if err != nil {
		return state.Mount{}, err
	}
	if kind == "secret" {
		return state.Mount{Kind: kind, Secret: mount.GetSecret(), Destination: mount.GetDestination()}, nil
	}
	mode, err := mountModeFromProto(mount.GetMode())
	if err != nil {
		return state.Mount{}, err
	}
	return state.Mount{ProjectName: mount.GetProjectName(), Path: mount.GetPath(), Destination: mount.GetDestination(), Mode: mode, Kind: kind, Volume: mount.GetVolume()}, nil
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
		return "", fmt.Errorf("invalid mount kind %q", kind.String())
	}
}

// knownMountKind reports whether kind is a mount kind the server handles.
func knownMountKind(kind string) bool {
	switch kind {
	case "", "tmpfs", "volume", "secret":
		return true
	}
	return false
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
		return "", fmt.Errorf("invalid mount mode %q", mode.String())
	}
}

// validProjectName reports whether name is an acceptable project name: a
// non-empty, relative, lexically clean path with no "." or ".." segments and
// no NUL byte. It is a purely lexical check; existence and confinement are
// established by resolveDirUnderRoot.
func validProjectName(name string) bool {
	if name == "" || strings.ContainsRune(name, '\x00') || filepath.IsAbs(name) {
		return false
	}
	clean := filepath.Clean(filepath.FromSlash(name))
	if clean != filepath.FromSlash(name) {
		return false
	}
	return clean != "." && clean != ".." && !strings.HasPrefix(clean, ".."+string(filepath.Separator))
}

// resolveDirUnderRoot resolves rel beneath root and returns both the resolved
// root and the resolved directory. Resolution follows symlinks but is
// confined to root: a component escaping it, through a symlink or otherwise,
// is an error. rel must already be lexically clean and relative.
//
// The confinement decision is made by os.Root, which on Linux resolves the
// path with openat2(RESOLVE_BENEATH) in a single step and so cannot be raced
// into accepting a path that never existed as a whole.  EvalSymlinks only
// produces the resolved string, cross-checked against the resolved root.
func resolveDirUnderRoot(root, rel string) (resolvedRoot, resolved string, err error) {
	handle, err := os.OpenRoot(root)
	if err != nil {
		return "", "", err
	}
	defer handle.Close()
	target := rel
	if target == "" {
		target = "."
	}
	info, err := handle.Stat(target)
	if err != nil {
		return "", "", err
	}
	if !info.IsDir() {
		return "", "", fmt.Errorf("%q is not a directory", rel)
	}
	resolvedRoot, err = filepath.EvalSymlinks(root)
	if err != nil {
		return "", "", err
	}
	resolved, err = filepath.EvalSymlinks(filepath.Join(resolvedRoot, rel))
	if err != nil {
		return "", "", err
	}
	if resolved != resolvedRoot && !strings.HasPrefix(resolved, withSeparator(resolvedRoot)) {
		return "", "", fmt.Errorf("%q escapes %q", rel, root)
	}
	return resolvedRoot, resolved, nil
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

// reservedDestinations lists the container paths a mount must not shadow: the
// projects root, which is reserved for project mounts; the socket directory,
// which carries the guest agent's socket; and the directory the guest agent
// binary is mounted at, whose contents the container executes as its entry
// point.
func (s *Server) reservedDestinations() []string {
	return []string{s.ProjectsRoot, s.SocketsRoot, s.GuestAgentMount}
}

// withSeparator returns path with a trailing separator, so that prefix
// comparisons match whole path components. The filesystem root already ends
// in a separator and must not gain a second one.
func withSeparator(path string) string {
	if strings.HasSuffix(path, string(filepath.Separator)) {
		return path
	}
	return path + string(filepath.Separator)
}

// pathsOverlap reports whether two absolute, cleaned paths are equal or
// whether either contains the other.
func pathsOverlap(a, b string) bool {
	return a == b || strings.HasPrefix(a, withSeparator(b)) || strings.HasPrefix(b, withSeparator(a))
}

// nonProjectDestination validates a tmpfs, named-volume, or secret mount
// destination: it must be absolute and already cleaned (filepath.Clean
// equality precludes ".." segments, redundant separators, and trailing
// slashes), and it must not overlap any reserved path.
//
// Ancestors are rejected as well as descendants. Podman orders mounts by
// depth, so a mount above a reserved path does not shadow it directly, but a
// destination such as "/" would hide every reserved path beneath it.
func (s *Server) nonProjectDestination(dest string) error {
	if !filepath.IsAbs(dest) {
		return fmt.Errorf("invalid mount destination %q", dest)
	}
	cleaned := filepath.Clean(dest)
	if cleaned != dest {
		return fmt.Errorf("invalid mount destination %q", dest)
	}
	for _, reserved := range s.reservedDestinations() {
		if reserved == "" {
			continue
		}
		root := filepath.Clean(reserved)
		if !filepath.IsAbs(root) {
			continue
		}
		if pathsOverlap(cleaned, root) {
			return fmt.Errorf("mount destination %q overlaps the reserved path %q", cleaned, root)
		}
	}
	return nil
}

// resolveMount resolves a single stored mount to its host source path and its
// container destination path, validating the project, the subpath, and (when
// set) the destination. The empty destination defaults to a mirror of the host
// source under projectsRoot.
//
// The project and its subpath are resolved through symlinks and confined to
// projectsRoot, so a symlink planted inside a writable project cannot make
// podman bind-mount a path outside the projects root. Note that podman
// resolves the source again, in the host's mount namespace, when it performs
// the mount: the source handed to it is the resolved path precisely because
// every component was a real directory at validation time, so redirecting the
// mount afterwards means replacing a directory with a symlink (rmdir refuses
// a non-empty directory) rather than repointing an existing symlink. That
// narrows the race; it does not remove it, and it cannot be removed from here
// while podman takes a path rather than a file descriptor.
func resolveMount(projectsRoot, hostProjectsRoot string, mount state.Mount) (hostPath, destination string, err error) {
	if !validProjectName(mount.ProjectName) {
		return "", "", fmt.Errorf("invalid project name %q", mount.ProjectName)
	}
	if !validMountSubpath(mount.Path) {
		return "", "", fmt.Errorf("invalid mount path %q", mount.Path)
	}
	subpath := filepath.FromSlash(mount.Path)
	resolvedRoot, resolved, err := resolveDirUnderRoot(projectsRoot, filepath.Join(filepath.FromSlash(mount.ProjectName), subpath))
	if err != nil {
		return "", "", fmt.Errorf("mount path %q does not exist under project %q", mount.Path, mount.ProjectName)
	}
	// hostProjectsRoot names the same tree as projectsRoot in the host's
	// mount namespace, so the resolved path is re-expressed relative to the
	// resolved root before being joined onto it.
	hostPath = resolved
	if hostProjectsRoot != "" {
		relative, relErr := filepath.Rel(resolvedRoot, resolved)
		if relErr != nil {
			return "", "", fmt.Errorf("mount path %q does not exist under project %q", mount.Path, mount.ProjectName)
		}
		hostPath = filepath.Join(hostProjectsRoot, relative)
	}
	// The destination mirrors the requested path rather than the resolved
	// one: the container-side path must stay stable when a project contains
	// an internal symlink, or the plugin and the guest agent would disagree
	// about where the files are. Project mounts never take a caller-supplied
	// destination; the fixed location below is the only one used.
	destination = filepath.Join(projectsRoot, mount.ProjectName, subpath)
	if mount.Destination != "" {
		return "", "", fmt.Errorf("project mounts do not accept a destination; the directory will be mounted at %s", destination)
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
			if err := s.nonProjectDestination(mount.Destination); err != nil {
				return nil, status.Error(codes.InvalidArgument, err.Error())
			}
			podmanMounts = append(podmanMounts, specs.Mount{Type: "tmpfs", Destination: mount.Destination, Options: []string{"rw"}})
		case "volume":
			if !volumeName.MatchString(mount.Volume) {
				return nil, status.Error(codes.InvalidArgument, fmt.Sprintf("invalid volume name %q", mount.Volume))
			}
			if err := s.nonProjectDestination(mount.Destination); err != nil {
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
			return nil, status.Error(codes.InvalidArgument, fmt.Sprintf("invalid mount kind %q", mount.Kind))
		}
	}
	return podmanMounts, nil
}

// ValidateProject resolves a project name to its real directory under root.
// The name must be lexically clean and relative, and the directory it names
// must resolve, through any symlinks, to a path confined to root.
func ValidateProject(root, name string) (string, error) {
	if !validProjectName(name) {
		return "", fmt.Errorf("invalid project name %q", name)
	}
	_, resolved, err := resolveDirUnderRoot(root, filepath.FromSlash(name))
	if err != nil {
		return "", fmt.Errorf("project %q does not exist under %q", name, root)
	}
	return resolved, nil
}
