// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package podman

import (
	"fmt"
	"path/filepath"
)

// ValidateSkillDir checks the optional host skill directory before it is bind
// mounted read-only into every guest container. The mount reuses one path as both
// source and destination, so a value that overlaps a path the guest already relies
// on would shadow it there; the reserved set is what such a value must not touch.
//
// A value inside the DSH root is accepted on purpose: the shipped Quadlet comment
// states that rule, and an operator who ignores it owns the consequence.
func ValidateSkillDir(dir, projectRoot, socketRoot, guestAgentMount, guestAgentBin string) error {
	if dir == "" {
		return nil
	}
	if !filepath.IsAbs(dir) {
		return fmt.Errorf("DSH_PODMAN_HOST_SKILL_DIR must be an absolute path, got %q", dir)
	}
	if cleaned := filepath.Clean(dir); cleaned != dir {
		return fmt.Errorf("DSH_PODMAN_HOST_SKILL_DIR must be a cleaned path without a trailing separator, got %q (want %q)", dir, cleaned)
	}
	// "/" conflicts only by being the mount itself; every path lies inside it.
	reserved := []string{"/", "/tmp", "/var/tmp", spillRoot, projectRoot, socketRoot, guestAgentMount, guestAgentBin}
	for _, path := range reserved {
		if path == "" {
			continue
		}
		if dir == path {
			return fmt.Errorf("DSH_PODMAN_HOST_SKILL_DIR %q is a reserved container path", dir)
		}
		if path != "/" && isUnderPath(dir, path) {
			return fmt.Errorf("DSH_PODMAN_HOST_SKILL_DIR %q lies inside the reserved container path %q", dir, path)
		}
		if isUnderPath(path, dir) {
			return fmt.Errorf("DSH_PODMAN_HOST_SKILL_DIR %q would shadow the reserved container path %q", dir, path)
		}
	}
	return nil
}
