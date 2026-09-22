// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package version

import "strings"

// Version is the tag-derived version (from `git describe --tags`), and Commit
// the short commit hash. Both are injected at build time via -ldflags and fall
// back to dev/unknown for local builds without ldflags.
var Version = "dev"
var Commit = "unknown"

// Core returns the leading x.y.z of a version string, or "" when there is none.
// A release build is exactly the tag, but a build from a later commit carries a
// git-describe suffix (`1.2.3-4-gabc123`) and a local build may be `dev`; the
// compatibility check compares the core alone and skips anything without one.
func Core(value string) string {
	parts := strings.SplitN(value, ".", 3)
	if len(parts) != 3 {
		return ""
	}
	major, minor, rest := parts[0], parts[1], parts[2]
	patch := rest
	if index := strings.IndexAny(rest, "-+"); index >= 0 {
		patch = rest[:index]
	}
	for _, part := range []string{major, minor, patch} {
		if part == "" || strings.Trim(part, "0123456789") != "" {
			return ""
		}
	}
	return major + "." + minor + "." + patch
}

// Major returns the major component of a version's core, or -1 when the value
// has no parseable core.
func Major(value string) int {
	core := Core(value)
	if core == "" {
		return -1
	}
	digits := core[:strings.Index(core, ".")]
	result := 0
	for _, digit := range digits {
		result = result*10 + int(digit-'0')
	}
	return result
}

// Compare orders two version cores: -1 when a < b, 0 when equal, 1 when a > b.
// An unparseable core on either side compares as -1 (unknown sorts below any
// known version).
func Compare(a, b string) int {
	coreA, coreB := Core(a), Core(b)
	if coreA == "" || coreB == "" {
		return -1
	}
	partsA := strings.Split(coreA, ".")
	partsB := strings.Split(coreB, ".")
	for index := range partsA {
		left := atoi(partsA[index])
		right := atoi(partsB[index])
		if left != right {
			if left < right {
				return -1
			}
			return 1
		}
	}
	return 0
}

func atoi(digits string) int {
	result := 0
	for _, digit := range digits {
		result = result*10 + int(digit-'0')
	}
	return result
}
