// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// Package childenv builds the environment for processes the guest agent
// starts on behalf of a caller.
package childenv

import (
	"os"
	"sort"
	"strings"
)

// Reserved is the prefix of the variables the orchestrator sets for the guest
// agent's own use. It matches the namespace the orchestrator refuses to let
// clients set on a container.
const Reserved = "DSH_PODMAN"

// Build returns the environment for a process the agent starts: the agent's
// own environment with every reserved variable removed, followed by extra in a
// stable order.
//
// The agent's credential (DSH_PODMAN_GUEST_TOKEN) lives in that namespace, and
// the agent otherwise hands its whole environment to everything it spawns.
// Withholding the namespace keeps the credential out of processes that drop
// privileges, which cannot read the agent's own environment but were being
// given a copy of it, and stops a plain `env` from disclosing the credential to
// whoever asked for the command to be run. Reserved keys in extra are dropped
// for the same reason.
func Build(extra map[string]string) []string {
	parent := os.Environ()
	result := make([]string, 0, len(parent)+len(extra))
	for _, entry := range parent {
		if key, _, ok := strings.Cut(entry, "="); ok && reserved(key) {
			continue
		}
		result = append(result, entry)
	}
	keys := make([]string, 0, len(extra))
	for key := range extra {
		if reserved(key) {
			continue
		}
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		result = append(result, key+"="+extra[key])
	}
	return result
}

func reserved(key string) bool { return strings.HasPrefix(key, Reserved) }
