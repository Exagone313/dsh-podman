<!--
SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>

SPDX-License-Identifier: MIT
-->

# Usage

This page documents the model-facing tools, the settings card, and the image
model. See [Architecture](architecture.md) for how the pieces fit together.

## Image model

dsh-podman organizes the images its containers run into three tiers:

- **Primitive images** are public upstream images pulled from the internet, e.g.
  `docker.io/library/ubuntu:latest`. The base registry pins their full
  references; they serve only as the `FROM` when building a base image and are
  never referenced directly.
- **Base images** are the fixed, built-in set provided by dsh-podman:
  `archlinux` (pacman), `ubuntu` (apt), and `alpine` (apk). Each is defined by
  its primitive, a dsh-podman-owned default package list, and its package
  manager. By default they are **built locally** from the primitive (installing
  the default packages); when `DSH_PODMAN_BASE_IMAGE_PREFIX` points at a
  registry (anything not starting with `localhost/`), they are **pulled**
  instead. Base images are listed in the settings UI even when not yet
  built/pulled, are rebuilt or pulled from the card, and their short names are
  reserved — they cannot be built over, rebuilt, or removed as custom images.
- **Custom images** are user-built images created from a **parent** — a base
  image or another custom image — inheriting its package manager and adding
  extra packages on top. They are referenced by their short name (e.g.
  `valkey`).

Image references (`imageId`, `parent`, `image`) are **short names only** (no
registry prefix, no `:tag`).

## Tools

The plugin registers the following model-facing tools. Tools marked `✱` require
approval (some only under certain parameters — noted in their row). Container
tools operate on a **logical container name** of the current workspace
(`"default"` selects the workspace's default container).

### Approval

Approval is enforced by the plugin itself through a `tools/pre-execute` policy
that reads the session's permission knobs (sandbox mode + approval policy,
folded from the session log):

- **Read Only** — only the get/list tools run (`image_list`, `image_get`,
  `container_list`, `container_read`, `container_glob`, `container_grep`,
  `container_mount_list`, `volume_list`, `secret_list`, `daemon_list`,
  `daemon_logs`); every other plugin tool is denied. DSH-native tools keep their
  own sandbox behavior.
- **Workspace Write** — the `✱` tools ask through DSH's approval service (the
  call shows the standard approval prompt and is denied when no approval channel
  is available); `container_start` asks only when `mounts` is passed.
- **Full access** — tools run without approval prompts.

The prompt's reason summarizes the call's key parameters inline (image
id/base/packages, container/image, and each mount with its kind, destination,
and `(ro)` read-only marker). The settings-card actions are direct control calls
and are not gated.

`container_start`, `container_recreate`, and `container_bash` accept an `env`
map applied to the container (or the bash process); `container_exec` and
`daemon_start` already accept `env`, and `daemon_restart` reuses a daemon's
stored environment. `container_start` and `container_recreate` also accept a
`secretEnv` map (env var name → secret short name) that attaches existing
secrets to the container's environment — see [Secrets](#secrets). Environment
variables are not treated as secrets, so the approval reason and
`container_list` show the variable **keys**. Keys starting with `DSH_PODMAN` are
reserved and rejected, since the orchestrator uses that namespace for
guest-agent wiring.

### Images

| Tool                  | Params                          | Description                                                                                                                       |
| --------------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `image_build` ✱       | `imageId`, `parent`, `packages` | Build a new custom image from a base or custom parent and package list                                                            |
| `image_get`           | `imageId`                       | Details for one image                                                                                                             |
| `image_list`          | —                               | List the built workspace images, base images first                                                                                |
| `image_rebuild_all` ✱ | —                               | Ensure every base, then rebuild every custom image in dependency order, skipping any image whose rebuild fails and its dependents |
| `image_rebuild` ✱     | `imageId`                       | Rebuild an existing custom image in place                                                                                         |
| `image_remove` ✱      | `imageId`                       | Remove a built image; refused while a workspace or container still references it                                                  |

### Containers

