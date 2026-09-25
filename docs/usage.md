<!--
SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>

SPDX-License-Identifier: MIT
-->

# Usage

This page documents the model-facing tools, the settings card, and the image
model. See [Architecture](architecture.md) for how the pieces fit together.

## Model context

The harness adds a prompt section naming its own on-disk checkout so the model
can inspect or extend DSH itself. That checkout lives on the host and is not
reachable from the workspace container, so dsh-podman removes the section from
the assembled system prompt; the model is never told a misleading path.

dsh-podman also adds its own prompt section clarifying that the built-in shell
and filesystem tools (`bash`, `read`, `write`, `edit`, `glob`, `grep`) run
inside the workspace's default container rather than on the host, and how they
relate to the `container_*` tools. The same section steers the model toward
building a custom image with `image_build` (then `container_start` or
`container_recreate`) for software installs, and toward named volumes rather
than `tmpfs` for data that must survive a container recreate.

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
that reads the session's effective permission knobs (sandbox mode + approval
policy):

- **Read Only** — only the get/list tools run (`image_list`, `image_get`,
  `container_list`, `container_read`, `container_glob`, `container_grep`,
  `container_mount_list`, `volume_list`, `secret_list`, `daemon_list`,
  `daemon_logs`); every other plugin tool is denied. The built-in file and shell
  tools (`write`, `edit`, `bash`, and `pwsh` on Windows) and their container
  counterparts (`container_bash`, `container_exec`, `container_write`,
  `container_edit`, `daemon_start`) run when every mount of the target container
  that carries a mode (project and volume; tmpfs and secrets do not) is already
  `read_only` — the harness sandbox that would confine them is bypassed inside
  the container. When a read-write mount would block one of them, the plugin
  asks through DSH's approval service with a prompt listing the mounts it would
  remount `read_only` and those it keeps, then recreates the container with the
  read-only list before running the tool; a rejected prompt denies the call.
  `read`, `glob`, and `grep` always run.
- **Workspace Write** — the `✱` tools ask through DSH's approval service (the
  call shows the standard approval prompt and is denied when no approval channel
  is available); `container_start` asks only when `mounts` is passed or
  `secretEnv` attaches secrets.
- **Full access** — tools run without approval prompts.

The harness's `sandbox_permissions` argument (a one-shot sandbox widening, e.g.
on `bash`) is accepted but has no effect here: the sandbox is bypassed inside
the container, so the plugin grants the escalation without prompting.

The prompt's reason is a full sentence naming the action and the objects it
touches, quoting every identifier — for example
`Add mount to container "web": volume "data" (read-only)`. It covers the
container image, each mount's kind and destination, the environment variable
keys, the secret env var names, and the resolved file path. It follows the UI
language: the browser client records the active locale in the plugin settings,
with the durable locale preference as the fallback (English when neither is
set). A policy denial — a read-only sandbox, or a destination on a project mount
— is reported in the same language. The settings-card actions are direct control
calls and are not gated.

`container_start`, `container_recreate`, and `container_bash` accept an `env`
map applied to the container (or the bash process); `container_exec` and
`daemon_start` already accept `env`, and `daemon_restart` reuses a daemon's
stored environment. `container_start` and `container_recreate` also accept a
`secretEnv` map (env var name → secret short name) that attaches existing
secrets to the container's environment — see [Secrets](#secrets). On
`container_start` and `container_recreate`, an omitted `env` (or `secretEnv`)
keeps the container's stored map, while a provided map replaces it entirely.
Environment variables are not treated as secrets, so the approval reason and
`container_list` show the variable **keys**. Keys starting with `DSH_PODMAN` are
reserved and rejected, since the orchestrator uses that namespace for
guest-agent wiring.

