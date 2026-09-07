<!--
SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>

SPDX-License-Identifier: MIT
-->

# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub, from the repository's
**Security** tab → **Report a vulnerability**. This opens a private advisory
visible only to you and the maintainers.

There is no bounty programme and no guaranteed response time. Fixes ship as a
normal release. Deployments using the provided quadlets pick up new images
automatically (`AutoUpdate=registry`); the npm plugin must be updated by hand.

## Supported versions

Only the latest release is supported and fixes are not backported.

## Trust model

Most of what follows is not a limitation to be fixed but the shape of the
system. Read this before deciding where to run dsh-podman.

### The control socket is a full-privilege interface

The orchestrator holds the rootless Podman API socket. Anyone who can connect to
`<DSH_PODMAN_SOCKETS_ROOT>/orchestrator.sock` can create containers, mount any
directory under the projects root, create and attach secrets, and pull and run
images. That is equivalent to the authority of the user account running podman —
including its home directory and its other containers.

Access to that socket is controlled by **filesystem permissions**:

- the socket is created with mode `0600`;
- the orchestrator refuses to start unless its directory is `0700`;
- both the orchestrator and the guest agents set a `0077` umask at startup, so a
  socket is never briefly reachable between `bind` and `chmod`.

`DSH_PODMAN_ORCHESTRATOR_TOKEN` is **defence in depth, not the security
boundary**. Running without a token is a supported configuration: a client that
can reach the socket can generally also read the token, and outside a container
the podman socket itself carries no authentication either. Set a token if it
suits your deployment, but do not rely on it in place of the file permissions.

### A guest container is not a boundary against its own contents

Running arbitrary commands inside a guest container is the entire purpose of the
project. Anything executing there has full access to that container's mounts,
environment and attached secrets. Treat the contents of a guest container as
untrusted, and never mount anything into one you would not hand to the model
outright.

A guest container **is** a boundary against other containers and the host:

- only its own `<DSH_PODMAN_SOCKETS_ROOT>/<container>` directory is mounted into
  it, so it cannot reach `orchestrator.sock` or another workspace's guest
  socket;
- it gets no podman socket;
- its root filesystem is read-only, so writable state lives only in the mounts
  it was given;
- the guest agent withholds the reserved `DSH_PODMAN` environment namespace,
  including its own token, from every process it starts.

A **workspace is a single trust domain**: its containers share a pod network
namespace and can reach each other over localhost.

### The orchestrator is the enforcement point

The plugin does not validate on the orchestrator's behalf. Every rule below is
enforced in the orchestrator and re-checked on each container-creating path,
including against state read back from disk:

- project mounts are confined to `DSH_PODMAN_PROJECTS_ROOT`, resolved through
  symlinks, so a symlink planted in a writable project cannot redirect a bind
  mount outside it; symlinks with absolute targets are never followed;
- tmpfs, volume and secret mount destinations may not overlap a reserved path
  (the projects root, the sockets root, or the guest agent mount) — as an
  ancestor or as a descendant;
- named volumes and secrets are confined to the configured prefixes;
- environment variable names in the `DSH_PODMAN` namespace are refused;
- image identifiers and package names are allow-listed, and package names cannot
  begin with `-`;
- unknown mount kinds and modes are rejected rather than being given a default.

Note that **any workspace may mount any directory under the projects root**. The
projects root is the boundary; individual projects are not isolated from one
another. Do not place a project under it that other projects should not be able
to read.

### What only the plugin can enforce

Approval prompts, sandbox modes and per-tool policy need the model session's
context, which the control plane does not have. These are additional protections
layered on top of the orchestrator, never a substitute for it.

Setting the harness approval policy to `never` removes all of them, and the
orchestrator will accept whatever it is then sent.

### Secrets

Secret values are write-only through the control API: they are never returned by
any RPC and never logged. A secret attached to a container is nonetheless
readable by everything running in that container, whether it is mounted as a
file or exposed as an environment variable. Secrets exist to get values _into_ a
workload, not to keep them from it.

## Out of scope

**Denial of service and resource exhaustion.** There are no quotas on
workspaces, containers, mounts, volumes, secrets, images, daemons or disk usage.
A hostile or merely runaway workload can exhaust the resources of the user
account running podman. Deploy under a dedicated user if that matters to you.

**Anything requiring write access to the orchestrator's state directory or to
the host podman socket.** Both already confer everything the orchestrator can
do, so an attacker holding either has not crossed a boundary.

## Known residual risks

- **Mount source races.** Project mounts are resolved and then handed to podman
  as a path, which podman resolves again when it performs the mount. A workload
  able to write to the projects root can in principle replace a path component
  in that window. Passing the resolved path narrows this considerably — every
  component was a real directory at validation time — but it cannot be closed
  while podman takes a path rather than a file descriptor.
- **The guest agent runs as root inside its container.** The generated workspace
  images declare no unprivileged user. Container-level isolation, not
  in-container privilege separation, is what keeps a workspace contained.
- **Images are pulled by mutable tag.** The provided quadlets use
  `AutoUpdate=registry` against `ghcr.io`, so trust in that registry and in the
  release pipeline is load-bearing.

## Notes for operators

- Keep `DSH_PODMAN_SOCKETS_ROOT` at mode `0700`; widening it exposes the control
  socket to other users on the host.
- `DSH_PODMAN_BASE_IMAGE_PREFIX` decides whether base images are **built locally
  or pulled**, purely by whether it starts with `localhost/`. Pointing it at a
  registry means running images from that registry.
- Keep `DSH_PODMAN_PROJECTS_ROOT` and `DSH_PODMAN_HOST_PROJECTS_ROOT` describing
  the same tree. Mounts are validated against the first and performed against
  the second; if they diverge, the validation does not describe what is actually
  mounted.
- Run the orchestrator under a user account dedicated to it. Its authority is
  that account's authority.