| Tool                   | Params                                                               | Description                                                                                                                |
| ---------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `container_bash`       | `container`, `command`, optional `workdir`, `env`                    | Run a shell command                                                                                                        |
| `container_edit`       | `container`, `path`, `oldString`, `newString`, optional `replaceAll` | Edit a file                                                                                                                |
| `container_exec`       | `container`, `argv`, optional `cwd`, `env`                           | Run a program                                                                                                              |
| `container_glob`       | `container`, `pattern`, optional `cwd`                               | List files matching a pattern                                                                                              |
| `container_grep`       | `container`, `pattern`, optional `path`, `cwd`                       | Search files for a regex                                                                                                   |
| `container_list`       | —                                                                    | List the containers of the current workspace                                                                               |
| `container_read`       | `container`, `path`                                                  | Read a file                                                                                                                |
| `container_recreate` ✱ | `container`, optional `image`, `mounts`, `env`, `secretEnv`          | Recreate a container, keeping its current image when `image` is omitted, optionally with new project mounts or environment |
| `container_remove` ✱   | `container`                                                          | Remove a container (stops its daemons gracefully first)                                                                    |
| `container_start` ✱    | `container`, optional `image`, `mounts`, `env`, `secretEnv`          | Start a container (default image when `image` is omitted); approval required only when `mounts` is passed                  |
| `container_write`      | `container`, `path`, `content`, optional `create`, `truncate`        | Write a file                                                                                                               |

Paths and working directories may be absolute or relative. A relative value is
resolved against the session's working directory, which is also where the
project is mounted inside the container. A `path` on `container_read`,
`container_write` and `container_edit` may not contain a `..` segment; working
directories may, since commands are not confined to the projects root.

