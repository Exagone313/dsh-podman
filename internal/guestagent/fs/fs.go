// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package fs

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type Mount struct {
	Virtual, Host string
	ReadOnly      bool
}
type WorkspaceFS struct{ mounts []Mount }

func New(mounts []Mount) (*WorkspaceFS, error) {
	for _, mount := range mounts {
		if !filepath.IsAbs(mount.Virtual) || !filepath.IsAbs(mount.Host) {
			return nil, fmt.Errorf("mount paths must be absolute")
		}
	}
	return &WorkspaceFS{mounts: append([]Mount(nil), mounts...)}, nil
}
func (w *WorkspaceFS) Resolve(path string, write bool) (string, bool, error) {
	if !filepath.IsAbs(path) {
		return "", false, fmt.Errorf("path must be absolute")
	}
	clean := filepath.Clean(path)
	for _, mount := range w.mounts {
		if clean != mount.Virtual && !strings.HasPrefix(clean, mount.Virtual+string(filepath.Separator)) {
			continue
		}
		if write && mount.ReadOnly {
			return "", false, fmt.Errorf("mount is read-only")
		}
		if write && clean == mount.Virtual {
			return "", false, fmt.Errorf("refusing to modify mount root")
		}
		candidate := filepath.Join(mount.Host, strings.TrimPrefix(clean, mount.Virtual))
		resolved, err := resolveForCheck(candidate)
		if err != nil {
			return "", false, err
		}
		root, err := filepath.EvalSymlinks(mount.Host)
		if err != nil {
			return "", false, err
		}
		if resolved != root && !strings.HasPrefix(resolved, root+string(filepath.Separator)) {
			return "", false, fmt.Errorf("path escapes mount")
		}
		return resolved, mount.ReadOnly, nil
	}
	return "", false, fmt.Errorf("path is outside configured mounts")
}
func resolveForCheck(path string) (string, error) {
	if _, err := os.Lstat(path); err == nil {
		return filepath.EvalSymlinks(path)
	}
	parent := filepath.Dir(path)
	resolved, err := resolveForCheck(parent)
	if err != nil {
		return "", err
	}
	return filepath.Join(resolved, filepath.Base(path)), nil
}
