<!--
SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>

SPDX-License-Identifier: MIT
-->

# Development container setup prompt

English | [中文](development-prompt.zh.md)

This page carries the prompt that sets up the development container: it builds
the development image, creates the `dsh-podman-toolchain` volume and wires the
workspace container to it with the mounts, environment and PATH additions, as
described in [Development](development.md#development-container-toolchain). The
prompt does this by applying the project's committed
[`.dsh-podman/develop.yml`](../.dsh-podman/develop.yml) container template,
which declares those elements.

Paste the block below into a dsh session attached to the workspace. It is safe
to run again: loading the template replaces the default container's image and
mounts with the template's, replaces the environment, secret environment and
PATH additions it declares, and keeps the groups it leaves undeclared at their
current values. Replacing a container stops its daemons and clears its tmpfs, so
expect that whenever the template is applied.

Before the prompt, clone the `deepseek-harness` repository into the projects
root so it exists there as the project `deepseek-harness`. The template mounts
that project read-only and cannot be loaded while it is missing. Run this from
the projects root, the directory that holds this checkout:

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
```

Two steps stay manual on the host, and the prompt asks for them instead of
attempting them:

- rebuilding the dsh, orchestrator and guest-agent images (`make image`), which
  needs the repository checkout and podman on the host;
- installing or editing the Quadlet units under `~/.config/containers/systemd/`,
  then `systemctl --user daemon-reload` and a restart (see
  [Install development builds](development.md#install-development-builds)).

```text
Set up a development environment for this dsh-podman workspace from the
project's committed `.dsh-podman/develop.yml` container template. It must be
safe to run again: applying the template reconciles the default container with
the image, mounts, environment and PATH it declares. Use the container tools,
and never run `make` or edit files on the host.

1. Prerequisite: check that the project `deepseek-harness` exists under the
   projects root. If it does not, stop and ask me to clone the
   `deepseek-harness` repository there (a host step); the template mounts that
   project read-only and cannot be loaded without it.
2. Template: call the `container_template_load` tool with template `develop`
   and container `default`; the change needs approval. The tool builds the
   template image when needed, replaces the default container with the
   template's image, mounts, environment, secret environment and PATH
   additions, and publishes the template's ports. The template's mounts replace
   the container's mounts; the environment, secret environment and PATH
   additions it declares replace those groups, and groups it leaves undeclared
   keep their current values. The resulting image is `archlinux`-based and
   carries `go`, `nodejs`, `npm`, `python-chardet` and `reuse`.
3. pnpm: the volume, not the image, carries pnpm. If `pnpm --version` does not
   report the version `package.json` pins in `packageManager`, install it with
   `npm install -g pnpm@<that version>` and check again. dprint, the formatter,
   is a project devDependency and arrives with `pnpm install`.
4. Git identity: do not write a `~/.gitconfig`. If no identity is configured,
   tell me to set it once on the Podman page's **Defaults** tab: **Default
   environment variables** → **Git identity**.
5. Verify from inside the container, without sourcing anything: `make build`,
   `make vet` and `pnpm test` must succeed in the repository.
6. Report what changed, or that everything already matched the template. If a
   step needs the host — cloning `deepseek-harness`, rebuilding the dsh,
   orchestrator or guest-agent images (`make image`), or editing the Quadlet
   units under `~/.config/containers/systemd/` and reloading systemd — stop and
   ask me instead of trying it.
```
