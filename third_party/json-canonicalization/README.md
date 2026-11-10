# json-canonicalization (local copy)

SPDX-FileCopyrightText: 2018 Anders Rundgren

SPDX-License-Identifier: Apache-2.0

This directory is a local copy of the Go module
`github.com/cyberphone/json-canonicalization`, used by dsh-podman through a
`replace` directive in the root `go.mod`.

**Origin:** <https://github.com/cyberphone/json-canonicalization> at commit
`32a48195b9b2` (pseudo-version `v0.0.0-20261011152517-32a48195b9b2`).

**Why this copy exists:** the upstream module ships no `go.mod`, and its
`LICENSE` is only the abbreviated Apache-2.0 notice, which the go-licenses
classifier cannot recognize. dsh-podman builds `third-party-licenses.pkg` — the project and
third-party licenses baked into its container images — with go-licenses, so the
module was reported as having an unknown license and had to be excluded via
`--ignore`. This copy adds a proper `go.mod` and the full Apache-2.0 license
text so the license is detected and included in `third-party-licenses.pkg`. The Go sources
match upstream apart from the SPDX headers added for REUSE.
