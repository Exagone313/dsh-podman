<!--
SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>

SPDX-License-Identifier: MIT
-->

# Architecture

dsh-podman has three components:

| Component                 | Runs                                      | What it does                                                                                           |
| ------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `@exagone313/dsh-podman`  | Inside dsh itself                         | Registers `ctx.subprocess` and `ctx.fs` backed by the orchestrator                                     |
| `dsh-podman-guest-agent`  | Inside every guest container              | Serves the exec/filesystem gRPC API for one workspace                                                  |
| `dsh-podman-orchestrator` | A container with access to the Podman API | Owns the control socket and persisted state; creates/removes guest containers; builds workspace images |

The plugin auto-creates a missing workspace using its configured default image
and a single read-write project mount; `container_mount_update` can remount that
mount read-only. It never falls back to host execution.

## Control plane

The plugin connects to the orchestrator over a Unix socket at
`<socketsRoot>/orchestrator.sock` and talks gRPC. Requests carry the shared
token (`DSH_PODMAN_ORCHESTRATOR_TOKEN`) as an `authorization: bearer` header.

Requests also carry the plugin's version in an `x-dsh-podman-plugin-version`
header. The plugin and the orchestrator are deployed separately (an npm package
inside the dsh image, and this binary), so the orchestrator refuses a control
call from a plugin whose **major** version differs, naming both versions and
which side is behind — an out-of-sync deployment fails loudly instead of being
misread. A missing or unparseable version is refused as well. A minor or patch
difference is compatible: the call proceeds, the orchestrator logs it once per
plugin version, and the Podman page shows it. `GetVersion` is exempt from the
check, so a plugin can always learn the orchestrator's version.