When no working directory is given, `container_bash`, `container_exec`,
`container_glob`, `container_grep` and `daemon_start` run in the session's
working directory (like the harness's `bash` tool). That directory must be
mounted in the container — otherwise the guest agent's own working directory is
used. An explicit `workdir`/`cwd` always takes precedence.

The file tools (`container_read`, `container_write`, `container_edit`) can reach
the workspace's mounts: the project directory under the projects root, as well
as any `volume` and `tmpfs` mounts at their absolute destinations. `secret`
mounts are not exposed through the file API — the secret value is only readable
by processes running inside the container.

### Mounts and volumes

| Tool                       | Params                                                                                     | Description                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `container_mount_add` ✱    | `container`, optional `kind`, `project`, `path`, `destination`, `mode`, `volume`, `secret` | Add a mount; `kind` is `project` (default), `tmpfs`, `volume`, or `secret` |
| `container_mount_list`     | `container`                                                                                | List the container's mounts                                                |
| `container_mount_remove` ✱ | `container`, optional `kind`, `project`, `path`, `volume`, `destination`, `secret`         | Remove a mount                                                             |
| `volume_create`            | `name`                                                                                     | Create a managed named volume                                              |
| `volume_list`              | —                                                                                          | List the managed named volumes (short names)                               |
| `volume_remove` ✱          | `name`                                                                                     | Remove a managed named volume; refused while a container still mounts it   |

A `project` mount binds a directory from the project's workspace; `tmpfs` mounts
a writable in-memory filesystem and `volume` mounts a podman named volume
(auto-created on first use) — both at an arbitrary absolute container path,
never under the projects root or another reserved path. A `secret` mount exposes
a managed secret as a read-only file at an absolute container path (see
[Secrets](#secrets)).

Project mounts do not take a `destination`: a project directory is always
mounted at its mirrored path under the projects root. `destination` applies only
to `tmpfs`, `volume` and `secret` mounts.

`mode` is `read_only` or `read_write`, and defaults to `read_only` so that
adding a mount never grants write access that was not asked for. `tmpfs` mounts
are always `read_write`, and `secret` mounts take no mode. The workspace's own
project mount is created `read_write`; that is unchanged.

A **named container** carries exactly the mounts it was created with: the
workspace project directory is not mounted automatically. The **default
container** always keeps its workspace project mount, which cannot be removed.

### Secrets

| Tool                        | Params                               | Description                                                                                                                             |
| --------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `container_secret_add` ✱    | `container`, `env`, `secret`         | Attach a secret to a container as an environment variable                                                                               |
| `container_secret_remove` ✱ | `container`, `env`                   | Detach a secret environment variable from a container                                                                                   |
| `secret_create`             | `name`, optional `length`, `charset` | Create a secret with an **orchestrator-generated random** value (`length` default 32; `charset` `alphanumeric` \| `hex` \| `base64url`) |
| `secret_list`               | —                                    | List the managed secrets (short names)                                                                                                  |
| `secret_remove` ✱           | `name`                               | Remove a managed secret; refused while a container mounts it or attaches it as an environment variable                                  |

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

| Tool             | Params                                                                     | Description                                                                     |
| ---------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `daemon_list`    | `container`                                                                | List the daemons (including their effective `uid`/`gid`)                        |
| `daemon_logs`    | `container`, `name`, optional `tailBytes`                                  | Tail a daemon's stdout/stderr                                                   |
| `daemon_restart` | `container`, `name`                                                        | Restart a daemon with the same command, environment, and user                   |
| `daemon_start`   | `container`, `argv`, optional `name`, `cwd`, `env`, `uid`, `gid`, `groups` | Start a background daemon; optional `uid`/`gid`/`groups` run it as another user |
| `daemon_stop`    | `container`, `name`, optional `signal`                                     | Stop a daemon                                                                   |

Daemons run as the container user by default. When only `uid` is set, `gid`
defaults to the same value; when neither is set, the daemon runs without any
uid/gid override. `daemon_list` reports the effective `uid`/`gid` of each
daemon.

## Container management UI

The plugin ships a browser half that registers a card in the dsh **Settings →
Plugins** page. The card lists the orchestrator-created guest containers and the
built images. A workspace with no container gets a **Create container** button
that opens a configuration modal — image, environment, mounts (project, tmpfs,
volume, and secret), and secret environment variables — and workspaces that
already have containers offer an **Add container** button for additional, named
containers through the same modal. Container rows show their environment and
secret-environment variables and their mounts, let you edit environment
variables and add/remove mounts (each removal is confirmed), and attach/detach
named secrets to a container's environment variables; each row also offers
**Remove**, **Recreate** (same image), and **Recreate with image**. The card
header has a **Reload this view** button. The images section can rebuild a
single image or **rebuild all** in dependency order; **Build image** opens a
popup with an image-id/base-image form and a chip input for the package list
(type a name and press space/comma, or paste a list, to add removable chips).
Volumes and secrets are listed as individual expandable rows, each with its own
actions, and **Create volume** / **Create secret** open popup forms (the secret
form takes an optional length; a secret's value can be overwritten, never read).
Card actions are direct control calls and are not approval-gated.

## Podman operator mode

The plugin ships an **agent preset** named _Podman operator mode_ (id
`podman-ops`). On every load it (re)writes the preset into the harness's
user-presets root (`~/.dsh/.agent-presets/podman-ops/`), overwriting any local
copy so the shipped content stays authoritative. It appears in the session's
agent-preset picker next to the shipped presets.

The preset composes a Podman-focused persona with the built-in task tools
(`ask_user_question`, `todo_write`) and `web_search` (web fetch disabled). It
does not mount the host shell, host filesystem, or the coding-agent rows
(subagents, workflows, skills, goal, plan mode, jobs). The plugin's own tools
are global and all remain available, split as:

- **Direct:** `image_list`, `image_get`, `container_list`, `container_read`,
  `container_glob`, `container_grep`, `container_mount_list`, `volume_list`,
  `secret_list`, `secret_create`, `daemon_list`, `daemon_logs`, `daemon_stop`,
  `daemon_restart`, `container_start` (asks only when `mounts` is passed).
- **Approval-gated** (the usual `✱` tools): `image_build`, `image_rebuild`,
  `image_rebuild_all`, `image_remove`, `container_recreate`, `container_remove`,
  `container_mount_add`, `container_mount_remove`, `volume_remove`,
  `secret_remove`, `container_secret_add`, `container_secret_remove`.
- **Approval-gated only in this preset:** `container_bash`, `container_exec`,
  `container_write`, `container_edit`, `daemon_start` — so the agent can run
  commands, edit container files, or start daemons once the user approves,
  without those tools asking in other presets.

The permission knobs in the approval policy above still apply (Read Only allows
only the direct read/list tools; Full access skips every prompt).
