<!--
SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>

SPDX-License-Identifier: MIT
-->

# AGENTS.md

Build and test Go through `make` — bare `go test ./...` / `go build ./...` fail
on a missing `btrfs/version.h` because they don't apply the required build tags
(`containers_image_openpgp exclude_graphdriver_btrfs
exclude_graphdriver_devicemapper`).

- `make build` — Go binaries + pnpm build
- `make vet` / `make test-go` — Go checks with the tags
- `make test` — Go tests + pnpm tests

`pnpm test` runs against `dist/`, so run `pnpm build` first (or `make test`).

## Documentation

User-facing docs live in `docs/`; `README.md` only links to them. Users install
the plugin from npm — the local build is for development only.

Markdown must be formatted with `deno fmt` (`deno fmt **/*.md`); a docs-only
workflow enforces this on `.md` changes.

## Conventions

- Commit after each change, in small focused commits (one per logical change),
  with a single-line message.
- Files carry SPDX headers; validate compliance with `reuse lint`.
- Prefer implementing with subagents when possible.