The orchestrator service exposes these gRPC methods (backing both the UI and the
tools): `ListContainers` (returns only the guest containers the orchestrator
created — containers it does not own are never exposed),
`EnsureContainer{workspace_slug, container}` (the single attach path: returns
the named container, recreating it first when it is missing, stopped, or running
an outdated guest agent),
`StartContainer{workspace_slug, container, image_id, mounts, env, secret_env,
paths}`
(creates or replaces a container in the workspace's pod; an empty `container`
targets the default container and other names are validated),
`RecreateContainer{workspace_slug, container, image_id, mounts, env, paths}`
(stops, removes, and recreates a container, optionally with a new image, project
mounts, environment, or PATH additions; an empty `image_id` keeps the
workspace's current image), `RemoveContainer`, `AddContainerMount`,
`UpdateContainerMount`, `RemoveContainerMount`, `SetContainerPaths`,
`AddContainerSecret`, and `RemoveContainerSecret`. The service also exposes the
workspace, volume, secret, image (build, rebuild, remove and base-image pull),
and cache (list and clean) operations that back the Podman page, plus
`GetVersion`.

## Workspaces and pods

Each workspace maps to a **podman pod** (`dsh-podman-<slug>`, where `<slug>` is
the workspace UUID) so its containers share a network namespace. Every workspace
has a **default container** (`dsh-podman-<slug>-default`); additional, named
containers (`dsh-podman-<slug>-<name>`) can be created inside the same pod.
Containers' root filesystems are mounted read-only, with podman's read-write
tmpfs on `/tmp`, `/var/tmp`, and `/run` (and `/dev` and `/dev/shm` left
writable). All other writable state lives in the project bind mount, named
volumes, or tmpfs mounts. `/tmp` and `/var/tmp` are reachable through the guest
file API, and the guest agent spills oversized command output under
`/tmp/dsh-podman`. Oversized tool results are spilled there too, under
`/tmp/dsh-podman/spill/<session>/`, by the plugin's `ctx.spillStore` — so the
model reads the artifact back with the container file tools instead of a host
path the container cannot reach.

A workspace's pod is torn down when its last container is removed, or directly
through `RemoveWorkspace` (the Podman page's **Remove pod** action), which
stops the containers' daemons, removes the pod and its containers, cleans their
socket directories, and drops the stored workspace. Volumes, secrets, and
project data are left untouched.

Beyond project mounts, a container can mount named volumes (prefixed
`DSH_PODMAN_VOLUME_PREFIX`, default `dsh-podman-`, and auto-created by podman on
first use), secrets, or tmpfs at arbitrary container paths — except where they
would overlap a reserved path:

- `DSH_PODMAN_PROJECTS_ROOT`, reserved for project mounts;
- `DSH_PODMAN_SOCKETS_ROOT`, which carries the guest agent's socket;
- `DSH_PODMAN_GUEST_AGENT_IMAGE_MOUNT`, which the container runs its entry point
  from;
- `/tmp`, which podman mounts as the read-write tmpfs the guest file API reaches
  and where command output is spilled.

A destination that contains a reserved path is refused as well as one that sits
inside it, since it would hide everything beneath it.

Commands run through the guest exec API get `/dev/null` on stdin unless the
caller explicitly asks for a pipe, so a command that reads stdin sees EOF
instead of blocking (a bare `rg`/`grep` with no path therefore searches the
working directory rather than reading an empty pipe). `container_glob` and
`container_grep` also pass their resolved path to ripgrep as the search
directory, never as a `--glob` pattern (a path containing `/` would never match
one), and a ripgrep failure (exit code 2) is reported as a tool error rather
than an empty result. Ripgrep anchors a `--glob` pattern containing `/` to the
process working directory, so a discovery listing the harness starts with an
absolute search root runs from that root: `glob`'s `pattern` then anchors to its
`path` while the printed paths stay absolute.

Project mounts resolve through symlinks and are confined to the projects root,
so a symlink inside a writable project cannot redirect the bind mount to a path
outside it. Symlinks with absolute targets are never followed; name the other
project directly instead.

## Guest agent and daemons

The orchestrator starts the guest agent inside each container over the
container's socket directory. The guest agent serves the exec/filesystem gRPC
API for that workspace, runs and supervises background **daemons**, and reads
and writes files. Each guest container gets exactly one socket directory
bind-mounted into it, so a guest never sees the orchestrator's control socket
nor any other workspace's socket directory.

The guest API exposes no watcher, so the plugin's `ctx.fs` provider reports
`FS_IO_ERROR` (`Filesystem watching is not supported by this provider.`) for
`watch`. The harness's workspace-file change stream therefore answers
`workspace-file/watch-unsupported`, and the browser's file tree refreshes on
demand instead of live — the same stance the harness's SSH filesystem provider
takes for a remote path.

Commands and daemons inherit the guest agent's environment, minus the reserved
`DSH_PODMAN` namespace: the agent's own token stays with the agent instead of
being copied into everything it starts. A daemon started with `inheritEnv=false`
instead receives only the `PATH`/`HOME` baseline plus its own `env`.

Each container also carries ordered **PATH additions**. The orchestrator
persists them (`SetContainerPaths`) and hands them to the guest agent as
`DSH_PODMAN_GUEST_PATHS` on every create or recreate; the agent holds them in
memory (`SetPaths`/`GetPaths` over its gRPC API) and prepends them to the PATH
of every process it starts, including the plugin's `ctx.subprocess` provider, so
the built-in shell and filesystem tools see them too. Changing the list does not
recreate the container, so daemons started earlier keep their old PATH.

Under `read-only` permission the harness sandbox cannot confine commands (the
plugin replaces `ctx.subprocess`/`ctx.fs` and unwraps the `landlock-run`
wrapper), so the plugin enforces the mode itself: a shell or file tool runs only
when every mount that carries a mode is `read_only`. Otherwise the plugin asks
through the approval service under the reserved tool name
`dsh_podman_builtin_remount_read_only` — which the browser half renders with its
own **Remount & run** labels — and, on approval, recreates the container with
the read-write mounts forced read-only before running the tool. The harness's
`sandbox_permissions` escalation is granted without prompting for the same
reason: the widening it asks for has no effect here.

Recreating a container or shutting down the orchestrator first asks the
container's guest agent to gracefully stop its daemons (SIGTERM, ~10s grace)
before podman tears the container down.

## Images

The orchestrator builds workspace images through Podman (see
[Usage](usage.md#image-model) for the primitive/base/custom tiers). Base images
are built locally from their primitive reference (or pulled when
`DSH_PODMAN_BASE_IMAGE_PREFIX` points at a registry) without any guest-agent
binary. The guest agent is provided at container creation by mounting its own
image read-only into the container (see [Configuration](configuration.md)).
Custom images are layered on top of a parent image and add extra packages. Every
build streams its context to the Podman API as a tar holding the generated
Containerfile, so a build writes nothing to the orchestrator's state directory.

`image_rebuild_all` first ensures every base image (building locally or pulling
from a public registry per `DSH_PODMAN_BASE_IMAGE_PREFIX`), then rebuilds the
stored custom images **in dependency order** — each parent before the images
derived from it. An image whose rebuild fails, and every image that depends on
it, is reported in `skipped` while the rest continue. A base image the call
could not build or pull is reported there too, by its short name; `rebuilt`
lists only the custom images, so it never names a base the call had to ensure.

When a host cache is configured (`DSH_PODMAN_HOST_*_CACHE`, mounted into both
the build container and the orchestrator), builds reuse downloaded packages. The
Podman page reports each cache's size and can clean it — keep the newest
version of every package, or empty the cache. The builder serializes a cleanup
against builds with a read/write lock, so a cleanup never deletes a package out
from under a running build.

## Podman page transport

The Podman page talks to the host over one authenticated fetch route below the
harness API path (`/api/podman/card`), registered on the connection service so
the carrier applies its Host/Origin fence and browser authentication first:

- `GET` returns the live orchestrator snapshot (containers, images, workspaces,
  volumes, secrets, caches), built fresh on every request.
- `POST` runs exactly one command (`remove` / `recreate` / `create` /
  `image_rebuild` / `image_rebuild_all` / volume / secret / secret-env / mount
  ops) against the orchestrator and returns the notice to show.

The plugin's own config therefore holds **only real preferences**: the default
image, the default environment, and the page's active locale (`uiLocale`, so the
host can render approval text in the session language — see
[Approval](usage.md#approval)). They are volatile fields, so an edit applies
without reloading the plugin. Nothing derived from the orchestrator is
persisted, and no command round-trips through the config document.

## Podman terminal transport

The Podman terminal tab talks to guest ptys through its own authenticated routes
on the same connection service (`/api/podman/terminal`,
`/api/podman/terminal/shells`, `/api/podman/terminal/retained`). The open route
streams newline-delimited JSON frames (ready, snapshot, base64 output, title,
exit, error, detached) and takes control requests (input, resize, rename,
close) over a POST; the carrier applies the same Host/Origin fence and browser
authentication as the card route.

Each terminal is keyed by `(sessionId, tabId)` and retained by the host: the
guest pty stays alive while no browser is attached, and every chunk is also fed
to a headless terminal emulator whose serialized screen is replayed on reattach,
so a reload keeps the shell and its scrollback. Shell discovery runs inside the
target container: candidate names are resolved with POSIX `command -v` on the
container's PATH (including the deployment's PATH additions) and merged with
`/etc/shells` and `$SHELL`, so only shells the container really provides are
offered; the selected path is re-verified before the shell starts.