New containers are also seeded with the plugin's **default environment** (the
`containerEnv` setting), so a git identity can be configured once instead of per
project — see [Default environment](configuration.md#default-environment). The
card's **Git identity** popup fills the four `GIT_AUTHOR_*`/`GIT_COMMITTER_*`
variables from one name and one email, and **Apply default environment
variables** adds them to the running containers that lack them.

`container_bash` and `container_exec` run with the same command-visible
environment as the built-in `bash`: the harness's managed `DSH_*` facts
(`DSH_HOME`, `DSH_SHELL`, `DSH_SESSION_ID`, `DSH_WEB_URL`) and its
non-interactive terminal overrides (`NO_COLOR`, `TERM=dumb`, `PAGER=cat`,
`GIT_PAGER=cat`). A caller's `env` entry beats an override but cannot displace a
managed `DSH_*` fact.

### Images

| Tool                  | Params                          | Description                                                                                                                                                                                       |
| --------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `image_build` ✱       | `imageId`, `parent`, `packages` | Build a new custom image from a base or custom parent and package list                                                                                                                            |
| `image_get`           | `imageId`                       | Details for one image                                                                                                                                                                             |
| `image_list`          | —                               | List the built workspace images, base images first                                                                                                                                                |
| `image_rebuild_all` ✱ | —                               | Ensure every base, then rebuild every custom image in dependency order, skipping any image whose rebuild fails and its dependents; a base it cannot ensure is reported in `skipped` by short name |
| `image_rebuild` ✱     | `imageId`                       | Rebuild an existing custom image in place                                                                                                                                                         |
| `image_remove` ✱      | `imageId`                       | Remove a built image; refused while a workspace or container still references it                                                                                                                  |

### Containers

| Tool                   | Params                                                                                                | Description                                                                                                                                 |
| ---------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `container_bash`       | `container`, `command`, `description`, optional `workdir`, `timeoutMs`, `env`, `uid`, `gid`, `groups` | Run a shell command                                                                                                                         |
| `container_edit`       | `container`, `file_path`, `old_string`, `new_string`, optional `replace_all`                          | Edit a file                                                                                                                                 |
| `container_exec`       | `container`, `argv`, `description`, optional `workdir`, `timeoutMs`, `env`, `uid`, `gid`, `groups`    | Run a program                                                                                                                               |
| `container_glob`       | `container`, `pattern`, optional `path`                                                               | List files matching a pattern                                                                                                               |
| `container_grep`       | `container`, `pattern`, optional `path`, `include`                                                    | Search files for a regex                                                                                                                    |
| `container_list`       | —                                                                                                     | List the containers of the current workspace                                                                                                |
| `container_read`       | `container`, `file_path`, optional `offset`, `limit`                                                  | Read a file                                                                                                                                 |
| `container_recreate` ✱ | `container`, optional `image`, `mounts`, `env`, `secretEnv`, `paths`                                  | Recreate a container, keeping its current image when `image` is omitted, optionally with new project mounts, environment, or PATH additions |
| `container_remove` ✱   | `container`                                                                                           | Remove a container (stops its daemons gracefully first)                                                                                     |
| `container_start` ✱    | `container`, optional `image`, `mounts`, `env`, `secretEnv`, `paths`                                  | Start a container (default image when `image` is omitted); approval required only when `mounts` or `secretEnv` is passed                    |
| `container_write`      | `container`, `file_path`, `content`                                                                   | Write a file                                                                                                                                |

The `container_bash`, `container_exec`, `container_read`, `container_write`,
`container_edit`, `container_glob` and `container_grep` arguments mirror the
harness's built-in `bash`/`read`/`write`/`edit`/`glob`/`grep` tools (plus the
`container` target), so the same vocabulary works against a chosen container.
`container_read`, `container_write` and `container_edit` also resolve their
target through the same filesystem provider as the built-in file tools, so they
share their behavior: binary files are refused with the same error, and the
read-before-write guard (refusing to overwrite a file that was not read in the
session) applies to them exactly as it does to the built-in `write` and `edit` —
a `container_read` satisfies that guard for the path it read, just like the
built-in `read`. A path that was read and has since been removed is a new file:
writing it creates it again instead of reporting a stale version. The plugin
also registers a dedicated UI row for every one of its tools (icon, title,
summary, and result body), so they render like the built-in tools rather than as
a generic `Tool call` row.

