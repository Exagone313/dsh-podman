<!--
SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>

SPDX-License-Identifier: MIT
-->

# dsh-podman

Podman-backed execution for the DeepSeek Harness (`dsh`). This repository
ships the `@exagone313/dsh-podman` Cordis plugin and the two Go binaries it
delegates to: all shell execution and file access is routed through
disposable, per-project Podman containers instead of the dsh host.

## What runs where

| Component | Runs | What it does |
|---|---|---|
| `dsh-podman-orchestrator` | A container with access to the Podman API | Owns the control socket and persisted state; creates/removes guest containers; builds workspace images |
| `dsh-podman-guest-agent` | Inside every guest container | Serves the exec/filesystem gRPC API for one workspace |
| `@exagone313/dsh-podman` | Inside dsh itself | Registers `ctx.subprocess` and `ctx.fs` backed by the orchestrator, plus lifecycle tools |

The plugin auto-creates a missing workspace using its configured default
image and a single read-write project mount. It never falls back to host
execution.

## Build

```sh
go test ./...        # Go tests (orchestrator + guest agent)
pnpm install
pnpm run build       # tsc host + tsc client -> dist/, copies proto/ -> dist/grpc/proto/
```

Protobuf bindings are generated with Buf (`buf generate`); the raw `.proto`
files are copied into `dist/grpc/proto/` at build time and loaded at runtime
by `@grpc/proto-loader`.

## Configuration (environment variables)

All variables use the `DSH_PODMAN_` prefix. Variables are listed under the
component that reads them; a variable read by several components appears in
each of their sections.

### Plugin (dsh client)

