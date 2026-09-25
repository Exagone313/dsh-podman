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
- `make vet` / `make test-go` — Go checks with the tags (`vet` runs the gofmt
  check first)
- `make fmt` / `make fmt-check` — format / verify Go, TypeScript and Markdown
- `make test` — Go tests + pnpm tests

`pnpm test` runs against `dist/`, so run `pnpm build` first (or `make test`).

## Security

- Never return a raw API object from a tool result. Reconstruct the object
  internally and omit every attribute that should not reach the model — for
  example `agentToken`, `agentSocketPath`, `podmanName`, `workspaceSlug`. The
  `public*` helpers in `src/index.ts` are the single place that builds these
  safe shapes.

## Documentation

User-facing docs live in `docs/`; `README.md` only links to them. Users install
the plugin from npm — the local build is for development only.

Markdown and TypeScript share one formatter — `deno fmt`, configured by
`deno.json` (line width, wrapped-prose policy, and the formatted file set); run
`make fmt`, and `make fmt-check` or the CI jobs verify it.

## Conventions

- Commit after each change, in small focused commits (one per logical change),
  with a single-line message.
- Files carry SPDX headers; validate compliance with
  `REUSE_ENCODING_MODULE=chardet reuse lint` (the `REUSE_ENCODING_MODULE`
  variable works around a reuse bug that otherwise false-positives certain UTF-8
  files, e.g. the Chinese `.zh.md` docs).
- Go files are formatted with `gofmt -s`: run `make fmt-go` before committing.
  `make vet` and the `go` CI job fail on an unformatted file. `third_party/` is
  an upstream replacement module (`replace` in `go.mod`) left as published.
- Prefer implementing with subagents when possible.
- Name proto fields in `lower_snake_case` and read them in TypeScript through
  proto-loader's camelCase projection (`secret_env` → `secretEnv`); never spell
  a proto field in snake_case in TS, because proto-loader silently drops unknown
  properties. Tool parameters are camelCase except the ones mirroring the
  harness's built-in tools (`file_path`, `old_string`, `new_string`,
  `replace_all`).
- Pin `@deepseek-ai/*` dependencies to exact versions in both `devDependencies`
  and `peerDependencies`, and keep every `@deepseek-ai/dsh-*` specifier equal to
  `Containerfile.dsh`'s `ARG DSH_VERSION`. Bump them together with the image,
  never individually (Dependabot ignores the scope for this reason).
