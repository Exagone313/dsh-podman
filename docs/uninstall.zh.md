<!--
SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>

SPDX-License-Identifier: MIT
-->

# 卸载

本页用于撤销[安装指南](install-dsh-and-dsh-podman.zh.md)中的操作：其中假设 dsh
运行在 dsh-podman 镜像中，并与编排器一同由 Quadlet 单元启动。

dsh 镜像会在容器启动时安装 dsh-podman 插件，而该插件的 bundle 层正是禁用 dsh
自带的 `subprocess`、`fs-sandbox` 与 `spill-local`
插件的原因。因此，卸载也意味着不再使用 dsh-podman 运行 dsh：其内置的 shell
与文件系统工具会重新启用，并以 dsh 用户的身份**在主机上**运行，不再有容器隔离。

## 停止容器并移除 Quadlet 单元

```bash
systemctl --user stop dsh dsh-podman-orchestrator
rm ~/.config/containers/systemd/dsh.container
rm ~/.config/containers/systemd/dsh-podman-orchestrator.container
systemctl --user daemon-reload
```

## 然后在以下两个选项中选择一个

这两个选项是并列的，而不是先后步骤：请根据你想保留的内容选择其一。

### 完全删除 dsh

```bash
rm -rf ~/.dsh
```

`~/.dsh` 是整个 harness 主目录：包含各个
profile（其中有已安装的插件）、设置，以及编排器的状态与软件包缓存。

### 保留 dsh 但不使用 dsh-podman

改为直接运行 dsh，而不是从镜像运行——如 harness 文档所述，使用
`npx @deepseek-ai/dsh web`——在此之前先从 profile 中移除插件，这样 dsh
便不再加载它，其内置插件也会重新启用：

```bash
npx @deepseek-ai/dsh plugin --profile web remove @exagone313/dsh-podman
npx @deepseek-ai/dsh web
```

然后归档曾使用 podman 工具的会话，从会话菜单中选择**归档会话**（Archive
session）：没有 dsh-podman
之后这些工具已不存在，继续恢复此类会话会让模型调用已消失的工具。

编排器残留的状态与软件包缓存也可以删除：

```bash
rm -rf ~/.dsh/dsh-podman
```

## 删除 Podman 资源（可选）

编排器会为每个 dsh 工作区创建一个
pod，并创建命名卷与机密，还会构建镜像。删除它们只是回收磁盘空间；项目目录是绑定挂载，绝不会被改动。

```bash
# 工作区 pod 及其容器，每个 dsh 工作区一个
podman pod ls --format '{{.Name}}' | grep '^dsh-podman-' | xargs -r podman pod rm -f

# 编排器创建的命名卷与机密
podman volume ls --format '{{.Name}}' | grep '^dsh-podman-' | xargs -r podman volume rm
podman secret ls --format '{{.Name}}' | grep '^dsh-podman-' | xargs -r podman secret rm

# 构建的工作区镜像、基础镜像，以及 dsh-podman 自身的镜像
podman images --format '{{.Repository}}:{{.Tag}}' | grep 'dsh-podman/' | xargs -r podman rmi
```