| Variable | Default | Description |
|---|---|---|
| `DSH_PODMAN_DEFAULT_IMAGE` | `localhost/dsh-podman/arch-base` | Default workspace image reference used when creating a workspace |
| `DSH_PODMAN_IMAGE_PREFIX` | `localhost/dsh-podman/` | Prefix prepended to workspace image references |
| `DSH_PODMAN_ORCHESTRATOR_TOKEN` | — | Shared secret authenticating control-plane gRPC calls; see [Variable details](#variable-details) |
| `DSH_PODMAN_PROJECTS_ROOT` | `/projects` | Project root used to resolve session working directories into a workspace |
| `DSH_PODMAN_SOCKETS_ROOT` | `/run/dsh-podman` | Socket root the plugin derives the orchestrator control socket (`orchestrator.sock`) from |

All of the above are overridable through the plugin's `cordis.yml` config
(`socketsRoot`, `defaultImage`, `projectsRoot`, `controlToken`, `imagePrefix`).

### Orchestrator (`dsh-podman-orchestrator`)

| Variable | Default | Description |
|---|---|---|
| `DSH_PODMAN_BUILD_DEFAULT_IMAGE` | `true` | Whether the orchestrator auto-builds the default workspace image when it is missing; see [Variable details](#variable-details) |
| `DSH_PODMAN_DEFAULT_IMAGE` | `localhost/dsh-podman/arch-base` | Default workspace image reference, auto-provisioned on first use |
| `DSH_PODMAN_GUEST_AGENT_BIN` | `dsh-podman-guest-agent` | Guest agent binary path (container-internal); see [Variable details](#variable-details) |
| `DSH_PODMAN_GUEST_AGENT_IMAGE` | — | Prebuilt guest-agent image baked into workspace images; unset disables the feature; see [Variable details](#variable-details) |
| `DSH_PODMAN_GUEST_AGENT_IMAGE_AGENT_BIN` | `/bin/dsh-podman-guest-agent` | Path of the guest agent binary inside the guest-agent image; see [Variable details](#variable-details) |
| `DSH_PODMAN_GUEST_AGENT_IMAGE_DEST_AGENT_BIN` | `/usr/local/bin/dsh-podman-guest-agent` | Destination path for the copied binary inside built workspace images; see [Variable details](#variable-details) |
| `DSH_PODMAN_HOST_GUEST_AGENT_BIN` | — | Host-side guest agent binary path; bind-mounted when set; see [Variable details](#variable-details) |
| `DSH_PODMAN_HOST_PACMAN_CACHE` | — | Host-absolute Buildah cache directory used by workspace-image builds |
| `DSH_PODMAN_HOST_PROJECTS_ROOT` | `DSH_PODMAN_PROJECTS_ROOT` | Host-side projects root used as the source of bind mounts |
| `DSH_PODMAN_HOST_SOCKETS_ROOT` | `DSH_PODMAN_SOCKETS_ROOT` | Host-side sockets root for guest socket bind mounts |
| `DSH_PODMAN_IMAGE_PREFIX` | `localhost/dsh-podman/` | Prefix prepended to built workspace image references |
| `DSH_PODMAN_ORCHESTRATOR_PODMAN_SOCKET` | required | Podman API socket, e.g. `unix:///run/podman/podman.sock` |
| `DSH_PODMAN_ORCHESTRATOR_STATE` | `/var/lib/dsh-orchestrator` | Persisted state directory |
| `DSH_PODMAN_ORCHESTRATOR_TOKEN` | — | Shared secret authenticating control-plane gRPC calls; see [Variable details](#variable-details) |
| `DSH_PODMAN_PROJECTS_ROOT` | `/projects` | Project root inside every guest container |
| `DSH_PODMAN_SOCKETS_ROOT` | `/run/dsh-podman` | Socket root directory (bind-mounted from the host); holds `orchestrator.sock` and per-workspace guest sockets; see [Variable details](#variable-details) |

### Guest agent (`dsh-podman-guest-agent`)

| Variable | Default | Description |
|---|---|---|
| `DSH_PODMAN_GUEST_SOCKET` | required | Unix socket the guest agent serves on; the orchestrator sets it when starting the container |
| `DSH_PODMAN_GUEST_TOKEN` | — | Bearer token required on every gRPC call; see [Variable details](#variable-details) |
| `DSH_PODMAN_PROJECTS_ROOT` | `/projects` | Root where the workspace's project(s) are mounted |

### Variable details

#### `DSH_PODMAN_BUILD_DEFAULT_IMAGE`

Whether the orchestrator auto-builds the default workspace image
(`DSH_PODMAN_DEFAULT_IMAGE`, default `${DSH_PODMAN_IMAGE_PREFIX}arch-base`, i.e.
`localhost/dsh-podman/arch-base`) the first time a workspace requests it.
Unset or a truthy value (`1`, `true`, `yes`, `on`) builds the image; a falsy
value (`0`, `false`, `no`, `off`) makes workspace creation fail with `NotFound`
when the image is missing instead, letting an operator pre-build and push it
beforehand.

#### `DSH_PODMAN_GUEST_AGENT_BIN` and `DSH_PODMAN_HOST_GUEST_AGENT_BIN`

A guest container can run the guest agent either from a host binary
bind-mounted into it, or from a binary already present in its image.

`DSH_PODMAN_HOST_GUEST_AGENT_BIN` is the path *on the host* of the guest agent
binary. Setting it enables a bind mount of that binary into the workspace
container. It is unset by default, so by default no bind mount is added and the
binary must already be present in the image — either baked in via the
multi-stage build below, or found through the image's `PATH`.

`DSH_PODMAN_GUEST_AGENT_BIN` is the path of the guest agent binary *inside* the
guest container. It is both the command the orchestrator starts and the
destination where `DSH_PODMAN_HOST_GUEST_AGENT_BIN` is bind-mounted when that
variable is set. When no bind mount is used, a bare name (the default
`dsh-podman-guest-agent`) is resolved through the image's `PATH`.

#### `DSH_PODMAN_GUEST_AGENT_IMAGE`, `DSH_PODMAN_GUEST_AGENT_IMAGE_AGENT_BIN` and `DSH_PODMAN_GUEST_AGENT_IMAGE_DEST_AGENT_BIN`

Without `DSH_PODMAN_GUEST_AGENT_IMAGE`, the guest container must get the
guest agent binary another way — typically a host bind mount (see the previous
section). When it is set, workspace images are instead built as a multi-stage
build that pulls the binary out of the prebuilt guest-agent image and bakes it
into the base image, so no external provisioning is needed:

```
FROM <DSH_PODMAN_GUEST_AGENT_IMAGE> AS guestagent
FROM <base-image>
RUN pacman -Syu --needed --noconfirm <packages...>
COPY --from=guestagent <agent_bin> <dest_agent_bin>
ENTRYPOINT ["<dest_agent_bin>"]
```

`DSH_PODMAN_GUEST_AGENT_IMAGE_AGENT_BIN` is the path of the binary inside the
guest-agent image (default `/bin/dsh-podman-guest-agent`), and
`DSH_PODMAN_GUEST_AGENT_IMAGE_DEST_AGENT_BIN` is where it lands in the built
image (default `/usr/local/bin/dsh-podman-guest-agent`). The binary is only
baked into the base image — other images are unaffected.

#### `DSH_PODMAN_GUEST_TOKEN`

Shared secret required on every guest-agent gRPC call, carried as the gRPC
metadata header `authorization: bearer <token>`. In practice the orchestrator
generates a fresh random token for each workspace and injects it into the
guest container (via `DSH_PODMAN_GUEST_TOKEN`), handing the same value to
the plugin together with the guest socket path — so it normally needs no manual
configuration.

#### `DSH_PODMAN_ORCHESTRATOR_TOKEN`

An arbitrary shared secret string that the orchestrator and the plugin must
agree on; every control-plane request carries it as the gRPC metadata header
`authorization: bearer <token>`. Use a long, random value — for example
`openssl rand -hex 32` — and set the same value on both sides. When the
orchestrator has no token set, it accepts unauthenticated control-plane calls
(relying on the socket's file permissions instead); when a token is set,
requests without the matching header are rejected with `Unauthenticated`.

#### `DSH_PODMAN_SOCKETS_ROOT` and `DSH_PODMAN_HOST_SOCKETS_ROOT`

`DSH_PODMAN_SOCKETS_ROOT` is the socket root directory shared by the
orchestrator and the guest containers. It holds the orchestrator control
socket (`orchestrator.sock`) and one subdirectory per workspace, where each
guest agent creates its `guest.sock`.

The directory needs to be bind-mounted in the orchestrator container. Its mode
should be `0700`, but that is not enforced by the orchestrator.

Each guest container gets exactly one socket directory bind-mounted into
it: the host directory `<DSH_PODMAN_HOST_SOCKETS_ROOT>/<container>` is mounted
at `<DSH_PODMAN_SOCKETS_ROOT>/<container>` inside the container. Because only
that single per-workspace directory is mounted, a guest container never
sees the orchestrator's `orchestrator.sock` nor any other workspace's socket
directory. The control socket file is explicitly set to `0600`.

## Container management UI

The plugin ships a browser half (`./client`, built to `dist/client`) that
registers a card in the dsh **Settings → Plugins** page. The card lists the
orchestrator-created guest containers and the built images, and offers
**Remove**, **Recreate** (same image), and **Recreate with image** plus a
**Reload this view** button.

Data and actions travel over the settings transport:

- The host half registers the `podman` settings namespace and keeps a live
  view (`containers`, `images`, `notice`) in it.
- The card writes an action into `command` (`refresh` / `remove` / `recreate`);
  the host `watch` handler executes it against the orchestrator and pushes the
  refreshed view back.

The orchestrator service gained two gRPC methods to back the UI:
`ListContainers` (returns only the guest containers the orchestrator created —
containers it does not own are never exposed, and a client cannot name a
container directly; workspace slugs are validated so the container name is
always derived server-side from `dsh-workspace-<slug>`) and
`RecreateContainer{workspace_slug, image_id}` (stops, removes, and recreates
the container, optionally with a new image; an empty `image_id` keeps the
workspace's current image). `RemoveContainer{workspace_slug}` removes the
guest container from Podman (the workspace record is left for the plugin to
recreate on next use).

### Building the browser half

The client half's `@deepseek-ai/dsh-client-*` packages are published to npm
(at `0.1.1-rc.2`), so `pnpm install` fetches them and `pnpm run build`
compiles both halves with no extra setup — no checkout path or symlinks
needed. `pnpm run build` runs `tsc -p tsconfig.json` (host) and
`tsc -p tsconfig.client.json` (browser half, emitted under `dist/client`).
The package's `dsh.client` declaration points the web bundle at
`dist/client/index.js`, and the host half must be loaded for the `podman`
settings namespace to exist.

## Releasing and installing from a hosted tarball

The compiled output (`dist/`) is **not committed** to this repository. To
install the plugin on another machine, build a package tarball and host it
over HTTPS, then point `dsh plugin add` at that URL. A `.tgz` is the form
pnpm/npm accept for remote tarball dependencies — a `.zip` archive is not
supported as a dependency spec.

**1. Build and pack** (in a checkout with dev dependencies):

```sh
pnpm install
pnpm run build        # tsc + copy proto/ into dist/
npm pack              # emits exagone313-dsh-podman-<version>.tgz
```

The tarball contains `package.json` (with the `dsh.bundle` declaration),
`dist/` (the compiled plugin), `cordis.patch.yml`, and `README.md`. It
carries **no build scripts**, so installation never runs one (pnpm ≥10
blocks dependency build scripts by default anyway).

**2. Host the `.tgz`** over HTTPS on your own server or as a release asset.

**3. Install** into a dsh profile:

```sh
dsh plugin --profile web add https://your-host/dsh-podman.tgz --allow-build=protobufjs
```

`dsh plugin` forwards the URL to pnpm, which installs the package and
reconciles it into the profile's bundle layer stack (it declares
`dsh.bundle`). The bundled `cordis.patch.yml` disables the built-in
`subprocess` and `fs-sandbox` rows and mounts the plugin:

```yaml
- id: subprocess
  disabled: true
- id: fs-sandbox
  disabled: true
- insert:
    - id: podman
      name: '@exagone313/dsh-podman'
```

Restart dsh for the plugin to load.

**Updating:** a tarball URL pins an exact artifact. Give each release a
versioned filename (`…-0.1.1.tgz`) and re-add / `dsh plugin --profile web
update` with the new URL; a fixed "latest" URL can serve a stale copy from
the pnpm cache.

## License

MIT