Paths and working directories may be absolute or relative. A relative value is
resolved against the session's working directory, which is also where the
project is mounted inside the container. A `file_path` on `container_read`,
`container_write` and `container_edit` may not contain a `..` segment; working
directories may, since commands are not confined to the projects root.

When no working directory is given, `container_bash`, `container_exec` and
`daemon_start` run in the session's working directory (like the harness's `bash`
tool), and `container_glob`/`container_grep` search it by default. That
directory must be mounted in the container — otherwise the guest agent's own
working directory is used. An explicit `workdir` (or `path`) takes precedence.

`container_bash` and `container_exec` accept an optional `uid`, `gid` and
`groups` to run the command as another user. The values are numeric only: the
container's `/etc/passwd` and `/etc/group` live on the read-only rootfs, so
names never resolve. `groups` replaces the process's whole supplementary set,
and applying any identity requires the guest agent to run as root, which it
does. `HOME` is not managed, so a command run as another uid inherits the
container's `HOME` (the read-only `/root`); pass `env` to point it at a writable
directory.

The file tools (`container_read`, `container_write`, `container_edit`) can reach
the workspace's mounts: the project directory under the projects root, as well
as any `volume` and `tmpfs` mounts at their absolute destinations. `secret`
mounts are not exposed through the file API — the secret value is only readable
by processes running inside the container.

### Mounts and volumes

| Tool                       | Params                                                                             | Description                                                                |
| -------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `container_mount_add` ✱    | `container`, optional `kind`, `project`, `destination`, `mode`, `volume`, `secret` | Add a mount; `kind` is `project` (default), `tmpfs`, `volume`, or `secret` |
| `container_mount_list`     | `container`                                                                        | List the container's mounts                                                |
| `container_mount_remove` ✱ | `container`, optional `kind`, `project`, `volume`, `destination`, `secret`         | Remove a mount; identify it by `kind` plus its handle (see below)          |
| `container_mount_update` ✱ | `container`, `mode`, optional `kind`, `project`, `volume`, `destination`           | Change a project or volume mount's mode; identify it like removal (below)  |
| `volume_create`            | `name`                                                                             | Create a managed named volume                                              |
| `volume_list`              | —                                                                                  | List the managed named volumes (short names)                               |
| `volume_remove` ✱          | `name`                                                                             | Remove a managed named volume; refused while a container still mounts it   |

