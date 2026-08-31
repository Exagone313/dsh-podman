<!--
SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>

SPDX-License-Identifier: MIT
-->

# Development

This page is for **contributors** building the plugin from this repository.
Users install the published package from npm instead — see
[Installation](installation.md).

## Repository layout

- `src/` — the Cordis plugin (host half + browser client).
- `cmd/dsh-podman-orchestrator/` and `cmd/dsh-podman-guest-agent/` — the two Go
  binaries.
- `internal/` — Go implementation of the orchestrator, guest agent, and
  protobuf bindings.
- `proto/` — the gRPC definitions.
- `.github/workflows/` — CI and release automation.

## Building

Prerequisites: Go 1.27, Node ≥ 22, pnpm 10, and (for the browser half) the
`@deepseek-ai/dsh-client-*` packages published on npm.

```sh
go test -tags "containers_image_openpgp exclude_graphdriver_btrfs exclude_graphdriver_devicemapper" ./...   # Go tests (orchestrator + guest agent)
pnpm install
pnpm run build       # tsc host + tsc client -> dist/, copies proto/ -> dist/grpc/proto/
```

The Go build tags skip the btrfs and devicemapper storage drivers, which need
host C headers; `make` applies the same tags automatically.

The `Makefile` wraps the common workflows:

```sh
make build-go       # build both Go binaries into bin/<os>-<arch>/
make build          # build-go + pnpm-build
make vet            # go vet with the build tags
make test-go        # go test with the build tags
make test           # test-go + pnpm test (JS tests, which run against dist/)
make image          # build the orchestrator and guest-agent container images
```

`pnpm test` runs `node --test dist/*.test.js`, so it requires `pnpm build` to
have run first (the `test` target handles this).

## Protobuf

The `.proto` sources live in `proto/`; the generated Go bindings in
`internal/genproto/` are committed. Regenerate with Buf (`buf generate`) after
changing a `.proto`. The raw `.proto` files are copied into `dist/grpc/proto/`
at build time and loaded at runtime by `@grpc/proto-loader`.

## Continuous integration

CI (`.github/workflows/ci.yml`) runs on every branch push and pull request:

- **actions-lint** — zizmor scans the workflows for insecure practices.
- **go** — build, vet, tests, and govulncheck (Go vulnerabilities). Unfixed
  findings don't fail the job; fixable ones do.
- **js** — install, typecheck, build, tests, and `pnpm audit`.
- **images** — builds the orchestrator and guest-agent images (runs only after
  the test jobs pass).
- **trivy** — filesystem vulnerability scan (unfixed ignored) and container
  misconfiguration scan (DS-0002 excluded via `.trivyignore.yaml`).

All third-party actions are pinned to full commit SHAs and checked by zizmor.

## Releasing

Releases are triggered by pushing a **bare semver tag** (`x.y.z`, no `v`;
pre-releases like `1.0.0-rc.1` also work). The release workflow
(`.github/workflows/release.yml`):

1. Runs the tests, then builds both binaries for `linux/amd64` and
   `linux/arm64`.
2. Pushes the **orchestrator** and **guest-agent** images to GHCR
   (`ghcr.io/exagone313/dsh-podman/{orchestrator,guest-agent}`), tagged with
   the version plus `latest` for stable releases (pre-releases never get
   `latest`).
3. Publishes the plugin to **npm** (`@exagone313/dsh-podman`) with provenance;
   pre-releases are published under the `next` dist-tag.
4. Creates a **GitHub release** with auto-generated notes and attaches the
   binaries and the npm tarball.

Push a tag with:

```sh
git tag 0.1.1
git push origin 0.1.1
```

The `NPM_TOKEN` secret must be configured on the repository for the npm step.