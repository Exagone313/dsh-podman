<!--
SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>

SPDX-License-Identifier: MIT
-->

# Development

This page is for **contributors** building the plugin from this repository.

## Repository layout

- `src/` — the Cordis plugin (host half + browser client).
- `cmd/dsh-podman-orchestrator/` and `cmd/dsh-podman-guest-agent/` — the two Go
  binaries.
- `internal/` — Go implementation of the orchestrator, guest agent, and protobuf
  bindings.
- `proto/` — the gRPC definitions.
- `.github/workflows/` — CI and release automation.

## Building

Prerequisites: Go 1.27, Node ≥ 22, pnpm 12, and (for the browser half) the
`@deepseek-ai/dsh-client-*` packages published on npm.

```sh
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
make download-licenses  # generate LICENSE.pkg from the project and third-party Go licenses
make image          # build the orchestrator and guest-agent container images
```

`make image` depends on `LICENSE.pkg`: the `download-licenses` target runs the
Go collector in `scripts/download-licenses`, which shells out to
`go-licenses save` and gathers the project's MIT license plus every third-party
Go license and Apache `NOTICE` into `LICENSE.pkg`. That file is gitignored
(never committed) and is baked into the orchestrator and guest-agent images at
`/usr/share/licenses/dsh-podman/LICENSE`; because workspace containers mount the
guest-agent image, it also rides along into every workspace container.

`pnpm test` runs `node --test dist/*.test.js`, so it requires `pnpm build` to
have run first (the `test` target handles this).

## Protobuf

The `.proto` sources live in `proto/`; the generated Go bindings in
`internal/genproto/` are committed. After changing a `.proto`, regenerate them
with Buf (`buf generate`), which must be installed separately (it has no `make`
target) — pin it with `go install github.com/bufbuild/buf/cmd/buf@v1.73.0`.
Commit the `.proto` change together with the regenerated Go bindings.

The JS side loads the raw `.proto` files at runtime via `@grpc/proto-loader`
(copied to `dist/grpc/proto/` at build time); no TypeScript bindings are
generated. Optionally validate the schema with `buf lint` and `buf breaking`.

## Install development builds

### Build

```bash
make  # builds plugin and go binaries
make image  # build images
```

### Recreate containers

```bash
systemctl --user restart dsh dsh-podman-orchestrator
```

### Update plugin

```bash
npm pack
v="$(jq -r .version package.json)"
podman cp ./exagone313-dsh-podman-"${v}".tgz dsh:/tmp/
podman exec -it dsh dsh plugin --profile web remove @exagone313/dsh-podman  # necessary, to force reinstall if the same version
podman exec -it dsh dsh plugin --profile web add /tmp/exagone313-dsh-podman-"${v}".tgz --allow-build=protobufjs
systemctl --user restart dsh
```

## Continuous integration

CI runs on every **branch** push and pull request, split across
`.github/workflows/ci-common.yml` (REUSE lint and zizmor), `ci-code.yml` (Go,
JS, images, Trivy), `ci-docs.yml` (Deno fmt) and `ci-dsh-image.yml`. A **tag**
push runs only `release.yml`, which repeats the build, vet and tests itself:

- **actions-lint** — zizmor scans the workflows for insecure practices.
- **reuse** — REUSE license compliance.
- **go** — build, vet, tests, and govulncheck (Go vulnerabilities). Unfixed
  findings don't fail the job; fixable ones do.
- **js** — install, typecheck, build, tests, and `pnpm audit`.
- **docs** — `deno fmt --check` on the Markdown.
- **images** — builds the orchestrator and guest-agent images (runs only after
  the test jobs pass); **dsh image** builds `Containerfile.dsh`.
- **trivy** — filesystem vulnerability scan (unfixed ignored) and container
  misconfiguration scan (DS-0002 excluded via `.trivyignore.yaml`).

All third-party actions are pinned to full commit SHAs and checked by zizmor.

## Releasing

Releases are triggered by pushing a **bare semver tag** (`x.y.z`, no `v`;
pre-releases like `1.0.0-rc.1` also work). The release workflow
(`.github/workflows/release.yml`):

1. Runs the tests, then builds both binaries for `linux/amd64` and
   `linux/arm64`.
2. Pushes the **dsh**, **orchestrator** and **guest-agent** images to GHCR
   (`ghcr.io/exagone313/dsh-podman/{dsh,orchestrator,guest-agent}`). Every
   release is tagged with its version; a **stable** release — `1.0.0` or above
   with no pre-release suffix — is also tagged with its major version (`1`) and
   `latest`. A `0.x` release and any hyphenated tag are pre-releases: they get
   the version tag only.
3. Publishes the plugin to **npm** (`@exagone313/dsh-podman`) with provenance;
   pre-releases are published under the `next` dist-tag.
4. Creates a **GitHub release** with auto-generated notes and attaches the
   binaries and the npm tarball.

The tag must match `package.json`'s version — the workflow fails otherwise — so
bump both with the version script:

```sh
pnpm bump-version 0.1.1            # add --dry-run to validate only
git push origin master 0.1.1
```

`scripts/bump-version.mjs` checks that the version is a semver release or
pre-release that increases the current one, writes it to `package.json`, commits
`chore: bump version to X`, and creates the tag; it pushes nothing, and it
requires the `master` branch with a clean working tree. The tag is also what the
built plugin and binaries report, since `scripts/generate-version.mjs` derives
the embedded version from `git describe --tags`. Pre-releases (`1.0.0-rc.1`) are
bumped the same way.

The `NPM_TOKEN` secret must be configured on the repository for the npm step.
