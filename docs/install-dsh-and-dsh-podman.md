<!--
SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>

SPDX-License-Identifier: MIT
-->

# Install DeepSeek Harness & dsh-podman with rootless Podman

## Goals

The goal of this guide is to install:

- [DeepSeek Harness](https://deepseek.com/harness), referred to later as _dsh_
- the dsh-podman plugin in dsh, which replaces host filesystem and shell access
- the dsh-podman orchestrator, a separate Podman container that integrates with
  Podman

Having the dsh plugin and the orchestrator running as separate containers is an
important part of the security design of dsh-podman: dsh itself doesn't have
direct access to Podman, only the orchestrator does, with limitations. dsh
shouldn't be able to escalate privileges using this path, as the capabilities
provided to dsh are constrained:

- the names of pods, containers, volumes and secrets are prefixed with
  `dsh-podman-`
- mounted paths are limited to bind-mounted project directories and managed
  volumes
- containers are dealt with separately for each dsh workspace.

Nevertheless, it is recommended to run dsh as a dedicated user instead of your
main user.

Note that, for now, network access is not constrained, but support for this
could be added in the future.

## Terminology

- **dsh**: DeepSeek Harness, a plugin-oriented AI agent harness developed by
  DeepSeek
- **dsh-podman**: this project
- **dsh-podman plugin**: the plugin installed in dsh, which provides tools to
  agents and a UI for manual settings, and connects to the orchestrator;
  referred to later as _plugin_
- **dsh-podman orchestrator**: the daemon that receives connections from the
  dsh-podman plugin, has access to the Podman socket and manages containers and
  other resources; it runs in a container; referred to later as _orchestrator_
- **Podman socket**: while the Podman client can be used without a daemon, it is
  still possible to enable management through a socket, which is required by the
  orchestrator to work as if it were running on the host system
- **guest container**: a container created by the dsh-podman orchestrator, in
  relation to a dsh workspace
- **dsh workspace**: in dsh, a project uses the name _workspace_, with its own
  dedicated directory

## Requirements

- A user to run dsh as (not root)
- A Linux distribution powered by systemd
- Podman 5 or later; Podman 6 is recommended
- A systemd session as your dsh user (**`sudo -iu` will not work**):
  - by using machinectl (recommended; on some distributions, this command is
    part of the `systemd-container` package; it needs to be run as root or as
    part of the _wheel_ group):
    ```bash
    machinectl shell --uid=your-username
    ```
  - by connecting via SSH
  - by connecting on a tty

## Recommendations

- If you want to start dsh at boot,
  [enable _user lingering_ for your user](https://www.freedesktop.org/software/systemd/man/loginctl.html#enable-linger%20USER%E2%80%A6)
  as root:
  ```bash
  loginctl enable-linger your-username
  ```
- Ensure that Podman is working correctly as your dsh user (⚠️ the first command
  may stop existing containers!):
  ```bash
  podman system migrate
  podman run --rm quay.io/podman/hello
  podman rmi quay.io/podman/hello
  ```

## Preparation

- You need to choose a project directory. This directory will be mounted
  read-only in dsh (necessary for the integrated project manager) and read-write
  in guest containers. In this guide we will use `${HOME}/project`
  (`%h/project`) but you are free to choose another path, as long as your user
  has read-write access to it.
- Create a project inside the chosen directory. This will be useful to create a
  workspace in dsh to validate the setup.

## Installation

This installation uses
[Podman Quadlet](https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html),
which adds Podman integration into systemd.

Note that the dsh-podman plugin will be installed at dsh container startup,
which requires online access.

1. Create the Quadlet directory for your user:
   ```bash
   mkdir -p ~/.config/containers/systemd
   ```
2. Copy the files [dsh.container](../quadlet/dsh.container) and
   [dsh-podman-orchestrator.container](../quadlet/dsh-podman-orchestrator.container)
   to `~/.config/containers/systemd/`.
   - Adapt the files to your desired project directory if you wish to change it.
3. Reload systemd session configuration:
   ```bash
   systemctl --user daemon-reload
   ```
4. Check if there are errors in the configuration:
   ```bash
   journalctl --user -e
   ```
5. Start dsh and dsh-podman-orchestrator:
   ```bash
   systemctl --user start dsh dsh-podman-orchestrator
   ```
6. Check if there are startup errors from either container:
   ```bash
   journalctl --user -eu dsh
   ```
   ```bash
   journalctl --user -eu dsh-podman-orchestrator
   ```
7. View the dsh container logs:
   ```bash
   podman logs dsh
   ```
8. Visit the given URL in the form `http://127.0.0.1:3080/?token=xxx` to access
   dsh.
9. Once your web browser has saved this token, you'll be able to access dsh with
   the URL [http://127.0.0.1:3080/](http://127.0.0.1:3080/).

## Verification

- Open **Settings → Plugins → dsh-podman**: the card should list the base images
  and, for a workspace, offer to create its default container.
- In a dsh session, run a shell command. It should execute inside a Podman
  container for the current workspace (the plugin auto-creates the workspace's
  default container on first use).

## Enable daily auto-updates (optional)

This requires enabling lingering for your user.

```bash
systemctl --user enable --now podman-auto-update.timer
```
