<!--
SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>

SPDX-License-Identifier: MIT
-->

# Installation

dsh-podman has two parts that must both run:

- the **plugin** (`@exagone313/dsh-podman`), installed inside dsh, and
- the **orchestrator** (`dsh-podman-orchestrator`), a container that controls
  Podman on your machine.

This guide assumes dsh and Podman run on the **host** (not inside containers)
and that you install the plugin **from npm**.

## Prerequisites

- [dsh](https://github.com/deepseek-ai/deepseek-harness) (DeepSeek Harness)
  installed.
- `podman` installed.
- The Podman **user** socket enabled (rootless Podman):

  ```sh
  systemctl --user enable --now podman.socket
  ```

  The orchestrator talks to Podman over this socket.

## 1. Install the plugin from npm

```sh
dsh plugin add @exagone313/dsh-podman
```

`dsh plugin` installs the package into the profile's bundle layer stack (the
package declares `dsh.bundle`). The bundled `cordis.patch.yml` disables the
built-in `subprocess` and `fs-sandbox` rows and mounts the plugin instead:

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

## 2. Run the orchestrator with Quadlet

Create `~/.config/containers/systemd/dsh-podman-orchestrator.container`:

```ini
[Unit]
Description=dsh-podman orchestrator

[Container]
Image=ghcr.io/exagone313/dsh-podman/orchestrator:latest
Environment=DSH_PODMAN_ORCHESTRATOR_PODMAN_SOCKET=unix:///run/podman/podman.sock
Environment=DSH_PODMAN_ORCHESTRATOR_STATE=/var/lib/dsh-orchestrator
Environment=DSH_PODMAN_SOCKETS_ROOT=/run/dsh-podman
Environment=DSH_PODMAN_HOST_SOCKETS_ROOT=%h/.local/share/dsh-podman/sockets
Environment=DSH_PODMAN_PROJECTS_ROOT=/projects
Environment=DSH_PODMAN_HOST_PROJECTS_ROOT=%h/projects
Environment=DSH_PODMAN_IMAGE_PREFIX=localhost/dsh-podman/
Environment=DSH_PODMAN_BASE_IMAGE_PREFIX=localhost/dsh-podman/base/
Environment=DSH_PODMAN_GUEST_AGENT_IMAGE=ghcr.io/exagone313/dsh-podman/guest-agent:latest
Environment=DSH_PODMAN_ORCHESTRATOR_TOKEN=<shared-token>
Volume=%h/.local/share/dsh-podman/sockets:/run/dsh-podman
Volume=%h/.local/share/dsh-podman/state:/var/lib/dsh-orchestrator
Volume=%h/projects:/projects
Volume=/run/user/%U/podman/podman.sock:/run/podman/podman.sock

[Install]
WantedBy=default.target
```

Create the host directories and start the service:

```sh
mkdir -p ~/.local/share/dsh-podman/sockets \
         ~/.local/share/dsh-podman/state \
         ~/projects
chmod 700 ~/.local/share/dsh-podman/sockets
systemctl --user daemon-reload
systemctl --user enable --now dsh-podman-orchestrator
systemctl --user status dsh-podman-orchestrator
```

Notes:

- Replace `<shared-token>` with a random value, for example
  `openssl rand -hex 32`, and use the **same** value for the plugin (next
  section).
- `%h` is your home directory and `%U` your user id (Quadlet specifiers).
- Base images are **built locally** by the orchestrator (the
  `localhost/dsh-podman/base/` prefix). To pull prebuilt base images from a
  registry instead, change `DSH_PODMAN_BASE_IMAGE_PREFIX` to that registry's
  prefix. The guest-agent image is always taken from GHCR and baked into base
  builds.
- The sockets directory should be `0700`; the orchestrator's control socket is
  created with `0600`.

## 3. Environment variables for dsh

dsh runs on the host and connects to the orchestrator over
`<socketsRoot>/orchestrator.sock`. Set these environment variables where dsh
starts:

| Variable | Required | Description |
|---|---|---|
| `DSH_PODMAN_SOCKETS_ROOT` | yes | Host directory holding `orchestrator.sock`; must match the orchestrator's `DSH_PODMAN_HOST_SOCKETS_ROOT` |
| `DSH_PODMAN_PROJECTS_ROOT` | yes | Host projects root; must match the orchestrator's `DSH_PODMAN_HOST_PROJECTS_ROOT` |
| `DSH_PODMAN_ORCHESTRATOR_TOKEN` | yes¹ | Shared token; must match the orchestrator's `DSH_PODMAN_ORCHESTRATOR_TOKEN` |
| `DSH_PODMAN_IMAGE_PREFIX` | no | Prefix used for built custom images (default `localhost/dsh-podman/`) |

¹ Required when the orchestrator has a token set. Without a token the
orchestrator accepts unauthenticated calls (relying on socket permissions).

For the Quadlet layout above:

```sh
export DSH_PODMAN_SOCKETS_ROOT="$HOME/.local/share/dsh-podman/sockets"
export DSH_PODMAN_PROJECTS_ROOT="$HOME/projects"
export DSH_PODMAN_ORCHESTRATOR_TOKEN="<shared-token>"
```

The same values can be given to the plugin through dsh's cordis config instead
of the environment (`socketsRoot`, `projectsRoot`, `controlToken`, `imagePrefix`).

See [Configuration](configuration.md) for the full reference.

## 4. Verify

- Open **Settings → Plugins → Podman**: the card should list the base images
  and, for a workspace, offer to create its default container.
- In a dsh session, run a shell command. It should execute inside a Podman
  container for the current workspace (the plugin auto-creates the workspace's
  default container on first use).