A `project` mount binds a path under the projects root (`team`, or `team/src`
for a directory inside it); `tmpfs` mounts a writable in-memory filesystem and
`volume` mounts a podman named volume (auto-created on first use) — both at an
arbitrary absolute container path, never under the projects root, `/tmp`, or
another reserved path. A `secret` mount exposes a managed secret as a read-only
file at an absolute container path (see [Secrets](#secrets)).

Project mounts do not take a `destination`: a project directory is always
mounted at its mirrored path under the projects root. `destination` applies only
to `tmpfs`, `volume` and `secret` mounts.

In the settings card, the project path field of the add-mount and
create-container dialogs has a **Browse…** button. It opens a directory picker
that reads the projects root through dsh's own host-side directory listing — the
same service behind dsh's workspace directory selection — not through the
orchestrator or a container. Its layout follows dsh's own directory browser: two
columns, chevron breadcrumbs, folder icons, and a hidden-entry toggle. The
dialog is confined to the projects root, and the path it produces is stored
relative to that root.

Removing a mount names it by `kind` plus that mount's own handle: `project` for
a project mount, `volume` for a named volume, `secret` for a secret, and
`destination` for a `tmpfs` mount. A handle that matches more than one mount is
rejected, so pass `destination` as well when a volume or secret is mounted more
than once. `container_mount_list` reports the exact values. `kind` is optional —
inferred from `secret` or `volume`, otherwise `project` — except for `tmpfs`,
which has no name to infer from and must be named explicitly.

`mode` is `read_only` or `read_write`, and defaults to `read_only` so that
adding a mount never grants write access that was not asked for. `tmpfs` mounts
are always `read_write`, and `secret` mounts take no mode. The workspace's own
project mount is created `read_write`; remount it `read_only` with
`container_mount_update` when a session should not modify the project.

Changing a mount's mode is `container_mount_update`, not `container_mount_add`:
re-adding a mount that already exists is rejected rather than silently changing
it. It identifies the mount exactly like `container_mount_remove` (a handle that
matches more than one mount is rejected), requires `mode`, and applies only to
`project` and `volume` mounts — `tmpfs` is always `read_write` and `secret`
mounts carry no mode. A mode change to the mode the mount already has is
rejected.

A **named container** carries exactly the mounts it was created with: the
workspace project directory is not mounted automatically. The **default
container** always keeps its workspace project mount, which cannot be removed —
but it can be remounted `read_only` with `container_mount_update`.

Mutating a container's mounts
(`container_mount_add`/`container_mount_remove`/`container_mount_update`) or its
secret environment variables (`container_secret_add`/`container_secret_remove`)
**recreates** the container: its running processes, including daemons, are
terminated. Data in bind-mounted volumes persists; `tmpfs` contents do not.

### PATH additions

| Tool                      | Params               | Description                                                                     |
| ------------------------- | -------------------- | ------------------------------------------------------------------------------- |
| `container_path_set` ✱    | `container`, `paths` | Replace the whole ordered list, first entry highest priority; empty clears it   |
| `container_path_add` ✱    | `container`, `path`  | Prepend one directory; an existing entry moves to the front                     |
| `container_path_remove` ✱ | `container`, `path`  | Remove one added directory; a directory of the container's default PATH is kept |

Every entry must be an absolute, lexically clean directory with no `:` or
newline. The list is prepended to the container's own `PATH` (the image's, as
the running guest agent sees it) for every command the agent starts: the
built-in `bash`/`read`/`write`/`edit` tools, `container_bash`, `container_exec`,
the terminal, and daemons started afterwards. Nothing is recreated — the running
guest agent receives the new list immediately, so daemons already running keep
their old `PATH`. A recreated container restores the persisted list. The list
can also be set when a container is created, started, or recreated, through the
settings modal or the `paths` argument of `container_start` and
`container_recreate`.

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

A secret mounted at a path is created as a root-owned **file** (not a directory)
with permissions that deny everyone but root, so only the container's default
(root) user can read it; a daemon started with a different `uid` cannot read a
mounted secret. A secret attached as an environment variable is inherited by
every process the agent starts unless the daemon is started with
`inheritEnv=false` (see [Daemons](#daemons)).

### Daemons

| Tool             | Params                                                                                   | Description                                                                     |
| ---------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `daemon_list`    | `container`                                                                              | List the daemons (including their effective `uid`/`gid` and `groups`)           |
| `daemon_logs`    | `container`, `name`, optional `tailBytes`                                                | Tail a daemon's stdout/stderr                                                   |
| `daemon_restart` | `container`, `name`                                                                      | Restart a daemon with the same command, environment, and user                   |
| `daemon_start`   | `container`, `name`, `argv`, optional `cwd`, `env`, `inheritEnv`, `uid`, `gid`, `groups` | Start a background daemon; optional `uid`/`gid`/`groups` run it as another user |
| `daemon_stop`    | `container`, `name`, optional `signal`                                                   | Stop a daemon                                                                   |

Daemons run as the container user by default. When only `uid` is set, `gid`
defaults to the same value; when neither is set, the daemon runs without any
uid/gid override. `groups` replaces the process's whole supplementary set.
`daemon_list` reports the effective `uid`/`gid` and supplementary `groups` of
each daemon. Starting a daemon with a name that already exists stops that daemon
first (when it is still running) and replaces it; stopped daemons stay listed so
their logs remain readable. Daemons live in the container's guest agent and do
not survive a container recreate (see
[Mounts and volumes](#mounts-and-volumes)).

A daemon inherits the container's environment by default — every variable the
guest agent has, including environment secrets attached with
`container_secret_add` — minus the reserved `DSH_PODMAN` namespace. Pass
`inheritEnv=false` to start it isolated: it then receives only `PATH` and `HOME`
(from the container) plus its own `env`, so container and secret environment
variables are not visible. `daemon_restart` replays the mode the daemon was
started with.

## Container management UI

The plugin ships a browser half that registers a card in the dsh **Settings →
Plugins** page. The card lists the orchestrator-created guest containers and the
built images. A workspace with no container gets a **Create container** button
that opens a configuration modal — image, environment, mounts (project, tmpfs,
volume, and secret), PATH additions, and secret environment variables — and
workspaces that already have containers offer an **Add container** button for
additional, named containers through the same modal, which is titled after the
button that opened it. In that modal each mount's mode is a dropdown
(read-only/read-write), so the workspace project mount can be created read-only
in one step; tmpfs and secret mounts are fixed (read-write and read-only
respectively) and show a disabled dropdown. Container rows show their
environment and secret-environment variables and their mounts, let you edit
environment variables and add/remove mounts (each removal is confirmed), and
attach/detach named secrets to a container's environment variables; each row
also offers **Remove**, **Recreate** (same image), and **Recreate with image**.
Every workspace row also offers **Remove pod**, which removes the workspace's
pod, all of its containers, and the orchestrator's record for it (volumes,
secrets, and project data are kept); removing a workspace's last container
removes its pod as well, so an empty pod is never left behind. The card re-reads
the live state whenever the Plugins page is opened, and its header has a
**Reload this view** button. The images section can rebuild a single image or
**rebuild all** in dependency order; **Build image** opens a popup with an
image-id/base-image form and a chip input for the package list (type a name and
press space/comma, or paste a list, to add removable chips). Volumes and secrets
are listed as individual expandable rows, each with its own actions, and
**Create volume** / **Create secret** open popup forms (the secret form takes an
optional length; a secret's value can be overwritten, never read). Card actions
are direct control calls and are not approval-gated.

A **Package caches** section reports the size of every configured build cache
(`DSH_PODMAN_HOST_PACMAN_CACHE`, `DSH_PODMAN_HOST_APT_CACHE`,
`DSH_PODMAN_HOST_APK_CACHE`) and offers two cleanup actions: **Keep latest
versions** removes every cached package file except the newest of each package
(and the signature it carried), and **Remove all** empties the caches. Both are
safe — a cached package is only ever re-downloaded — and neither runs while an
image build is in progress.

## Podman operator mode

The plugin ships an **agent preset** named _Podman operator mode_ (id
`podman-ops`). The plugin's bundle patch declares it as a
`@deepseek-ai/dsh-agent-preset` row, so the harness's preset registry serves it
directly. It appears in the session's agent-preset picker next to the shipped
presets.

The preset composes a Podman-focused persona with the built-in task tools
(`ask_user_question`, `todo_write`) and `web_search` (web fetch disabled). It
does not mount the host shell, host filesystem, or the coding-agent rows
(subagents, workflows, skills, goal, plan mode, jobs). The plugin's own tools
are global and all remain available, split as:

- **Direct:** `image_list`, `image_get`, `container_list`, `container_read`,
  `container_glob`, `container_grep`, `container_mount_list`, `volume_list`,
  `secret_list`, `secret_create`, `daemon_list`, `daemon_logs`, `daemon_stop`,
  `daemon_restart`, `container_start` (asks only when `mounts` or `secretEnv` is
  passed).
- **Approval-gated** (the usual `✱` tools): `image_build`, `image_rebuild`,
  `image_rebuild_all`, `image_remove`, `container_recreate`, `container_remove`,
  `container_mount_add`, `container_mount_remove`, `container_mount_update`,
  `container_path_set`, `container_path_add`, `container_path_remove`,
  `volume_remove`, `secret_remove`, `container_secret_add`,
  `container_secret_remove`.
- **Approval-gated only in this preset:** `container_bash`, `container_exec`,
  `container_write`, `container_edit`, `daemon_start` — so the agent can run
  commands, edit container files, or start daemons once the user approves,
  without those tools asking in other presets.

The permission knobs in the approval policy above still apply (Read Only allows
only the direct read/list tools; Full access skips every prompt).
