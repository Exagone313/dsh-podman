<!--
SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>

SPDX-License-Identifier: MIT
-->

# Development container setup prompt

This page carries the prompt that builds a development image, creates the
toolchain volume and wires the workspace container to it, as described in
[Development](development.md#development-container-toolchain). Nothing it needs
exists beforehand.

Paste the block below into a dsh session attached to the workspace. It is safe
to run again: it inspects the workspace first and only creates, mounts or
changes what is missing or different. Recreating a container stops its daemons
and clears its tmpfs, so expect that whenever a change is needed.

Two steps stay manual on the host, and the prompt asks for them instead of
attempting them:

- rebuilding the dsh, orchestrator and guest-agent images (`make image`), which
  needs the repository checkout and podman on the host;
- installing or editing the Quadlet units under
  `~/.config/containers/systemd/`, then `systemctl --user daemon-reload` and a
  restart (see [Install development builds](development.md#install-development-builds)).

```text
Set up a development environment for this dsh-podman workspace. It must be safe
to run again: inspect the current state first, and only create, mount or change
what is missing or different, keeping whatever is already configured. Use the
container tools; never run `make` or edit files on the host.

1. Image: build a custom image named `dsh-podman-tooling` from the `archlinux`
   base with packages `go`, `nodejs-lts-jod`, `npm`, `deno`, `reuse` and
   `python-chardet`, unless an image of that name already exists in this
   workspace. It is a local image, not a published one; leave an existing one
   alone.
2. Volume: create the workspace volume `dsh-podman-toolchain` unless it already
   exists.
3. Container: inspect the default container's image, mounts, PATH additions and
   environment. Recreate it once, only if something below is missing or
   different, passing the complete merged sets so nothing existing is dropped:
   - image `dsh-podman-tooling`;
   - `dsh-podman-toolchain` mounted at `/opt/toolchain`, read-write, plus the
     workspace project mount and every mount already there;
   - PATH additions `/opt/toolchain/gopath/bin`,
     `/opt/toolchain/npm-global/bin` and `/opt/toolchain/pnpm-home`, in
     addition to the ones already there;
   - environment `GOCACHE=/opt/toolchain/gocache`,
     `GOMODCACHE=/opt/toolchain/gomodcache`, `GOPATH=/opt/toolchain/gopath`,
     `npm_config_cache=/opt/toolchain/npm-cache`,
     `npm_config_prefix=/opt/toolchain/npm-global`,
     `PNPM_HOME=/opt/toolchain/pnpm-home`,
     `DENO_DIR=/opt/toolchain/deno-dir` and
     `GOENV=/opt/toolchain/home/.config/go/env`, merged with the variables
     already on the container.
4. pnpm: the volume, not the image, carries pnpm. If `pnpm --version` does not
   report the version `package.json` pins in `packageManager`, install it with
   `npm install -g pnpm@<that version>` and check again.
5. Git identity: do not write a `~/.gitconfig`. If no Git identity is
   configured, tell me to set it once on the Podman page (sidebar **Plugins**
   panel): **Default environment → Git identity**.
6. Verify from inside the container, without sourcing anything: `make build`,
   `make vet` and `pnpm test` must succeed in the repository.
7. Report what you created or changed, or that everything was already in place.
   If a step needs the host — rebuilding the dsh, orchestrator or guest-agent
   images (`make image`), or editing the Quadlet units under
   `~/.config/containers/systemd/` and reloading systemd — stop and ask me
   instead of trying it.
```
