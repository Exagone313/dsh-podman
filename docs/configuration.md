<!--
SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>

SPDX-License-Identifier: MIT
-->

# Configuration

Environment variables use the `DSH_PODMAN_` prefix and are listed under the
component that reads them (a variable read by several components appears in
each of their sections). The plugin also exposes a few **UI settings** in the
dsh **Settings → Plugins** card, listed separately from env vars.

The plugin reads its configuration from, in order: the plugin `config` in
cordis, then the environment variables below, then built-in defaults.

## Plugin (dsh client) — environment variables

| Variable | Default | Description |
|---|---|---|
| `DSH_PODMAN_IMAGE_PREFIX` | `localhost/dsh-podman/` | Prefix prepended to workspace image references |
| `DSH_PODMAN_ORCHESTRATOR_TOKEN` | — | Shared secret authenticating control-plane gRPC calls; see [Variable details](#variable-details) |
| `DSH_PODMAN_PROJECTS_ROOT` | `/projects` | Project root used to resolve session working directories into a workspace |
| `DSH_PODMAN_SOCKETS_ROOT` | `/run/dsh-podman` | Socket root the plugin derives the orchestrator control socket (`orchestrator.sock`) from |

`projectsRoot` and `imagePrefix` are env-only so they match the orchestrator;
`controlToken` comes from the plugin `config` or `DSH_PODMAN_ORCHESTRATOR_TOKEN`.

## Plugin (dsh client) — UI settings

Editable in the card's **Settings → Plugins → Podman** panel (the Configuration
section and the images' Set-default popup):

| Setting | Default | Description |
|---|---|---|
| `defaultImage` | `archlinux` | Image **short name** used for new workspaces; chosen from base and custom images via the Set-default popup |
| `socketsRoot` | `DSH_PODMAN_SOCKETS_ROOT` | Socket root the plugin uses to reach the orchestrator; falls back to the env var |

## Orchestrator (`dsh-podman-orchestrator`)

| Variable | Default | Description |
|---|---|---|
| `DSH_PODMAN_BASE_IMAGE_PREFIX` | `localhost/dsh-podman/base/` | Prefix under which base images are tagged; a `localhost/` prefix builds them locally, otherwise they are pulled from a public registry |
| `DSH_PODMAN_GUEST_AGENT_BIN` | `dsh-podman-guest-agent` | Guest agent binary path (container-internal); see [Variable details](#variable-details) |
| `DSH_PODMAN_GUEST_AGENT_IMAGE_AGENT_BIN` | `/bin/dsh-podman-guest-agent` | Path of the guest agent binary inside the guest-agent image; see [Variable details](#variable-details) |
| `DSH_PODMAN_GUEST_AGENT_IMAGE_DEST_AGENT_BIN` | `/usr/local/bin/dsh-podman-guest-agent` | Destination path for the copied binary inside built workspace images; see [Variable details](#variable-details) |
| `DSH_PODMAN_GUEST_AGENT_IMAGE` | — | Prebuilt guest-agent image baked into workspace images; unset disables the feature; see [Variable details](#variable-details) |
| `DSH_PODMAN_HOST_APK_CACHE` | — | Host-absolute directory mounted at `/etc/apk/cache` to persist downloaded packages across apk builds; unset disables caching |
| `DSH_PODMAN_HOST_APT_CACHE` | — | Host-absolute directory mounted at `/var/cache/apt/archives` to persist downloaded packages across apt builds; unset disables caching |
| `DSH_PODMAN_HOST_GUEST_AGENT_BIN` | — | Host-side guest agent binary path; bind-mounted when set; see [Variable details](#variable-details) |
| `DSH_PODMAN_HOST_PACMAN_CACHE` | — | Host-absolute directory mounted at `/var/cache/pacman/pkg` to persist downloaded packages across pacman builds; unset disables caching |
| `DSH_PODMAN_HOST_PROJECTS_ROOT` | `DSH_PODMAN_PROJECTS_ROOT` | Host-side projects root used as the source of bind mounts |
| `DSH_PODMAN_HOST_SOCKETS_ROOT` | `DSH_PODMAN_SOCKETS_ROOT` | Host-side sockets root for guest socket bind mounts |
| `DSH_PODMAN_IMAGE_PREFIX` | `localhost/dsh-podman/` | Prefix prepended to built workspace image references |
| `DSH_PODMAN_ORCHESTRATOR_PODMAN_SOCKET` | required | Podman API socket, e.g. `unix:///run/podman/podman.sock` |
| `DSH_PODMAN_ORCHESTRATOR_STATE` | `/var/lib/dsh-orchestrator` | Persisted state directory |
| `DSH_PODMAN_ORCHESTRATOR_TOKEN` | — | Shared secret authenticating control-plane gRPC calls; see [Variable details](#variable-details) |
| `DSH_PODMAN_PROJECTS_ROOT` | `/projects` | Project root inside every guest container |
| `DSH_PODMAN_SECRET_PREFIX` | `dsh-podman-` | Prefix applied to managed podman secrets (see [Usage](usage.md#secrets)) |
| `DSH_PODMAN_SOCKETS_ROOT` | `/run/dsh-podman` | Socket root directory (bind-mounted from the host); holds `orchestrator.sock` and per-workspace guest sockets; see [Variable details](#variable-details) |
| `DSH_PODMAN_VOLUME_PREFIX` | `dsh-podman-` | Prefix applied to managed named volumes (see [Usage](usage.md#mounts-and-volumes)) |

## Guest agent (`dsh-podman-guest-agent`)

| Variable | Default | Description |
|---|---|---|
| `DSH_PODMAN_GUEST_SOCKET` | required | Unix socket the guest agent serves on; the orchestrator sets it when starting the container |
| `DSH_PODMAN_GUEST_TOKEN` | — | Bearer token required on every gRPC call; see [Variable details](#variable-details) |
| `DSH_PODMAN_PROJECTS_ROOT` | `/projects` | Root where the workspace's project(s) are mounted |

## Variable details

### `DSH_PODMAN_BASE_IMAGE_PREFIX`

Prefix under which base images are tagged, as `BASE_IMAGE_PREFIX + <short> +
":latest"`. When the prefix starts with `localhost/`, base images are **built
locally** by the orchestrator from their upstream primitive reference; any
other prefix marks them as **public**, in which case the orchestrator **pulls**
the tagged base images from that registry instead of building them. The built-in
base images are `archlinux` (pacman), `ubuntu` (apt), and `alpine` (apk); their
short names are reserved and cannot be built over, rebuilt, or removed as custom
images.

### `DSH_PODMAN_GUEST_AGENT_BIN` and `DSH_PODMAN_HOST_GUEST_AGENT_BIN`

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

### `DSH_PODMAN_GUEST_AGENT_IMAGE`, `DSH_PODMAN_GUEST_AGENT_IMAGE_AGENT_BIN` and `DSH_PODMAN_GUEST_AGENT_IMAGE_DEST_AGENT_BIN`

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

### `DSH_PODMAN_GUEST_TOKEN`

Shared secret required on every guest-agent gRPC call, carried as the gRPC
metadata header `authorization: bearer <token>`. In practice the orchestrator
generates a fresh random token for each workspace and injects it into the
guest container (via `DSH_PODMAN_GUEST_TOKEN`), handing the same value to
the plugin together with the guest socket path — so it normally needs no manual
configuration.

### `DSH_PODMAN_ORCHESTRATOR_TOKEN`

An arbitrary shared secret string that the orchestrator and the plugin must
agree on; every control-plane request carries it as the gRPC metadata header
`authorization: bearer <token>`. Use a long, random value — for example
`openssl rand -hex 32` — and set the same value on both sides. When the
orchestrator has no token set, it accepts unauthenticated control-plane calls
(relying on the socket's file permissions instead); when a token is set,
requests without the matching header are rejected with `Unauthenticated`.

### `DSH_PODMAN_SOCKETS_ROOT` and `DSH_PODMAN_HOST_SOCKETS_ROOT`

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