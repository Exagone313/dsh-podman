<!--
SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>

SPDX-License-Identifier: MIT
-->

# Usage

English | [中文](usage.zh.md)

This page documents the model-facing tools, the Podman page, and the image
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

## Skills

Skills are files, not an API: dsh reads them from the usual locations, and where
they live decides whether a container can see them.

- Project skills live in `.dsh/skills` or `.agents/skills` inside a workspace.
  Workspaces are mounted read-write in their containers, so those skills and
  their scripts work everywhere.
- User skills live in `~/.agents/skills` (`DSH_AGENTS_HOME`). The dsh container
  mounts that directory read-only, and every guest container mounts it read-only
  too, so a user skill and its scripts work everywhere.
- User skills in `~/.dsh/skills` (`DSH_HOME`) are read and loaded, but are
  intentionally **not** mounted into containers: the dsh container mounts
  `~/.dsh` read-write itself, and mounting a directory a plugin can rewrite is
  unsafe, because podman follows a symlink left in its place. Their scripts
  therefore cannot run inside a container.

The `skill` tool and the `/` menu list the loaded skills. The harness caches the
menu for an open page, so reload it (or open a new session) after adding or
editing a skill on the host.

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
  instead. Base images are listed on the Podman page even when not yet
  built/pulled, are rebuilt or pulled from there, and their short names are
  reserved — they cannot be built over, rebuilt, or removed as custom images.
- **Custom images** are user-built images created from a **parent** — a base
  image or another custom image — inheriting its package manager and adding
  extra packages on top. They are referenced by their short name (e.g.
  `valkey`).
- **Template images** are custom images a container template builds. Their short
  name is
  `template-<sanitized file basename>-<first 8 hex of
  sha256(absolute template path)>`,
  so two same-named templates in different projects never share an image. A
  template whose packages are all part of the base's built-in list refers to the
  **base image** and builds nothing; on export that is written as
  `image: <base>`, even for a custom image whose extra packages all turned out
  to be base packages.

Image references (`imageId`, `parent`, `image`) are **short names only** (no
registry prefix, no `:tag`).

### Base images

Each base image is built from its primitive reference with the same fixed,
dsh-podman-owned package list, and a custom image inherits its parent's package
manager.

