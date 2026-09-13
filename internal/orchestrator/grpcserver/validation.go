// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package grpcserver

import (
	"fmt"
	"sort"
	"strings"
)

// validateEnvKey rejects a user environment variable key that is empty,
// contains '=' or a NUL byte, or collides with the reserved DSH_PODMAN
// namespace.
func validateEnvKey(key string) error {
	if strings.HasPrefix(key, "DSH_PODMAN") {
		return fmt.Errorf("env key %q is reserved (DSH_PODMAN prefix)", key)
	}
	if key == "" {
		return fmt.Errorf("env key is empty")
	}
	if strings.ContainsRune(key, '=') {
		return fmt.Errorf("env key %q contains '='", key)
	}
	if strings.ContainsRune(key, '\x00') {
		return fmt.Errorf("env key %q contains a NUL byte", key)
	}
	return nil
}

// validateEnv rejects user environment variables whose keys are empty, contain
// '=' or a NUL byte, or collide with the reserved DSH_PODMAN namespace. Values
// containing a NUL byte are rejected as well. Keys are visited in sorted order
// so the returned message is deterministic.
func validateEnv(env map[string]string) error {
	keys := make([]string, 0, len(env))
	for key := range env {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if err := validateEnvKey(key); err != nil {
			return err
		}
		if strings.ContainsRune(env[key], '\x00') {
			return fmt.Errorf("env value for key %q contains a NUL byte", key)
		}
	}
	return nil
}

// validateSecretEnv validates container secret env vars (env var name to
// secret short name). Keys must satisfy validateEnvKey and values must be
// well-formed secret names. Keys are visited in sorted order so the returned
// message is deterministic.
func validateSecretEnv(secretEnv map[string]string) error {
	keys := make([]string, 0, len(secretEnv))
	for key := range secretEnv {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if err := validateEnvKey(key); err != nil {
			return err
		}
		if !secretName.MatchString(secretEnv[key]) {
			return fmt.Errorf("invalid secret name %q for env var %q", secretEnv[key], key)
		}
	}
	return nil
}
