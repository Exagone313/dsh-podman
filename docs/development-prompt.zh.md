<!--
SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>

SPDX-License-Identifier: MIT
-->

# 开发容器设置提示词

本页给出用于构建开发镜像、创建工具链卷并把工作区容器接好的提示词，参见[开发](development.zh.md#开发容器工具链)。其中没有任何东西是现成的。

把下面的文本块粘贴到已接入该工作区的 dsh 会话中。它可以反复运行：先检查工作区现状，只创建、挂载或修改缺失或不同的部分。重建容器会终止其守护进程并清空
tmpfs，因此在需要变更时请预期这一点。

以下步骤仍需在宿主机上手动完成，提示词只会请求它们，而不会自行尝试：

- 重建 dsh、orchestrator 和 guest-agent 镜像（`make image`），这需要宿主机上的仓库检出与 podman；
- 安装或编辑 `~/.config/containers/systemd/` 下的 Quadlet 单元，随后执行 `systemctl --user daemon-reload`
  并重启（见[安装开发构建](development.zh.md#安装开发构建)）。

下面的提示词与英文页保持一致，原样粘贴即可。

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
   panel → **Installed** → **dsh-podman**): **Default
   environment → Git identity**.
6. Verify from inside the container, without sourcing anything: `make build`,
   `make vet` and `pnpm test` must succeed in the repository.
7. Report what you created or changed, or that everything was already in place.
   If a step needs the host — rebuilding the dsh, orchestrator or guest-agent
   images (`make image`), or editing the Quadlet units under
   `~/.config/containers/systemd/` and reloading systemd — stop and ask me
   instead of trying it.
```
