<!--
SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>

SPDX-License-Identifier: MIT
-->

# Uninstall

This page undoes the [installation guide](install-dsh-and-dsh-podman.md): it
assumes dsh runs from the dsh-podman image with the orchestrator, both started
from Quadlet units.

The dsh image installs the dsh-podman plugin at container start, and the
plugin's bundle layer is what disables dsh's own `subprocess`, `fs-sandbox`,
`spill-local` and built-in Terminal UI (`ui-sidebar-terminal`) plugins. Uninstalling therefore also means running dsh without
dsh-podman: its built-in shell and filesystem tools are active again, and they
run **on the host** as the dsh user, with no container isolation.

## Stop the containers and remove the Quadlet units

```bash
systemctl --user stop dsh dsh-podman-orchestrator
rm ~/.config/containers/systemd/dsh.container
rm ~/.config/containers/systemd/dsh-podman-orchestrator.container
systemctl --user daemon-reload
```

## Then choose one of the two following options

These are alternatives, not steps: pick the one that matches what you want to
keep.

### Remove dsh entirely

```bash
podman unshare rm -rf ~/.dsh
```

`~/.dsh` is the whole harness home: the profiles (including the installed
plugin), the settings, and the orchestrator's state and package caches. The
orchestrator runs as root, so parts of that directory belong to the container's
root and only `podman unshare` can remove them, from the user namespace.

### Keep dsh without dsh-podman

Run dsh directly instead of from the image — as the harness documents, with
`npx @deepseek-ai/dsh web` — after removing the plugin from the profile, so dsh
stops loading it and its built-in plugins are active again:

```bash
npx @deepseek-ai/dsh plugin --profile web remove @exagone313/dsh-podman
npx @deepseek-ai/dsh web
```

Then archive the sessions that used the podman tools, from the session's menu
(**Archive session**): those tools no longer exist without dsh-podman, so
resuming such a session would leave the model calling tools that are gone.

The orchestrator's leftover state and package caches can be removed too. They
belong to the container's root, so remove them from the user namespace:

```bash
podman unshare rm -rf ~/.dsh/dsh-podman
```

## Remove the Podman resources (optional)

The orchestrator creates one pod per dsh workspace, plus named volumes and
secrets, and builds images. Removing them only reclaims disk space; project
directories are bind mounts and are never touched.

```bash
# Workspace pods and their containers, one per dsh workspace
podman pod ls --format '{{.Name}}' | grep '^dsh-podman-' | xargs -r podman pod rm -f

# Named volumes and secrets the orchestrator created
podman volume ls --format '{{.Name}}' | grep '^dsh-podman-' | xargs -r podman volume rm
podman secret ls --format '{{.Name}}' | grep '^dsh-podman-' | xargs -r podman secret rm

# Built workspace images, the base images, and the dsh-podman images themselves
podman images --format '{{.Repository}}:{{.Tag}}' | grep 'dsh-podman/' | xargs -r podman rmi
```
