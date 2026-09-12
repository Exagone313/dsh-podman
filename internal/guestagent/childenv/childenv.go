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

// baselineKeys are the only variables an isolated process inherits from the
// agent's environment. They are functional necessities, not secrets: a program
// needs PATH to find commands and HOME for per-user state.
var baselineKeys = []string{"PATH", "HOME"}

// BuildIsolated returns the environment for a process that must NOT inherit the
// agent's environment: only the baseline variables (PATH, HOME) when the agent
// has them, followed by extra in a stable order. A baseline variable in extra
// is overridden by the caller's value. Reserved keys in extra are dropped for
// the same reason as Build.
func BuildIsolated(extra map[string]string) []string {
	merged := make(map[string]string, len(baselineKeys)+len(extra))
	for _, key := range baselineKeys {
		if value, ok := os.LookupEnv(key); ok {
			merged[key] = value
		}
	}
	for key, value := range extra {
		if reserved(key) {
			continue
		}
		merged[key] = value
	}
	keys := make([]string, 0, len(merged))
	for key := range merged {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	result := make([]string, 0, len(keys))
	for _, key := range keys {
		result = append(result, key+"="+merged[key])
	}
	return result
}
