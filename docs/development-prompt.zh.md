<!--
SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>

SPDX-License-Identifier: MIT
-->

# 开发容器设置提示词

[English](development-prompt.md) | 中文

本页给出设置开发容器的提示词：它构建开发镜像、创建 `dsh-podman-toolchain`
卷，并把工作区容器接好（挂载、环境变量与 PATH
追加项），参见[开发](development.zh.md#开发容器工具链)。提示词通过应用项目已提交的
[`.dsh-podman/develop.yml`](../.dsh-podman/develop.yml)
容器模板来完成这些，模板声明了上述内容。

在粘贴提示词之前，请先把 `deepseek-harness` 仓库克隆到 projects
根目录，使其成为项目
`deepseek-harness`。模板会以只读方式挂载该项目，项目缺失时无法加载模板。请在
projects 根目录（即包含本检出的目录）中运行：

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
```

把下面的文本块粘贴到已接入该工作区的 dsh
会话中。它可以反复运行：加载模板会把默认容器的镜像与挂载替换为模板的镜像与挂载，并替换模板声明的环境变量、机密环境变量与
PATH 追加项，模板未声明的分组则保留当前值。替换容器会终止其守护进程并清空
tmpfs，因此每次应用模板时请预期这一点。

以下步骤仍需在宿主机上手动完成，提示词只会请求它们，而不会自行尝试：

- 重建 dsh、orchestrator 和 guest-agent
  镜像（`make image`），这需要宿主机上的仓库检出与 podman；
- 安装或编辑 `~/.config/containers/systemd/` 下的 Quadlet 单元，随后执行
  `systemctl --user daemon-reload`
  并重启（见[安装开发构建](development.zh.md#安装开发构建)）。

下面的提示词与英文页保持一致，原样粘贴即可。

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
