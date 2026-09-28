<!--
SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>

SPDX-License-Identifier: MIT
-->

# Update

You should run updates only when no agents are running.

Existing guest containers will be recreated afterwards, so running processes and
daemons will be killed.

Note that the corresponding dsh-podman plugin will be installed from npm at
startup.

When enabling auto-updates, it is possible to skip updates while an agent is
running. Read further to set this up.

## Update manually

Pull the new images:

```bash
podman pull ghcr.io/exagone313/dsh-podman/dsh:1 ghcr.io/exagone313/dsh-podman/orchestrator:1
```

Restart dsh and dsh-podman-orchestrator:

```bash
systemctl --user restart dsh dsh-podman-orchestrator
```

## Upgrade to a new major version

Currently, dsh-podman major version is 1. To upgrade to major version 2 and
above, check the
[release notes](https://github.com/Exagone313/dsh-podman/releases).

## Enable auto-updates

The quadlet configuration for dsh and dsh-podman-orchestrator enables
auto-update of images (`AutoUpdate=registry`). The `podman-auto-update` systemd
timer needs to be enabled for this to work:

```bash
systemctl --user enable --now podman-auto-update.timer
```

Also, make sure user lingering is enabled for your user (as root):

```bash
loginctl enable-linger your-username
```

Each time the timer runs, the Podman auto-update tool tries to pull newer
versions of the images. If new versions are pulled, the corresponding containers
will be recreated.

By default, this timer runs once per day, around midnight.

## Change when auto-updates happen

You can override the time when the timer runs.

Create the directory that contains user overrides for the `podman-auto-update`
systemd timer:

```bash
mkdir -p ~/.config/systemd/user/podman-auto-update.timer.d
```

Copy the drop-in
[`podman-auto-update.timer.conf`](../systemd-dropins/podman-auto-update.timer.conf)
into the directory and edit its content according to your needs.

```bash
cp systemd-dropins/podman-auto-update.timer.conf ~/.config/systemd/user/podman-auto-update.timer.d/
```

Reload systemd configuration and restart the timer:

```bash
systemctl --user daemon-reload
systemctl --user restart podman-auto-update.timer
```

You can verify when the timer will run next with:

```bash
systemctl --user list-timers
```

The same drop-in file can be edited to run updates multiple times a day.

## Skip updates while an agent is running

An update restarts the dsh container, which interrupts any agent turn in flight.
It is possible to skip updates when an agent is running.

Create the directory that contains user overrides for the `podman-auto-update`
systemd service (it is not the same directory as the timer):

```bash
mkdir -p ~/.config/systemd/user/podman-auto-update.service.d
```

Copy the drop-in
[`podman-auto-update-skip-when-busy.conf`](../systemd-dropins/podman-auto-update-skip-when-busy.conf)
into the directory.

```bash
cp systemd-dropins/podman-auto-update-skip-when-busy.conf ~/.config/systemd/user/podman-auto-update.service.d/
```

Reload systemd configuration:

```bash
systemctl --user daemon-reload
```
