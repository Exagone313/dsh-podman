<!--
SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>

SPDX-License-Identifier: MIT
-->

# Configuration

Environment variables use the `DSH_PODMAN_` prefix and are listed under the
component that reads them (a variable read by several components appears in each
of their sections). The plugin also exposes a few **UI settings** on its
**dsh-podman** page (sidebar **Plugins** panel → **Installed**),
listed separately from env vars.

The plugin reads its configuration from, in order: the plugin `config` in
cordis, then the environment variables below, then built-in defaults.

## Plugin (dsh client) — environment variables

| Variable                        | Default           | Description                                                                                      |
| ------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------ |
| `DSH_PODMAN_ORCHESTRATOR_TOKEN` | —                 | Shared secret authenticating control-plane gRPC calls; see [Variable details](#variable-details) |
| `DSH_PODMAN_PROJECTS_ROOT`      | `/projects`       | Project root used to resolve session working directories into a workspace                        |
| `DSH_PODMAN_SOCKETS_ROOT`       | `/run/dsh-podman` | Socket root the plugin derives the orchestrator control socket (`orchestrator.sock`) from        |

`projectsRoot` and `socketsRoot` are env-only so they match the orchestrator;
`controlToken` comes from the plugin `config` or
`DSH_PODMAN_ORCHESTRATOR_TOKEN`.

## Plugin (dsh client) — UI settings

Editable on the **dsh-podman** page (sidebar **Plugins** panel →
**Installed**; the images' Set-default popup and the **Default environment**
section):

| Setting        | Default     | Description                                                                                                                                                                     |
| -------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `defaultImage` | `archlinux` | Image **short name** used for new workspaces; chosen from base and custom images via the Set-default popup                                                                      |
| `uiLocale`     | `""`        | Plugin-managed active locale, written by the browser client so the host can render approval text in the session language (see [Approval](usage.md#approval)); not user-editable |
| `containerEnv` | `{}`        | Default environment seeded into a container when it is created; see [Default environment](#default-environment)                                                                 |

### Default environment

`containerEnv` is one map of variables seeded into a container when it is
created: the default container of a new workspace and every named container. A
container's own `env` wins per key, and a recreate stores exactly the
environment it is given, so removing a value from a container's environment and
recreating it removes that value for good.

The Podman page's **Default environment** section edits it with the same
key/value rows
a container uses: add or remove variables, then **Save** (or **Discard**).
**Git identity** fills `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`,
`GIT_COMMITTER_NAME` and `GIT_COMMITTER_EMAIL` from one name and one email, and
**Apply default environment variables** adds the missing values to the running
containers that lack them, recreating only those and never overwriting an
existing value; stopped containers are left for their next start. Every
workspace row offers the same action for its own containers. Reserved
`DSH_PODMAN*` keys are ignored, and the values are not secret — use `secretEnv`
for secrets (see [Secrets](usage.md#secrets)).

## Orchestrator (`dsh-podman-orchestrator`)

| Variable                                       | Default                       | Description                                                                                                                                                                                                        |
| ---------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DSH_PODMAN_BASE_IMAGE_PREFIX`                 | `localhost/dsh-podman/base/`  | Prefix under which base images are tagged; a `localhost/` prefix builds them locally, otherwise they are pulled from a public registry                                                                             |
| `DSH_PODMAN_GUEST_AGENT_IMAGE`                 | —                             | Guest-agent image mounted read-only into every guest container; unset disables the feature; see [Variable details](#variable-details)                                                                              |
| `DSH_PODMAN_GUEST_AGENT_IMAGE_AGENT_BIN`       | `/bin/dsh-podman-guest-agent` | Path of the guest agent binary inside the guest-agent image; the container command is `<mount>/<agent_bin>`; see [Variable details](#variable-details)                                                             |
| `DSH_PODMAN_GUEST_AGENT_IMAGE_MOUNT`           | `/opt/dsh-podman/guest-agent` | Container-internal directory where the guest-agent image is mounted read-only; see [Variable details](#variable-details)                                                                                           |
| `DSH_PODMAN_GUEST_AGENT_IMAGE_USE_VERSION_TAG` | `false`                       | When truthy, the guest-agent image reference uses the orchestrator's git version as its tag (replacing the tag in `DSH_PODMAN_GUEST_AGENT_IMAGE`, or adding one when absent); a digest reference panics at startup |
| `DSH_PODMAN_HOST_APK_CACHE`                    | —                             | Host-absolute directory mounted at `/etc/apk/cache` to persist downloaded packages across apk builds; unset disables caching                                                                                       |
| `DSH_PODMAN_HOST_APT_CACHE`                    | —                             | Host-absolute directory mounted at `/var/cache/apt/archives` to persist downloaded packages across apt builds; unset disables caching                                                                              |
| `DSH_PODMAN_HOST_GUEST_AGENT_BIN`              | —                             | Host-side guest agent binary path; bind-mounted when set; see [Variable details](#variable-details)                                                                                                                |
| `DSH_PODMAN_HOST_PACMAN_CACHE`                 | —                             | Host-absolute directory mounted at `/var/cache/pacman/pkg` to persist downloaded packages across pacman builds; unset disables caching                                                                             |
| `DSH_PODMAN_HOST_PROJECTS_ROOT`                | `DSH_PODMAN_PROJECTS_ROOT`    | Host-side projects root used as the source of bind mounts                                                                                                                                                          |
| `DSH_PODMAN_HOST_SOCKETS_ROOT`                 | required                      | Host-side sockets root for guest socket bind mounts; see [Variable details](#variable-details)                                                                                                                     |
| `DSH_PODMAN_IMAGE_PREFIX`                      | `localhost/dsh-podman/`       | Prefix prepended to built workspace image references                                                                                                                                                               |
| `DSH_PODMAN_ORCHESTRATOR_PODMAN_SOCKET`        | required                      | Podman API socket, e.g. `unix:///run/podman/podman.sock`                                                                                                                                                           |
| `DSH_PODMAN_ORCHESTRATOR_STATE`                | required                      | Persisted state directory; see [Variable details](#variable-details)                                                                                                                                               |
| `DSH_PODMAN_ORCHESTRATOR_TOKEN`                | —                             | Shared secret authenticating control-plane gRPC calls; see [Variable details](#variable-details)                                                                                                                   |
| `DSH_PODMAN_PROJECTS_ROOT`                     | `/projects`                   | Project root inside every guest container                                                                                                                                                                          |
| `DSH_PODMAN_SECRET_PREFIX`                     | `dsh-podman-`                 | Prefix applied to managed podman secrets (see [Usage](usage.md#secrets))                                                                                                                                           |
| `DSH_PODMAN_SOCKETS_ROOT`                      | `/run/dsh-podman`             | Socket root directory (bind-mounted from the host); holds `orchestrator.sock` and per-workspace guest sockets; see [Variable details](#variable-details)                                                           |
| `DSH_PODMAN_VOLUME_PREFIX`                     | `dsh-podman-`                 | Prefix applied to managed named volumes (see [Usage](usage.md#mounts-and-volumes))                                                                                                                                 |

## Guest agent (`dsh-podman-guest-agent`)

| Variable                   | Default     | Description                                                                                 |
| -------------------------- | ----------- | ------------------------------------------------------------------------------------------- |
| `DSH_PODMAN_GUEST_SOCKET`  | required    | Unix socket the guest agent serves on; the orchestrator sets it when starting the container |
| `DSH_PODMAN_GUEST_TOKEN`   | —           | Bearer token required on every gRPC call; see [Variable details](#variable-details)         |
| `DSH_PODMAN_PROJECTS_ROOT` | `/projects` | Root where the workspace's project(s) are mounted                                           |

## Variable details

### `DSH_PODMAN_BASE_IMAGE_PREFIX`

Prefix under which base images are tagged, as
`BASE_IMAGE_PREFIX + <short> +
":latest"`. When the prefix starts with
`localhost/`, base images are **built locally** by the orchestrator from their
upstream primitive reference; any other prefix marks them as **public**, in
which case the orchestrator **pulls** the tagged base images from that registry
instead of building them. The built-in base images are `archlinux` (pacman),
`ubuntu` (apt), and `alpine` (apk); their short names are reserved and cannot be
built over, rebuilt, or removed as custom images.

### `DSH_PODMAN_GUEST_AGENT_IMAGE` and `DSH_PODMAN_HOST_GUEST_AGENT_BIN`

When `DSH_PODMAN_GUEST_AGENT_IMAGE` is set, the orchestrator mounts that image
read-only into every guest container at `DSH_PODMAN_GUEST_AGENT_IMAGE_MOUNT`
(default `/opt/dsh-podman/guest-agent`) and runs the guest agent binary from
`<mount>/<agent_bin>` — that path is the container command (see the next section
for the binary path and mount location).

`DSH_PODMAN_HOST_GUEST_AGENT_BIN` is the path _on the host_ of a guest agent
binary. Setting it bind-mounts that binary read-only to the same in-container
path instead of mounting the guest-agent image; it is an optional development
fallback and takes precedence over the image mount. It is unset by default.

If neither variable is configured, the orchestrator refuses to start.

### `DSH_PODMAN_GUEST_AGENT_IMAGE`, `DSH_PODMAN_GUEST_AGENT_IMAGE_AGENT_BIN`, `DSH_PODMAN_GUEST_AGENT_IMAGE_MOUNT` and `DSH_PODMAN_GUEST_AGENT_IMAGE_USE_VERSION_TAG`

The guest-agent image provides the agent at container creation: the orchestrator
mounts it **read-only** into every guest container at
`DSH_PODMAN_GUEST_AGENT_IMAGE_MOUNT` (default `/opt/dsh-podman/guest-agent`)
using podman's image-mount mechanism, and the container command is
`<mount>/<agent_bin>`. Podman image volumes are always mounted read-only.

The mount is **hidden** — the orchestrator injects it itself, so it is not
listed among the user mounts. Because the agent is provided at runtime,
rebuilding base images is no longer needed when the guest-agent version changes.

`DSH_PODMAN_GUEST_AGENT_IMAGE_AGENT_BIN` is the path of the binary inside the
guest-agent image (default `/bin/dsh-podman-guest-agent`).

With `DSH_PODMAN_GUEST_AGENT_IMAGE_USE_VERSION_TAG` set to a truthy value, the
orchestrator uses its own git version as the image tag instead of the one in
`DSH_PODMAN_GUEST_AGENT_IMAGE` (which may omit the tag entirely). Because a
digest reference cannot be overridden, the orchestrator fails to start when that
variable is set alongside a digest-style `DSH_PODMAN_GUEST_AGENT_IMAGE`.

A container whose agent was created from a different guest-agent image than the
one currently configured is recreated the next time it is used, so upgrading the
orchestrator takes effect without recreating containers by hand. The image is
pulled only when it is absent, so a locally built development image is never
pulled over.

### `DSH_PODMAN_GUEST_TOKEN`

Shared secret required on every guest-agent gRPC call, carried as the gRPC
metadata header `authorization: bearer <token>`. In practice the orchestrator
generates a fresh random token for each workspace and injects it into the guest
container (via `DSH_PODMAN_GUEST_TOKEN`), handing the same value to the plugin
together with the guest socket path — so it normally needs no manual
configuration.

### `DSH_PODMAN_ORCHESTRATOR_TOKEN`

An arbitrary shared secret string that the orchestrator and the plugin must
agree on; every control-plane request carries it as the gRPC metadata header
`authorization: bearer <token>`. Use a long, random value — for example
`openssl rand -hex 32` — and set the same value on both sides. When the
orchestrator has no token set, it accepts unauthenticated control-plane calls
(relying on the socket's file permissions instead); when a token is set,
requests without the matching header are rejected with `Unauthenticated`.

### `DSH_PODMAN_ORCHESTRATOR_STATE`

The directory the orchestrator persists its state in (workspaces, containers,
and image records). It is required, and must be an absolute path to a directory
bind-mounted into the orchestrator so the state survives a container restart:
only the deployment knows where that is. The shipped Quadlet mounts
`%h/.dsh/dsh-podman/state`. The orchestrator creates the directory if needed and
refuses to start without the variable.

### `DSH_PODMAN_SOCKETS_ROOT` and `DSH_PODMAN_HOST_SOCKETS_ROOT`

`DSH_PODMAN_SOCKETS_ROOT` is the socket root directory shared by the
orchestrator and the guest containers. It holds the orchestrator control socket
(`orchestrator.sock`) and one subdirectory per workspace, where each guest agent
creates its `guest.sock`. It keeps its `/run/dsh-podman` default.

`DSH_PODMAN_HOST_SOCKETS_ROOT` is required: it is the same directory as it
appears on the host, and it cannot be derived from the container path — the
shipped Quadlet mounts `%t/dsh-podman` at `/run/dsh-podman`. The orchestrator
refuses to start without it.

The directory needs to be bind-mounted in the orchestrator container. Its mode
must be `0700`: the orchestrator refuses to start when the socket root is group-
or world-accessible, since the control plane is a full-privilege interface onto
the Podman API and the socket's own mode only helps while the directory above it
stays private.

Each guest container gets exactly one socket directory bind-mounted into it: the
host directory `<DSH_PODMAN_HOST_SOCKETS_ROOT>/<container>` is mounted at
`<DSH_PODMAN_SOCKETS_ROOT>/<container>` inside the container. Because only that
single per-workspace directory is mounted, a guest container never sees the
orchestrator's `orchestrator.sock` nor any other workspace's socket directory.
Both the control socket and each guest socket are created with mode `0600`, and
both processes set a `0077` umask at startup so the socket is never briefly
reachable between `bind` and `chmod`.
