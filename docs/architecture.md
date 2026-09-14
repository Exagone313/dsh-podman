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
and a single read-write project mount. It never falls back to host execution.

## Control plane

The plugin connects to the orchestrator over a Unix socket at
`<socketsRoot>/orchestrator.sock` and talks gRPC. Requests carry the shared
token (`DSH_PODMAN_ORCHESTRATOR_TOKEN`) as an `authorization: bearer` header.

The orchestrator service exposes these gRPC methods (backing both the UI and the
tools): `ListContainers` (returns only the guest containers the orchestrator
created — containers it does not own are never exposed),
`StartContainer{workspace_slug, container, image_id, mounts, env, secret_env}`
(creates or replaces a container in the workspace's pod; an empty `container`
targets the default container and other names are validated),
`RecreateContainer{workspace_slug, container, image_id, mounts, env,
secret_env}`
(stops, removes, and recreates a container, optionally with a new image, project
mounts, environment, or secret environment; an empty `image_id` keeps the
workspace's current image), `RemoveContainer`, `AddContainerMount`,
`RemoveContainerMount`, `AddContainerSecret`, and `RemoveContainerSecret`.

## Workspaces and pods

Each workspace maps to a **podman pod** (`dsh-podman-<slug>`, where `<slug>` is
the workspace UUID) so its containers share a network namespace. Every workspace
has a **default container** (`dsh-podman-<slug>-default`); additional, named
containers (`dsh-podman-<slug>-<name>`) can be created inside the same pod.
Containers' root filesystems are mounted read-only; all writable state lives in
the project bind mount, named volumes, or tmpfs mounts.

Beyond project mounts, a container can mount named volumes (prefixed
`DSH_PODMAN_VOLUME_PREFIX`, default `dsh-podman-`, and auto-created by podman on
first use), secrets, or tmpfs at arbitrary container paths — except where they
would overlap a reserved path:

- `DSH_PODMAN_PROJECTS_ROOT`, reserved for project mounts;
- `DSH_PODMAN_SOCKETS_ROOT`, which carries the guest agent's socket;
- `DSH_PODMAN_GUEST_AGENT_IMAGE_MOUNT`, which the container runs its entry point
  from.

A destination that contains a reserved path is refused as well as one that sits
inside it, since it would hide everything beneath it.

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

Commands and daemons inherit the guest agent's environment, minus the reserved
`DSH_PODMAN` namespace: the agent's own token stays with the agent instead of
being copied into everything it starts. A daemon started with `inheritEnv=false`
instead receives only the `PATH`/`HOME` baseline plus its own `env`.

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
Custom images are layered on top of a parent image and add extra packages.

`image_rebuild_all` first ensures every base image (building locally or pulling
from a public registry per `DSH_PODMAN_BASE_IMAGE_PREFIX`), then rebuilds the
stored custom images **in dependency order** — each parent before the images
derived from it. An image whose rebuild fails, and every image that depends on
it, is reported in `skipped` while the rest continue.

## Settings card transport

The settings card and the orchestrator talk over the settings transport:

- The host half registers the `podman` settings namespace and keeps a live view
  (`containers`, `images`, `volumes`, `secrets`, `notice`) in it.
- The card records its active locale as `uiLocale`, so the host can render
  approval text in the session language (see [Approval](usage.md#approval)).
- The card writes an action into `command` (`refresh` / `remove` / `recreate` /
  `create` / `image_rebuild` / `image_rebuild_all` / volume / secret /
  secret-env / mount ops); the host `watch` handler executes it against the
  orchestrator and pushes the refreshed view back.
