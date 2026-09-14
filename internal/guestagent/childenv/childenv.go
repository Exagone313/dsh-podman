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
	"sync"
)

// Reserved is the prefix of the variables the orchestrator sets for the guest
// agent's own use. It matches the namespace the orchestrator refuses to let
// clients set on a container.
const Reserved = "DSH_PODMAN"

// Paths is the ordered set of directories the agent prepends to every child's
// PATH. The zero value holds no additions and is safe for concurrent use.
type Paths struct {
	mu    sync.RWMutex
	paths []string
}

// NewPaths returns an empty path-addition set.
func NewPaths() *Paths { return &Paths{} }

// Set replaces the additions, dropping duplicates and empty entries while
// preserving order, and returns the stored list. The first occurrence wins, so
// the caller's priority order is kept.
func (p *Paths) Set(paths []string) []string {
	seen := make(map[string]struct{}, len(paths))
	stored := make([]string, 0, len(paths))
	for _, path := range paths {
		if path == "" {
			continue
		}
		if _, ok := seen[path]; ok {
			continue
		}
		seen[path] = struct{}{}
		stored = append(stored, path)
	}
	p.mu.Lock()
	p.paths = stored
	p.mu.Unlock()
	return append([]string(nil), stored...)
}

// List returns a copy of the current additions.
func (p *Paths) List() []string {
	if p == nil {
		return nil
	}
	p.mu.RLock()
	defer p.mu.RUnlock()
	return append([]string(nil), p.paths...)
}

// prepend returns base with the additions prepended, highest priority first.
// It is a no-op when there are no additions.
func (p *Paths) prepend(base string) string {
	paths := p.List()
	if len(paths) == 0 {
		return base
	}
	prefix := strings.Join(paths, ":")
	if base == "" {
		return prefix
	}
	return prefix + ":" + base
}

// Build returns the environment for a process the agent starts: the agent's
// own environment with every reserved variable removed, followed by extra in a
// stable order. The agent's path additions are prepended to the resulting
// PATH (see Paths).
//
// unset names ordinary ambient variables the caller wants removed from the
// child (the harness's `undefined` environment tombstones); they are filtered
// from the inherited base only, so an explicit value in extra still wins.
//
// The agent's credential (DSH_PODMAN_GUEST_TOKEN) lives in that namespace, and
// the agent otherwise hands its whole environment to everything it spawns.
// Withholding the namespace keeps the credential out of processes that drop
// privileges, which cannot read the agent's own environment but were being
// given a copy of it, and stops a plain `env` from disclosing the credential to
// whoever asked for the command to be run. Reserved keys in extra are dropped
// for the same reason.
func Build(paths *Paths, extra map[string]string, unset ...string) []string {
	removed := make(map[string]struct{}, len(unset))
	for _, key := range unset {
		removed[key] = struct{}{}
	}
	parent := os.Environ()
	result := make([]string, 0, len(parent)+len(extra)+1)
	for _, entry := range parent {
		if key, _, ok := strings.Cut(entry, "="); ok {
			if reserved(key) {
				continue
			}
			if _, drop := removed[key]; drop {
				continue
			}
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
	// The additions are prepended to whichever PATH the child would otherwise
	// get: the caller's explicit value when it set one, else the agent's
	// inherited one. Appended last so it wins the runtime's last-wins dedup.
	base := os.Getenv("PATH")
	if value, ok := extra["PATH"]; ok {
		base = value
	}
	if prepended := paths.prepend(base); prepended != base {
		result = append(result, "PATH="+prepended)
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
// the same reason as Build. The agent's path additions are prepended to the
// resulting PATH.
func BuildIsolated(paths *Paths, extra map[string]string) []string {
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
	result := make([]string, 0, len(keys)+1)
	for _, key := range keys {
		result = append(result, key+"="+merged[key])
	}
	// The additions are prepended to the baseline (or caller-supplied) PATH.
	if prepended := paths.prepend(merged["PATH"]); prepended != merged["PATH"] {
		result = append(result, "PATH="+prepended)
	}
	return result
}