| Short name  | Package manager | Primitive                            | Packages                                                                                                                                                                                                |
| ----------- | --------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `archlinux` | `pacman`        | `docker.io/library/archlinux:latest` | `base-devel`, `ca-certificates`, `curl`, `diffutils`, `fd`, `git`, `inetutils`, `jq`, `less`, `openbsd-netcat`, `openssh`, `patch`, `procps-ng`, `python`, `ripgrep`, `tree`, `unzip`, `wget`, `zstd`   |
| `ubuntu`    | `apt`           | `docker.io/library/ubuntu:latest`    | `build-essential`, `ca-certificates`, `curl`, `diffutils`, `fd-find`, `git`, `jq`, `less`, `netcat-openbsd`, `openssh-client`, `patch`, `procps`, `python3`, `ripgrep`, `tree`, `unzip`, `wget`, `zstd` |
| `alpine`    | `apk`           | `docker.io/library/alpine:latest`    | `bash`, `build-base`, `ca-certificates`, `curl`, `diffutils`, `fd`, `git`, `jq`, `less`, `openssh-client`, `patch`, `procps`, `python3`, `ripgrep`, `tree`, `unzip`, `wget`, `zstd`                     |

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
language: the browser client records the active locale in the plugin's
`uiLocale` preference, which the Host persists in the plugin config (English
when unset). A policy denial — a read-only sandbox, or a destination on a
project mount — is reported in the same language. The Podman page's actions are
direct control calls and are not gated.

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
project — see
[Default environment variables](configuration.md#default-environment-variables).
The Podman page's **Git identity** popup fills the four
`GIT_AUTHOR_*`/`GIT_COMMITTER_*` variables from one name and one email.

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

### Container templates

| Tool                        | Params                           | Description                                                                                                                                                                                                                                                                                                                          |
| --------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `container_template_export` | `container`                      | Export a container as a container-template YAML string (root base image, recursive package union minus the base's built-ins, mounts, environment, secret names, PATH additions and ports with explicit `protocol: tcp`); changes nothing                                                                                             |
| `container_template_load` ✱ | `template`, optional `container` | Load a project template: build its image when needed, then create a container, publish its ports and report failures as warnings; the workspace project mount is added read-write                                                                                                                                                    |
| `container_template_save` ✱ | `container`, `name`              | Save the source `container` as a template: the tool exports it to canonical YAML itself (there is no YAML argument) and writes the result through the default container's guest agent as `name` in the project's `.dsh-podman` directory, adding `.yml` when the basename has no YAML suffix and creating the directory when missing |

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

On the Podman page, the project path field of the add-mount and create-container
dialogs has a **Browse…** button. It opens a directory picker that reads the
projects root through dsh's own host-side directory listing — the same service
behind dsh's workspace directory selection — not through the orchestrator or a
container. Its layout follows dsh's own directory browser: two columns, chevron
breadcrumbs, folder icons, and a hidden-entry toggle. The dialog is confined to
the projects root, and the path it produces is stored relative to that root.

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
`DSH_PODMAN`). The Podman page can **overwrite** a secret with user-typed
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

### Published ports

| Tool                       | Params                                                                | Description                                                                    |
| -------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `container_publish_port`   | `container`, `port`, optional `protocol` (`tcp`), `suggestedHostPort` | Expose a TCP port of the pod on the host's `127.0.0.1`, and return its address |
| `container_unpublish_port` | `container`, `port`, optional `protocol` (`tcp`)                      | Stop exposing a published port                                                 |

A pod's ports are not reachable from the host by default. Publishing brings one
TCP port out through the `dsh-podman-gateway` container the standard install
runs (see [Install](install-dsh-and-dsh-podman.md)): the guest agent forwards to
the port inside the pod over a Unix socket in the shared socket root, and the
gateway binds a host address and port to that socket and forwards to it. Only
`127.0.0.1` is ever bound, so a published port is reachable from this host alone
— by any local process, which is why the tool asks for approval.

`container_publish_port` returns the address to show the user, for example
`tcp://127.0.0.1:6666`. Pass `suggestedHostPort` (1024-65535) to ask for a
specific host port; omit it and the gateway chooses a free one, and the returned
address carries whichever port was bound. Publishing the same port twice is
idempotent. A published port survives a container recreate on the same host
port, and is released when it is unpublished, when its container is removed, or
when its workspace is torn down — the gateway holds no host port of its own
beyond what the orchestrator keeps a lease for.

Only TCP is implemented for now; `protocol` defaults to `tcp`, and the request,
the stored record and the returned address already carry a protocol, so `udp`
and `http` can be added without changing the tool's shape. The gateway is
optional: without it, both tools report that it is not running and every other
feature keeps working.

## Container management UI

The plugin ships a browser half that registers its card on the **dsh-podman**
page (open the sidebar's **Plugins** panel and pick **Installed**). The page is
a tab set — **Workspaces**, **Images**, **Storage**, **Defaults** and **Status**
— under a status strip that counts the workspaces holding a container and the
running containers, followed by ready or not-ready chips for the orchestrator
and the gateway. The page re-reads the live state whenever the Plugins panel
opens it, and a **Reload this view** button sits below the tabs, so the reload
stays reachable from every tab. Card actions are direct control calls and are
not approval-gated.

### Workspaces

The **Workspaces** tab lists the orchestrator-created guest containers. Each
workspace card states in one phrase how many of its containers run and how many
are stopped (the stopped half greyed). The one shared PTC container belongs to
no workspace, so it never appears here: its card lives on the **Status** tab.

It also shows the workspace's readable name as the card title with a discreet
**Copy workspace ID** button beside it for its UUID, and lists each container as
a stacked block.

A workspace with no container gets a **Create container** button; a workspace
that already has containers gets an **Add container** button for additional,
named containers. A **Load template** button follows it: a first popup lists the
project's templates from `.dsh-podman` (read on the dsh host, like the directory
picker) and offers **Upload from the browser**; choosing one only selects it,
and **Next** opens a second popup. That popup explains what the template will
stage — the image (and whether it must be built), the mounts, warnings for
project mount directories that do not exist, the required named secrets with
which ones exist, and the ports — with a **New container** / **Edit existing
container** destination choice at the top. When the image is missing it carries
an explicit **Build image** button; once the image is ready the same card offers
**Rebuild image**, which rebuilds it even though it is current. **Continue**
stays disabled while a build or rebuild runs, after a failure, and until the
other requirements hold; the blocking reason sits in the footer, left of the
actions. **Continue** opens the create editor prefilled from the template's
draft — the workspace's default container editor when it holds no container yet,
otherwise the named editor where the container name is chosen — or, with **Edit
existing container** chosen, the chosen container's edit editor, with the
template's fields filled in, the fields the template omits showing as the
container currently has them, and the template's ports left out of the draft.
The image card's action is the only thing that builds here; nothing is created
or replaced until the editor's own Apply.

A create's Apply makes the default container when the workspace held none, or
the named container chosen in the create editor otherwise, and publishes the
template's ports after the container exists; a publishing failure is reported as
a warning rather than failing the create. A replace's Apply updates the
container through the normal edit-apply path — nothing is removed or recreated
up front — and the template's ports are published afterwards, their failures
again reported as warnings. The workspace project mount is added silently,
read-write and forced; nothing is saved until that editor's own Apply. Every
workspace row also offers **Remove containers**, which removes that workspace's
dsh-podman containers and its pod, and the orchestrator's record for it
(volumes, secrets, and project data are kept, and the dsh workspace itself is
untouched); removing a workspace's last container removes its pod as well, so an
empty pod is never left behind.

#### Containers

The block's identity line carries the container name, its state chip and its
created time (relative, with the exact instant as a tooltip).

Its **Edit**, **Recreate**, **Export template** and **Remove** actions sit at
the right end of that line, right-aligned while the block has room and below the
name once it does not: **Recreate** rebuilds the container as it is once the
confirmation naming it is accepted. **Export template** writes the container as
a container-template YAML and opens the browser's save dialog; a custom image's
parent chain is folded into its root base plus the recursive package union minus
that base's built-ins, so an image whose extra packages were all base packages
exports as `image: <base>`.

One container is reserved: `ptc`, the container that serves workflows and PTC
runs. It belongs to no workspace, so it never appears inside one: its card sits
on the **Status** tab, directly below the component rows, and is marked by a
violet **PTC** chip after its state chip. A PTC container that does not exist
yet reads as **Missing** in grey rather than as an error: it is created lazily
on its first use. The PTC program it runs has no filesystem or network access
and calls tools host-side, so the container carries no mounts, environment
variables, secrets or published ports; the orchestrator creates it without any.
Its image is a single `ptc` image built on demand: it is rebuilt when the
harness version it carries changes, and reused across workspaces otherwise.

It is not visible to the agent's tools — `container_list`, `container_read` and
the rest never return it — and its card offers **Recreate** and **Remove**, with
no **Edit**, so its name and every field stay fixed. **Recreate** removes the
shared container through the orchestrator's workspace-less removal and then
ensures it again from the current PTC image; **Remove** retires it, and the
container is recreated on the next PTC run. Upgrading the harness rebuilds that
single PTC image and recreates the container on its next use; an agent that has
not been upgraded keeps reporting the same PTC error as before.

The fields follow in the canonical order the dialogs share, each a read-only
field with its own copy control: environment and secret environment variables as
Key/Value field pairs, PATH additions as a list of directory fields, and mounts
and ports as per-entry fields, with every value shown in full and wrapping over
as many lines as it needs.

#### The container dialog

**Add container** and **Create container** open the same dialog as **Edit** —
the same width, the same viewport-capped height, the same group order and the
same footer layout — which is titled after the action that opened it and opens
on a **Name** group: editable in **Add container**, and read-only in the default
container's **Create container** and in **Edit**. **Edit** opens it holding
everything — the read-only name, image, environment variables, mounts, PATH
variable additions, secret environment variables and published ports.

The groups that follow **Name** are **Image**, **Environment variables**,
**Mounts**, **PATH variable additions**, **Secret environment variables** and
**Published ports**. Every row of an editor is the same labelled field row the
container block renders, with an editable control where the block has a
read-only field and its copy control.

The dialog caps itself to the viewport, keeping its header and its footer in
place while the body scrolls; **Discard** drops the draft, and the dialog's one
primary action applies it once the confirmation naming the container is
accepted: **Recreate container**, in the destructive tone, when the change
rebuilds the container, and **Update container**, in the neutral one, when the
running container takes the change.

A marker beside it names the staged changes.

The apply is refused while a variable name is empty or used twice across the
environment variables and the secret environment variables: the footer names the
conflict in red and the offending key carries a red border, and the rows it
names stay in place until their own **Remove**, while an unnamed row is never
applied.

#### Mounts

The mount rows label the kind with a short chip — **Project**, **tmpfs**,
**Volume** or **Secret**. In the dialog mounts are added and removed, and
removing one from a live container is confirmed.

Adding one selects its kind, and for a project mount the project itself, from
which the destination path is derived: the project's path mirrored under the
projects root, previewed in a read-only field, since a project mount never takes
a destination of its own.

A project path typed in the Add-mount dialog rather than picked with **Browse…**
is checked against the projects root on the dsh host when the mount is added: an
inline error refuses an absolute path, one that climbs out of the root with
`..`, and one that names no existing directory. In the list a project mount's
path is fixed, shown with the read-only lock, so it is chosen when the mount is
added.

When a container is being created or added, each project or volume mount's mode
is a dropdown (read-only/read-write), so the workspace project mount can be
created read-only in one step, while secret and tmpfs mounts carry no mode
control at all.

The default container's main project mount keeps its **Remove** greyed out and
disabled, with that fact as its tooltip, since it cannot be removed.

#### Environment variables

Environment variables are edited in Key/Value rows, each carrying its own
visible labels and a **Remove** named after the variable.

**Add container** and **Create container** open their **Environment variables**
group on the workspace's default environment variables, so the values a new
container inherits are visible; a value left alone keeps the default and an
edited one becomes that container's own.

Secret environment variables are attached by adding a row and picking a named
secret, with the variable name editable in place like an environment variable's
key, switched to another secret in place, or removed from that row's own
**Remove** — which is how a requirement a template brought in is dropped. A row
whose secret no longer exists offers **Create secret** in place, opening the
form on the name that row requires; a workspace without secrets offers **Create
secret** too. A newly created secret is selected in the row that asked for it.

A variable name is required and must be unique across the environment variables
and the secret environment variables.

#### PATH additions and ports

PATH variable additions are edited from an **Edit PATH additions** button, whose
dialog lists one **Path** field per entry and prepends another with **Add
entry**; the UI calls them **PATH variable additions**, where the tool section
below calls them PATH additions.

The dialog's **Published ports** group lists the ports exposed on the host, and
a **Publish port** button opens a popup for the container port, the protocol
(only tcp is implemented today) and, optionally, the host port to prefer;
confirming the popup stages the addition — the gateway chooses a free host port
when none is given, and the notice names the endpoint it bound.

A port the gateway has not bound yet keeps the host port it was asked for with
**(pending)** appended. Publishing is disabled with a hint while the gateway is
not running or the container is stopped, and a port already exposed to the host
is unpublished again from its own **Unpublish** action once the confirmation
naming it is accepted.

### Images

The **Images** tab lists the built images, on a **Base images** card and a
**Custom images** card. It can rebuild a single image or **Rebuild all images**
in dependency order.

Each image row is a block whose first line is the image name, its status and its
**Rebuild**/**Set default** actions (right-aligned while the block has room,
below the name once it does not), followed by labelled lines for its build time
(only when the image was built; relative, with the exact instant as a tooltip),
its parent image and its packages (chips on their own line).

A custom image carries a destructive **Remove** in that same action group rather
than on a line of its own.

The reserved `ptc` image is the last row of the **Base images** card, after
every base image: its name, its **Built**/**Missing** status and the violet
**PTC** chip, a parent line naming the `node:26-slim` primitive it builds from,
and a **Build**/**Rebuild** button: **Build** creates the PTC container and its
image when the image is absent, **Rebuild** only rebuilds the image, and
**Rebuild all images** rebuilds every image including this one, building it if
missing, for the harness version the plugin targets. Its **Set default** button
stays disabled, with a tooltip saying the image is reserved to PTC (Programmatic
Tool Calling), and it has no **Remove**: the orchestrator owns it and keeps it
out of the editable image set.

**Build custom image**, on the **Custom images** card, opens a popup with an
image-name form and a parent-image select preselected to the default image, plus
a chip input for the package list (type a name and press space/comma, or paste a
list, to add removable chips, which appear below the input).

### Storage

Volumes and secrets are listed as individual expandable rows, each with its own
actions.

**Create volume** / **Create secret** open popup forms (the secret form takes an
optional length).

A secret row carries **Edit** and then **Remove**: **Edit** opens the same form,
whose **New value** field can be set or overwritten but never read back, and
**Remove** drops the secret.

A **Package caches** section reports the size of every configured build cache
(`DSH_PODMAN_HOST_PACMAN_CACHE`, `DSH_PODMAN_HOST_APT_CACHE`,
`DSH_PODMAN_HOST_APK_CACHE`) and offers two cleanup actions: **Keep latest
versions** removes every cached package file except the newest of each package
(and the signature it carried), and **Remove all** empties the caches.

Both are safe — a cached package is only ever re-downloaded — and neither runs
while an image build is in progress.

### Defaults

The **Defaults** tab shows the effective default image in a labelled select —
the configured one, or the first base image, marked as such — and its **Default
environment variables**.

A **Git identity** button opens a popup for a name and an email, filling the
four `GIT_AUTHOR_*`/`GIT_COMMITTER_*` variables in the draft.

An **Add missing variables to containers** action opens a dialog that applies
the default environment variables to every container or to one workspace's
containers, listing the variables it would add.

### Status

The **Status** tab lists the harness, this plugin and the two daemons in a
component table with their runtime state, version and commit.

A version divergence is named beside the state it qualifies.

Directly below that table sits the shared PTC container's card: its identity,
its state and **PTC** chips, its relative creation time, its read-only image and
its **Recreate**/**Remove** actions.

### Container templates

A container template is a YAML file in a project's `.dsh-podman` directory:

```yaml
version: 1
kind: dsh-podman/container-template
spec:
  imageTemplate: # or image: ubuntu (exactly one of the two)
    base: ubuntu # archlinux | ubuntu | alpine only
    packages:
      - git
      - ripgrep
  env:
    NODE_ENV: development
  secretEnv:
    GITHUB_TOKEN: github-token # variable -> secret name, never a value
  mounts:
    - kind: project # no destination; mode defaults to read_only
      project: app
      mode: read_write
    - kind: volume
      volume: cache
      destination: /cache
      mode: read_write
    - kind: secret # read-only, no mode
      secret: npm-token
      destination: /root/.npmrc
    - kind: tmpfs # destination only
      destination: /tmp/scratch
  paths:
    - /usr/local/bin
  ports:
    - container: 8080
      host: 8080
      protocol: tcp # protocol required, tcp only
    - container: 3000
      protocol: tcp # host optional
```

That is the canonical rendering: block style throughout with two-space
indentation, and an empty `env`, `secretEnv`, `mounts`, `paths` or `ports` group
omitted rather than written as `{}` or `[]` (the parser supplies the empty
defaults). Project and volume mounts carry an optional `mode` (`read_only` or
`read_write`); omitting it means `read_only`, the editor's default. Secret
mounts are fixed read-only and tmpfs mounts carry no mode at all. Mounts are
grouped in the container card's order — project, volume, secret, tmpfs — and
keep their order within a kind. The four Git identity variables
(`GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`,
`GIT_COMMITTER_EMAIL`) are never written to a template, and a template that
declares them is loaded without them: they come from the default environment.

The format is strict: an unknown `version` or `kind`, any key outside the sets
above (no `command`, `resources`, tmpfs `size`, or port `protocol` other than
`tcp`), both or neither of `image`/`imageTemplate`, a base name outside the
three declared bases, a mount key that does not match its kind (a project mount
with a destination, a secret or tmpfs mount with a mode, a tmpfs with a source
or `size`), and a secret value instead of a secret name are refused rather than
ignored. Secret values are never stored in a template, only the names of the
secrets a container should receive.

The package list is canonical on both sides: packages already in the base's
built-in list are dropped, what remains is deduplicated and sorted, and an empty
remainder means the base image. The template image is rebuilt when its package
list (or its parent base) differs from what the image list reports, and a
superseded template image is deleted once no container references it.

`container_template_save` goes through the guest agent (the dsh host only reads
the project): it takes the source `container` and a plain `name` basename — not
a YAML document — exports that container itself, and writes the canonical YAML
as `name` (with `.yml` added when the name has no YAML suffix), creating
`.dsh-podman` when missing. It refuses a name that is not a plain basename and
reports a read-only project mount as a clean permission error rather than an I/O
failure.

## Podman terminal

The plugin owns a **Podman terminal** right-Sidebar tab. It replaces the
built-in dsh terminal with its own implementation: the plugin's bundle patch
disables the stock terminal row and registers this one instead, so the terminal
shown in the Sidebar is dsh-podman's. Open it from the right Sidebar's new-tab
guide — the card is **New terminal** — or press **Ctrl+\`**; the tab is named
after the shell it runs (`bash`, `sh`, …). If the built-in terminal is enabled
again, the plugin falls back to **Ctrl+Shift+\`**; the agent's `terminal` tool
is unaffected. It always runs in the session's own workspace — each workspace
has its own side panes and terminals — so the start form only asks for a
container and then a shell, and a shell can run in the default container or in a
named one. If the session's directory names no known workspace the form reports
that instead of guessing; the harness's own Terminal always uses that
workspace's default container. The container and shell you last started are
remembered in the browser's local storage and preselected while they are still
available — a container that disappeared falls back to the default, and a shell
the image no longer ships falls back to the first one the container offers.

The shell list is discovered **inside the chosen container**: candidate names
are looked up on that container's PATH (`command -v`) and merged with
`/etc/shells` and `$SHELL`, so a shell installed through a PATH addition or a
mounted volume appears while one the image lacks does not. The list is ordered
most capable first (`zsh`, `bash`, `fish`, … down to `dash`, `ash`, `sh`), so
the picker preselects the best shell the container has. The selected shell is
verified again before it starts.

Terminals are retained on the host: switching tabs, closing the Sidebar or
reloading the page keeps the shell and its scrollback, and reattaching replays
the screen. Closing the tab leaves the shell retained for a while (until the
host reaps it); **Reconnect** starts a fresh shell in the current selection.
Closing or recreating a container drops its terminals, so reconnect afterwards.

## Workspace containers panel

The plugin also owns a **Containers** right-Sidebar tab, separate from the
Podman terminal. Open it from the right Sidebar's new-tab menu: the **Workspace
containers** card sits right after **New terminal**, and picking it opens the
panel in that tab's place. The same panel opens from its **Containers** command.

The panel lists only containers from the current session's workspace: the host
resolves the workspace from the session once, through the same route the
terminal uses, and other workspaces, the workspace-less PTC container and rows
without a workspace never appear. If the session belongs to no known workspace,
the panel says so instead of listing anything. Its header is the workspace block
from the settings card — the workspace name, a button copying its UUID, its
running-container count, and **Add container** / **Remove containers** with the
same confirmations. Each row carries the container's name, state and age and the
same labelled fields as the settings card — environment and secret environment
variables, mounts, PATH additions and published ports — with **Edit**,
**Recreate** and **Remove**. A **More settings…** button in the header opens
this plugin's settings card — under **Plugins** → **Installed** — when the
harness serves the **Plugins** panel; without it the button is hidden. Images,
storage, defaults and the version status stay on that settings card.

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
  `daemon_restart`, `container_template_export`, `container_start` (asks only
  when `mounts` or `secretEnv` is passed).
- **Approval-gated** (the usual `✱` tools): `image_build`, `image_rebuild`,
  `image_rebuild_all`, `image_remove`, `container_recreate`, `container_remove`,
  `container_mount_add`, `container_mount_remove`, `container_mount_update`,
  `container_path_set`, `container_path_add`, `container_path_remove`,
  `volume_remove`, `secret_remove`, `container_secret_add`,
  `container_secret_remove`, `container_template_load`,
  `container_template_save`.
- **Approval-gated only in this preset:** `container_bash`, `container_exec`,
  `container_write`, `container_edit`, `daemon_start` — so the agent can run
  commands, edit container files, or start daemons once the user approves,
  without those tools asking in other presets.

The permission knobs in the approval policy above still apply (Read Only allows
only the direct read/list tools; Full access skips every prompt).
