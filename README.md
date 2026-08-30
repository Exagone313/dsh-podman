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
| `@exagone313/dsh-podman` | Inside dsh itself | Registers `ctx.subprocess` and `ctx.fs` backed by the orchestrator |

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
| `DSH_PODMAN_BUILD_DEFAULT_IMAGE_WITH_PULL` | `true` | Whether the default-image build always pulls its upstream base image; see [Variable details](#variable-details) |
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
| `DSH_PODMAN_VOLUME_PREFIX` | `dsh-podman-` | Prefix applied to managed named volumes (see [Mounts and volumes](#mounts-and-volumes)) |
| `DSH_PODMAN_SECRET_PREFIX` | `dsh-podman-` | Prefix applied to managed podman secrets (see [Secrets](#secrets)) |

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

#### `DSH_PODMAN_BUILD_DEFAULT_IMAGE_WITH_PULL`

When truthy (the default), the build of the default (base) workspace image
passes `PullAlways` to podman, so the upstream base image
(`docker.io/library/archlinux:latest`) is always fetched fresh instead of
reusing a cached copy. This only ever applies to the default-image build —
user image builds never pull.

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

The orchestrator service exposes gRPC methods to back the UI and the tools:
`ListContainers` (returns only the guest containers the orchestrator created —
containers it does not own are never exposed, and a client cannot name a
container directly; workspace slugs are validated so the container name is
always derived server-side from `dsh-workspace-<slug>`), `StartContainer`,
`RecreateContainer{workspace_slug, container, image_id, mounts}` (stops,
removes, and recreates the container, optionally with a new image or project
mounts; an empty `image_id` keeps the workspace's current image),
`RemoveContainer`, `AddContainerMount`, and `RemoveContainerMount`. Containers
of a workspace run
inside a shared podman pod (`dsh-pod-<slug>`) so they share a network
namespace, and their root filesystems are mounted read-only. Recreating a
container or shutting down the orchestrator first asks the container's guest
agent to gracefully stop its daemons (SIGTERM, ~10s grace) before podman tears
the container down.

Beyond project mounts, a container can mount named volumes (prefixed
`DSH_PODMAN_VOLUME_PREFIX`, default `dsh-podman-`, and auto-created by podman
on first use) or tmpfs at arbitrary container paths — but never under the
projects root, which is reserved for project mounts.

### Building the browser half

The client half's `@deepseek-ai/dsh-client-*` packages are published to npm
(at `0.1.1-rc.2`), so `pnpm install` fetches them and `pnpm run build`
compiles both halves with no extra setup — no checkout path or symlinks
needed. `pnpm run build` runs `tsc -p tsconfig.json` (host) and
`tsc -p tsconfig.client.json` (browser half, emitted under `dist/client`).
The package's `dsh.client` declaration points the web bundle at
`dist/client/index.js`, and the host half must be loaded for the `podman`
settings namespace to exist.

## Tools

The plugin registers the following model-facing tools. Tools marked `✱`
require approval (some only under certain parameters — noted in their row).
Container tools operate on a **logical container name** of
the current workspace (`"default"` selects the workspace's default container).

Approval is enforced by the plugin itself through a `tools/pre-execute`
policy that reads the session's permission knobs (sandbox mode + approval
policy, folded from the session log):
- **Read Only** — only the get/list tools run (`image_list`, `image_get`,
  `container_list`, `container_read`, `container_glob`, `container_grep`,
  `container_mount_list`, `volume_list`, `daemon_list`, `daemon_logs`); every
  other plugin tool is denied. DSH-native tools keep their own sandbox
  behavior.
- **Workspace Write** — the `✱` tools ask through DSH's approval service
  (the call shows the standard approval prompt and is denied when no approval
  channel is available); `container_start` asks only when `mounts` is passed.
- **Full access** — tools run without approval prompts.

The prompt's reason summarizes the call's key parameters inline
(image id/base/packages, container/image, and each mount with its kind,
destination, and `(ro)` read-only marker). The settings-card actions are
direct control calls and are not gated.

`container_start`, `container_recreate`, and `container_bash` accept an `env`
map applied to the container (or the bash process); `container_exec` and
`daemon_start` already accept `env`, and `daemon_restart` reuses a daemon's
stored environment. Environment variables are not treated as secrets, so the
approval reason and `container_list` show the variable **keys**. Keys starting
with `DSH_PODMAN` are reserved and rejected, since the orchestrator uses that
namespace for guest-agent wiring.

### Podman operator mode

The plugin ships an **agent preset** named *Podman operator mode* (id
`podman-ops`). On load it installs the preset into the harness's user-presets
root (`~/.dsh/.agent-presets/podman-ops/`) unless a composition already exists
there, so the user can edit or delete it and it is never overwritten. It
appears in the session's agent-preset picker next to the shipped presets.

The preset composes a Podman-focused persona with the built-in task tools
(`ask_user_question`, `todo_write`) and `web_search` (web fetch disabled). It
does not mount the host shell, host filesystem, or the coding-agent rows
(subagents, workflows, skills, goal, plan mode, jobs). The plugin's own tools
are global and all remain available, split as:

- **Direct:** `image_list`, `image_get`, `container_list`, `container_read`,
  `container_glob`, `container_grep`, `container_mount_list`, `volume_list`,
  `daemon_list`, `daemon_logs`, `container_start` (asks only when `mounts` is
  passed).
- **Approval-gated** (the usual `✱` tools): `image_build`, `image_rebuild`,
  `image_remove`, `container_recreate`, `container_remove`,
  `container_mount_add`, `container_mount_remove`, `volume_remove`.
- **Approval-gated only in this preset:** `container_bash`, `container_exec`,
  `container_write`, `container_edit`, `daemon_start` — so the agent can run
  commands, edit container files, or start daemons once the user approves,
  without those tools asking in other presets.

The permission knobs above still apply (Read Only allows only the direct
read/list tools; Full access skips every prompt).

Image references (`imageId`, `baseImage`, `image`) accept a stored image id
(short, e.g. `valkey`, or fully qualified, e.g. `localhost/dsh-podman/valkey`)
with or without a `:tag`, or an already-qualified tag such as
`localhost/dsh-podman/valkey:latest`. The base image cannot be built over,
rebuilt, or removed.

`image_rebuild_all` rebuilds the stored images **in dependency order**, one at
a time — the default (base) image first (when `DSH_PODMAN_BUILD_DEFAULT_IMAGE`
is enabled; otherwise it is left as-is and derived images rebuild against it),
then each derived image after its base. An image whose rebuild fails, and every
image that depends on it, is reported in `skipped` while the rest continue.

### Images

| Tool | Params | Description |
|---|---|---|
| `image_list` | — | List the built workspace images |
| `image_get` | `imageId` | Details for one image |
| `image_build` ✱ | `imageId`, `baseImage`, `packages` | Build a new image from a base image and package list |
| `image_rebuild` ✱ | `imageId` | Rebuild an existing image in place |
| `image_rebuild_all` ✱ | — | Rebuild every image in dependency order (base first), skipping any image whose rebuild fails and its dependents |
| `image_remove` ✱ | `imageId` | Remove a built image; refused while a workspace or container still references it |

### Containers

| Tool | Params | Description |
|---|---|---|
| `container_list` | — | List the containers of the current workspace |
| `container_start` `✱*` | `container`, optional `image`, `mounts`, `env` | Start a container (default image when `image` is omitted); approval required only when `mounts` is passed |
| `container_recreate` ✱ | `container`, optional `image`, `mounts`, `env` | Recreate a container, keeping its current image when `image` is omitted, optionally with new project mounts or environment |
| `container_remove` ✱ | `container` | Remove a container (stops its daemons gracefully first) |
| `container_bash` | `container`, `command`, optional `workdir`, `env` | Run a shell command |
| `container_exec` | `container`, `argv`, optional `cwd`, `env` | Run a program |
| `container_read` | `container`, `path` | Read a file |
| `container_write` | `container`, `path`, `content`, optional `create`, `truncate` | Write a file |
| `container_edit` | `container`, `path`, `oldString`, `newString`, optional `replaceAll` | Edit a file |
| `container_glob` | `container`, `pattern`, optional `cwd` | List files matching a pattern |
| `container_grep` | `container`, `pattern`, optional `path`, `cwd` | Search files for a regex |

### Mounts and volumes

| Tool | Params | Description |
|---|---|---|
| `container_mount_list` | `container` | List the container's mounts |
| `container_mount_add` ✱ | `container`, optional `kind`, `project`, `path`, `destination`, `mode`, `volume`, `secret` | Add a mount; `kind` is `project` (default), `tmpfs`, `volume`, or `secret` |
| `container_mount_remove` ✱ | `container`, optional `kind`, `project`, `path`, `volume`, `destination`, `secret` | Remove a mount |
| `volume_list` | — | List the managed named volumes (short names) |
| `volume_create` | `name` | Create a managed named volume |
| `volume_remove` ✱ | `name` | Remove a managed named volume |

A `project` mount binds a directory from the project's workspace; `tmpfs`
mounts a writable in-memory filesystem and `volume` mounts a podman named
volume (auto-created on first use) — both at an arbitrary absolute container
path, never under the projects root. `mode` is `read_only` or `read_write`.

### Secrets

| Tool | Params | Description |
|---|---|---|
| `secret_list` | — | List the managed secrets (short names) |
| `secret_create` | `name`, optional `length`, `charset` | Create a secret with an **orchestrator-generated random** value (`length` default 32; `charset` `alphanumeric` \| `hex` \| `base64url`) |
| `secret_remove` ✱ | `name` | Remove a managed secret |
| `container_secret_add` ✱ | `container`, `env`, `secret` | Attach a secret to a container as an environment variable |
| `container_secret_remove` ✱ | `container`, `env` | Detach a secret environment variable from a container |

Secrets are stored in podman under `DSH_PODMAN_SECRET_PREFIX` (default
`dsh-podman-`); the tools and UI use short names. `secret_create` values are
generated server-side with `crypto/rand` and **never exposed** — there is no
read tool. A secret can be attached to a container either as a **mount**
(`container_mount_add kind="secret"` + `secret` + `destination`, read-only, at
an absolute path never under the projects root) or as an **environment
variable** (`container_secret_add`; the env var name must not start with
`DSH_PODMAN`). The settings card can **overwrite** a secret with user-typed
content (write-only) but never reads it.

### Daemons

| Tool | Params | Description |
|---|---|---|
| `daemon_start` | `container`, `argv`, optional `name`, `cwd`, `env`, `uid`, `gid`, `groups` | Start a background daemon; optional `uid`/`gid`/`groups` run it as another user |
| `daemon_list` | `container` | List the daemons (including their effective `uid`/`gid`) |
| `daemon_stop` | `container`, `name`, optional `signal` | Stop a daemon |
| `daemon_restart` | `container`, `name` | Restart a daemon with the same command, environment, and user |
| `daemon_logs` | `container`, `name`, optional `tailBytes` | Tail a daemon's stdout/stderr |

Daemons run as the container user by default. When only `uid` is set, `gid`
defaults to the same value; when neither is set, the daemon runs without any
uid/gid override. `daemon_list` reports the effective `uid`/`gid` of each
daemon.

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
