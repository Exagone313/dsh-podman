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
| `dsh-podman-orchestrator` | A container with access to the Podman API | Owns the control socket and persisted state; creates/removes workspace containers; builds workspace images |
| `dsh-podman-guest-agent` | Inside every workspace container | Serves the exec/filesystem gRPC API for one workspace |
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

All variables use the `DSH_PODMAN_` prefix. Values shared between the
orchestrator and the guest agents use the bare prefix; orchestrator-only and
guest-only values are namespaced under `DSH_PODMAN_ORCHESTRATOR_` and
`DSH_PODMAN_GUEST_` respectively.

### Shared

| Variable | Default | Description |
|---|---|---|
| `DSH_PODMAN_PROJECTS_ROOT` | `/projects` | Project root inside every container; also the guest agent's workspace root |
| `DSH_PODMAN_DEFAULT_IMAGE` | `arch-base` | Default workspace image id |

### Orchestrator (`dsh-podman-orchestrator`)

| Variable | Default | Description |
|---|---|---|
| `DSH_PODMAN_ORCHESTRATOR_PODMAN_SOCKET` | required | Podman API socket, e.g. `unix:///run/podman/podman.sock` |
| `DSH_PODMAN_ORCHESTRATOR_SOCKETS_ROOT` | `/run/dsh-sockets` | Directory for the control socket and per-workspace guest sockets |
| `DSH_PODMAN_ORCHESTRATOR_STATE` | `/var/lib/dsh-orchestrator` | Persisted state directory |
| `DSH_PODMAN_HOST_PROJECTS_ROOT` | `DSH_PODMAN_PROJECTS_ROOT` | Host-side projects root used as the source of bind mounts |
| `DSH_PODMAN_HOST_SOCKETS_ROOT` | `DSH_PODMAN_ORCHESTRATOR_SOCKETS_ROOT` | Host-side sockets root for guest socket bind mounts |
| `DSH_PODMAN_GUEST_AGENT_BIN` | `dsh-podman-guest-agent` | Guest agent binary path (container-internal); resolved via the image's `PATH` when unset |
| `DSH_PODMAN_HOST_GUEST_AGENT_BIN` | — | Host-side guest agent binary path; bind-mounted when set |
| `DSH_PODMAN_HOST_PACMAN_CACHE` | — | Host-absolute Buildah cache directory used by workspace-image builds |

### Guest agent (`dsh-podman-guest-agent`)

| Variable | Default | Description |
|---|---|---|
| `DSH_PODMAN_GUEST_SOCKET` | `/run/dsh-sockets/guest.sock` | Unix socket the guest agent serves on |
| `DSH_PODMAN_GUEST_TOKEN` | — | Bearer token required on every gRPC call |

The plugin itself reads `DSH_PODMAN_ORCHESTRATOR_CONTROL_SOCKET`
(default `/run/dsh-sockets/control.sock`) to reach the orchestrator. Its
`projectsRoot` default is `/mnt/project`; both are overridable through the
plugin's `cordis.yml` config (`controlSocket`, `defaultImage`, `projectsRoot`).

## Container management UI

The plugin ships a browser half (`./client`, built to `dist/client`) that
registers a card in the dsh **Settings → Plugins** page. The card lists every
container and built image, and offers **Stop**, **Recreate** (same image), and
**Recreate with image** plus a **Reload** button.

Data and actions travel over the settings transport:

- The host half registers the `podman` settings namespace and keeps a live
  view (`containers`, `images`, `notice`) in it.
- The card writes an action into `command` (`refresh` / `stop` / `recreate`);
  the host `watch` handler executes it against the orchestrator and pushes the
  refreshed view back.

The orchestrator service gained two gRPC methods to back the UI:
`ListContainers` (enumerates every container on the Podman socket and joins it
with stored workspace metadata) and `RecreateContainer{workspace_slug,
image_id}` (stops, removes, and recreates the container, optionally with a new
image; an empty `image_id` keeps the workspace's current image).
`StopWorkspace` (existing) backs the Stop button.

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
dsh plugin --profile web add https://your-host/dsh-podman.tgz
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
