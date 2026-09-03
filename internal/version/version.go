// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

package version

// Version is the tag-derived version (from `git describe --tags`), and Commit
// the short commit hash. Both are injected at build time via -ldflags and fall
// back to dev/unknown for local builds without ldflags.
var Version = "dev"
var Commit = "unknown"