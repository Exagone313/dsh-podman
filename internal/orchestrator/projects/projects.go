// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package projects

import (
	"os"
	"path/filepath"
	"sort"
	"strings"
)

type Project struct{ Name, HostPath string }

// List returns every directory under root that can be named as a project.
// A symlinked directory is followed only when its target stays under the
// resolved root, matching the mount resolver's confinement; a broken link, a
// non-directory, or a link escaping the root is skipped. HostPath is the
// resolved absolute path, so a symlinked root or ancestor is reported as the
// directory podman will actually bind.
func List(root string) ([]Project, error) {
	resolvedRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return nil, err
	}
	result := make([]Project, 0)
	walkErr := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path == root {
			return nil
		}
		if !entry.IsDir() && entry.Type()&os.ModeSymlink == 0 {
			return nil
		}
		resolved, err := filepath.EvalSymlinks(path)
		if err != nil {
			// A broken link (or an entry that vanished mid-walk) is not a
			// project.
			return nil
		}
		info, err := os.Stat(resolved)
		if err != nil || !info.IsDir() {
			return nil
		}
		if resolved != resolvedRoot && !strings.HasPrefix(resolved, resolvedRoot+string(filepath.Separator)) {
			// An escaping link is never offered as a project.
			return nil
		}
		name, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		result = append(result, Project{Name: filepath.ToSlash(name), HostPath: resolved})
		return nil
	})
	if walkErr != nil {
		return nil, walkErr
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Name < result[j].Name })
	return result, nil
}
