// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/Exagone313/dsh-podman/internal/orchestrator/state"
	"github.com/opencontainers/runtime-spec/specs-go"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
)

// validProjectPath reports whether path is an acceptable project path: a
// non-empty, relative, lexically clean path with no "." or ".." segments and
// no NUL byte. A project mount names a path under the projects root, so it may
// include subdirectories (`team` or `team/src`). It is a purely lexical check;
// existence and confinement are established by resolveDirUnderRoot.
func validProjectPath(path string) bool {
	if path == "" || strings.ContainsRune(path, '\x00') || filepath.IsAbs(path) {
		return false
	}
	clean := filepath.Clean(filepath.FromSlash(path))
	if clean != filepath.FromSlash(path) {
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

// reservedDestinations lists the container paths a mount must not shadow: the
// projects root, which is reserved for project mounts; the socket directory,
// which carries the guest agent's socket; the directory the guest agent binary
// is mounted at, whose contents the container executes as its entry point; and
// /tmp, which podman mounts as the writable tmpfs the guest file API reaches
// and where command output is spilled.
func (s *Server) reservedDestinations() []string {
	return []string{s.ProjectsRoot, s.SocketsRoot, s.GuestAgentMount, "/tmp"}
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
// container destination path, validating the project path and (when set) the
// destination. The empty destination defaults to a mirror of the host source
// under projectsRoot.
//
// The project path (which may name a subdirectory) is resolved through symlinks
// and confined to projectsRoot, so a symlink planted inside a writable project
// cannot make podman bind-mount a path outside the projects root. Note that
// podman resolves the source again, in the host's mount namespace, when it
// performs the mount: the source handed to it is the resolved path precisely
// because every component was a real directory at validation time, so
// redirecting the mount afterwards means replacing a directory with a symlink
// (rmdir refuses a non-empty directory) rather than repointing an existing
// symlink. That narrows the race; it does not remove it, and it cannot be
// removed from here while podman takes a path rather than a file descriptor.
func resolveMount(projectsRoot, hostProjectsRoot string, mount state.Mount) (hostPath, destination string, err error) {
	if !validProjectPath(mount.ProjectName) {
		return "", "", fmt.Errorf("invalid project path %q", mount.ProjectName)
	}
	resolvedRoot, resolved, err := resolveDirUnderRoot(projectsRoot, filepath.FromSlash(mount.ProjectName))
	if err != nil {
		return "", "", fmt.Errorf("project path %q does not exist under %q", mount.ProjectName, projectsRoot)
	}
	// hostProjectsRoot names the same tree as projectsRoot in the host's
	// mount namespace, so the resolved path is re-expressed relative to the
	// resolved root before being joined onto it.
	hostPath = resolved
	if hostProjectsRoot != "" {
		relative, relErr := filepath.Rel(resolvedRoot, resolved)
		if relErr != nil {
			return "", "", fmt.Errorf("project path %q does not exist under %q", mount.ProjectName, projectsRoot)
		}
		hostPath = filepath.Join(hostProjectsRoot, relative)
	}
	// The destination mirrors the requested path rather than the resolved
	// one: the container-side path must stay stable when a project contains
	// an internal symlink, or the plugin and the guest agent would disagree
	// about where the files are. Project mounts never take a caller-supplied
	// destination; the fixed location below is the only one used.
	destination = filepath.Join(projectsRoot, mount.ProjectName)
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
	if !validProjectPath(name) {
		return "", fmt.Errorf("invalid project name %q", name)
	}
	_, resolved, err := resolveDirUnderRoot(root, filepath.FromSlash(name))
	if err != nil {
		return "", fmt.Errorf("project %q does not exist under %q", name, root)
	}
	return resolved, nil
}
