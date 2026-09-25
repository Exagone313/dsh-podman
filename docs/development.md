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

Prerequisites: Go 1.27, Node ≥ 22, pnpm 12, Deno ≥ 2.9 (formatting), and (for
the browser half) the `@deepseek-ai/dsh-client-*` packages published on npm.

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
make vet            # gofmt -s check + go vet with the build tags
make test-go        # go test with the build tags
make test           # test-go + pnpm test (JS tests, which run against dist/)
make fmt            # gofmt -s + deno fmt (TypeScript and Markdown)
make fmt-check      # verify the formatting without rewriting anything
make download-licenses  # generate third-party-licenses.pkg from the project and third-party Go licenses
make image          # build the orchestrator, guest-agent and dsh container images
```

`make image` depends on `third-party-licenses.pkg`: the `download-licenses` target runs the
Go collector in `scripts/download-licenses`, which shells out to
`go-licenses save` and gathers the project's MIT license plus every third-party
Go license and Apache `NOTICE` into `third-party-licenses.pkg`. That file is gitignored
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

## Naming

Proto field names are `lower_snake_case` (Buf's `BASIC` lint enforces it), and
the JS side reads them through proto-loader's camelCase projection, so
`secret_env` becomes `secretEnv` and `image_id` becomes `imageId`. Never spell a
proto field in its snake_case form in TypeScript: proto-loader ignores an
unknown property, so the value would be silently dropped.

Tool parameters are camelCase, except the ones that deliberately mirror the
harness's built-in tools (`file_path`, `old_string`, `new_string`,
`replace_all`). Settings are camelCase; the persisted TOML state uses snake_case
tags.

## Install development builds

### Build

```bash
make  # builds plugin and go binaries
make image  # build images
```

### Run the local images (Quadlet)

The shipped units pull the release images. Point them at the images built by
`make image` to run a local build as the real services; comment the original
line out so switching back is a one-line edit.

In `~/.config/containers/systemd/dsh.container`:

```ini
#Image=ghcr.io/exagone313/dsh-podman/dsh:1
Image=localhost/dsh-podman-dsh:latest
Environment=DSH_PODMAN_PLUGIN_SOURCE=%h/project/dsh-podman
```

The unit already mounts `%h/project` read-only, so a repository checked out
under `~/project` needs no extra `Volume=`. `npm pack` leaves the archive the
entrypoint installs next to `package.json` (see
[Install a local plugin build](#install-a-local-plugin-build)).

In `~/.config/containers/systemd/dsh-podman-orchestrator.container`:

```ini
#Image=ghcr.io/exagone313/dsh-podman/orchestrator:1
Image=localhost/dsh-podman-orchestrator:latest
#Environment=DSH_PODMAN_GUEST_AGENT_IMAGE=ghcr.io/exagone313/dsh-podman/guest-agent
#Environment=DSH_PODMAN_GUEST_AGENT_IMAGE_USE_VERSION_TAG=true
Environment=DSH_PODMAN_GUEST_AGENT_IMAGE=localhost/dsh-podman-guest-agent:latest
```

The release reference is version-tagged, so every release gets a distinct image
reference. The local build reuses a single `:latest` tag instead; the
orchestrator then cannot tell that the agent was rebuilt, which is what
[Update workspace containers](#update-workspace-containers) is about.

Reload systemd after editing the units:

```bash
systemctl --user daemon-reload
```

### Deploy a change

```bash
make            # Go binaries + the plugin bundle
make image      # orchestrator, guest-agent and dsh images
npm pack        # the plugin archive the dsh entrypoint installs
systemctl --user restart dsh dsh-podman-orchestrator
```

The dsh image installs the plugin at container start, so restarting dsh is what
reinstalls the freshly packed archive; restarting the orchestrator picks up the
new orchestrator and guest-agent images.

### Update workspace containers

The guest-agent image is mounted into each container when it is created, so a
running container keeps the agent it started with. The orchestrator recreates a
container by itself only when its guest-agent image reference differs from the
configured one — which happens with the version-tagged release reference, but
not with the local `:latest` tag. After rebuilding the guest agent, recreate the
containers yourself:

- from the Podman page (sidebar **Plugins** panel → **Installed** →
  **@exagone313/dsh-podman**), per container: **Recreate** (same image) or
  **Recreate with image**;
- with `container_recreate`, for a named container or the default one.

To rebuild a whole workspace instead, use **Remove pod** on its row (or
`RemoveWorkspace`): the pod and all its containers are removed, and the next
attach creates the pod and its default container again. Restarting the two
services never touches workspace containers, and neither action removes volumes,
secrets, or project data.

A container that still runs an agent from an older image makes dsh log
`rejected by server because of excess pings` for its guest socket. The message
is harmless (grpc-js backs off and reconnects) and disappears once the container
is recreated; the same message for `orchestrator.sock` means the orchestrator
service is still running the previous image.

### Development container toolchain

A workspace container's root filesystem is read-only and disposable, so the
toolchain a contributor builds with needs a workspace volume. No development
image is distributed: build a custom one — the
[setup prompt](development-prompt.md) builds `dsh-podman-tooling` from the
`archlinux` base with `go`, `nodejs-lts-jod`, `npm`, `deno`, `reuse` and
`python-chardet` — and create a workspace volume for the state an image cannot
keep: the Go and npm caches, `gopath` with the `go install`ed tools, and pnpm,
which `package.json` pins to a version the Arch repositories do not carry.

The prompt mounts that volume as `dsh-podman-toolchain` at `/opt/toolchain`
(read-write) and points the container's caches at it, so commands work without
sourcing anything:

| Container setting | Value                                                                                                                                                                                                                                                                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PATH additions    | `/opt/toolchain/gopath/bin`, `/opt/toolchain/npm-global/bin`, `/opt/toolchain/pnpm-home`                                                                                                                                                                                                                                   |
| Environment       | `GOCACHE=/opt/toolchain/gocache`, `GOMODCACHE=/opt/toolchain/gomodcache`, `GOPATH=/opt/toolchain/gopath`, `npm_config_cache=/opt/toolchain/npm-cache`, `npm_config_prefix=/opt/toolchain/npm-global`, `PNPM_HOME=/opt/toolchain/pnpm-home`, `DENO_DIR=/opt/toolchain/deno-dir`, `GOENV=/opt/toolchain/home/.config/go/env` |

Set the commit identity once on the Podman page (sidebar **Plugins** panel →
**Installed** → **@exagone313/dsh-podman**) under
[Default environment](configuration.md#default-environment) → **Git identity**,
so containers get `GIT_AUTHOR_*`/`GIT_COMMITTER_*` without a `~/.gitconfig`.

The prompt applies all of this from inside dsh and can be pasted again to repair
a workspace. Podman stores managed volumes with `DSH_PODMAN_VOLUME_PREFIX`
prepended, so it lists the volume as `dsh-podman-dsh-podman-toolchain`.

### Install a local plugin build

The dsh image installs the plugin itself at container start, so a development
build is served by pointing that install at a bind-mounted package. The Quadlet
setup above is the first form below, with the repository directory itself
(`%h/project/dsh-podman`) already visible through the unit's read-only
`%h/project` mount. Build the plugin and pack it:

```bash
pnpm build
npm pack          # writes exagone313-dsh-podman-<version>.tgz
```

Then add one of these to the dsh container unit and restart it:

```
# the repository directory, which must contain the packed archive
Volume=/path/to/repo:/mnt/dsh-podman:ro
Environment=DSH_PODMAN_PLUGIN_SOURCE=/mnt/dsh-podman
```

```
# or the archive itself
Volume=/path/to/exagone313-dsh-podman-x.y.z.tgz:/mnt/dsh-podman.tgz:ro
Environment=DSH_PODMAN_PLUGIN_SOURCE=/mnt/dsh-podman.tgz
```

The entrypoint installs that package on every start and never falls back to the
registry — a missing package is an error. Re-run `pnpm build && npm pack` and
restart dsh to pick up changes.

Without `DSH_PODMAN_PLUGIN_SOURCE`, the entrypoint installs
`@exagone313/dsh-podman@$DSH_PODMAN_PLUGIN_VERSION` (the version baked into the
image) exactly, upgrading or downgrading the profile's copy to match.

## Continuous integration

CI runs on every **branch** push and pull request, split across
`.github/workflows/ci-common.yml` (REUSE lint and zizmor), `ci-code.yml` (Go,
JS, images, Trivy), `ci-docs.yml` (Deno fmt) and `ci-dsh-image.yml`. A **tag**
push runs only `release.yml`, which repeats the build, vet and tests itself:

- **actions-lint** — zizmor scans the workflows for insecure practices.
- **reuse** — REUSE license compliance.
- **go** — build, `gofmt -s` check, vet, tests, and govulncheck (Go
  vulnerabilities). Unfixed findings don't fail the job; fixable ones do.
- **js** — TypeScript formatting check, install, typecheck, build, tests, and
  `pnpm audit`.
- **docs** — Markdown formatting check (`deno fmt` via `make fmt-check-md`).
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
pnpm bump-version x.y.z            # add --dry-run to validate only
git push origin master x.y.z
```

`scripts/bump-version.mjs` checks that the version is a semver release or
pre-release that increases the current one, writes it to `package.json`, commits
`chore: bump version to X`, and creates the tag; it pushes nothing, and it
requires the `master` branch with a clean working tree. The tag is also what the
built plugin and binaries report, since `scripts/generate-version.mjs` derives
the embedded version from `git describe --tags`. Pre-releases (`1.0.0-rc.1`) are
bumped the same way.

A release can also be triggered, or a failed one re-run, from the Actions tab
with `workflow_dispatch`, which takes the version as input. Already-published
steps are skipped (npm skips a version it already has, and an existing GitHub
release is left alone), so a retry never republishes.

The `NPM_TOKEN` secret must be configured on the repository for the npm step.
