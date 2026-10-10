<!--
SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>

SPDX-License-Identifier: MIT
-->

# 更新

[English](update.md) | 中文

只应在没有 agent 运行时进行更新。

现有的 guest 容器随后会被重建，因此运行中的进程和守护进程会被终止。

请注意，对应的 dsh-podman 插件会在启动时从 npm 安装。

启用自动更新后，也可以在 agent 运行时跳过更新。请继续阅读以了解如何设置。

## 从 1.2.0 之前的版本更新

从 1.2.0 之前的版本更新时，请先把更新后的
[dsh.container](../quadlet/dsh.container) 与
[dsh-podman-orchestrator.container](../quadlet/dsh-podman-orchestrator.container)
复制到 `~/.config/containers/systemd/`，然后重新加载 systemd
配置并重启这两个服务，再执行后续步骤：

```bash
cp quadlet/dsh.container quadlet/dsh-podman-orchestrator.container ~/.config/containers/systemd/
systemctl --user daemon-reload
systemctl --user restart dsh-podman-orchestrator dsh
```

如果你自定义过这些文件，请改为添加以下内容：

- [dsh.container](../quadlet/dsh.container)：`%h/.agents` 卷
  （`Volume=%h/.agents:%h/.agents:ro`）、
  `Environment=DSH_AGENTS_HOME=%h/.agents`，以及在现有 `ExecStartPre` 中加入
  `mkdir -p -m 0700 %h/.agents/skills`；
- [dsh-podman-orchestrator.container](../quadlet/dsh-podman-orchestrator.container)：
  `Environment=DSH_PODMAN_HOST_SKILL_DIR=%h/.agents/skills`，以及在现有
  `ExecStartPre` 中加入同样的 `mkdir`。

本版本新增了对 skill 的支持（见[用法](usage.zh.md#技能)）。dsh
现在会从多个位置读取它们：

- 用户 skill：`~/.dsh/skills` 与 `~/.agents/skills`；
- 项目 skill：工作区内的 `.dsh/skills` 与 `.agents/skills`。

为了让 agent 能运行用户 skill 附带的代码，`~/.agents/skills`
会以只读方式挂载进每个 guest 容器。`~/.dsh/skills` 会被读取，但绝不会挂载进任何
guest 容器，出于安全原因。

## 从 1.1.0 之前的版本更新

`dsh-podman-gateway` 容器是 1.1.0 新增的：更早的版本不会提供它的
Quadlet。gateway 是可选的，只在发布 pod
端口时需要（见[用法](usage.zh.md#端口发布)）；没有它时，`container_publish_port`
会报错，提示你安装并启动 gateway Quadlet。

从 1.1.0 之前的版本更新时，请先把
[dsh-podman-gateway.container](../quadlet/dsh-podman-gateway.container) 复制到
`~/.config/containers/systemd/`，并启动它一次，然后再执行后续步骤：

```bash
cp quadlet/dsh-podman-gateway.container ~/.config/containers/systemd/
systemctl --user daemon-reload
systemctl --user start dsh-podman-gateway
```

## 手动更新

拉取新镜像：

```bash
podman pull ghcr.io/exagone313/dsh-podman/dsh:1 ghcr.io/exagone313/dsh-podman/orchestrator:1 ghcr.io/exagone313/dsh-podman/gateway:1
```

重启 dsh、dsh-podman-orchestrator 和 dsh-podman-gateway：

```bash
systemctl --user restart dsh dsh-podman-orchestrator dsh-podman-gateway
```

## 升级到新的主版本

目前，dsh-podman 的主版本是 1。要升级到主版本 2 及以上，请查看
[发布说明](https://github.com/Exagone313/dsh-podman/releases)。

## 启用自动更新

dsh、dsh-podman-orchestrator 和 dsh-podman-gateway 的 quadlet
配置启用了镜像自动更新 （`AutoUpdate=registry`）。要使其生效，需要启用
`podman-auto-update` systemd 计时器：

```bash
systemctl --user enable --now podman-auto-update.timer
```

另外，请确保已为你的用户启用 user lingering（常驻）（以 root 身份）：

```bash
loginctl enable-linger your-username
```

每次计时器运行时，Podman 自动更新工具都会尝试拉取镜像的新版本。如果拉取到了
新版本，相应的容器将被重建。

默认情况下，该计时器每天运行一次，大约在午夜。

## 更改自动更新的时间

你可以覆盖计时器的运行时间。

创建包含 `podman-auto-update` systemd 计时器用户覆盖文件的目录：

```bash
mkdir -p ~/.config/systemd/user/podman-auto-update.timer.d
```

把
[`podman-auto-update.timer.conf`](../systemd-dropins/podman-auto-update.timer.conf)
这个 drop-in（覆盖）文件复制到该目录中，并根据需要编辑其内容。

```bash
cp systemd-dropins/podman-auto-update.timer.conf ~/.config/systemd/user/podman-auto-update.timer.d/
```

重新加载 systemd 配置并重启计时器：

```bash
systemctl --user daemon-reload
systemctl --user restart podman-auto-update.timer
```

你可以用以下命令验证计时器下次运行的时间：

```bash
systemctl --user list-timers
```

同一个 drop-in 文件也可以编辑成每天多次运行更新。

## 在 agent 运行时跳过更新

更新会重启 dsh 容器，这会中断任何正在进行的 agent 回合。可以在 agent 运行时
跳过更新。

创建包含 `podman-auto-update` systemd 服务用户覆盖文件的目录（注意：它和
计时器的目录不是同一个）：

```bash
mkdir -p ~/.config/systemd/user/podman-auto-update.service.d
```

把
[`podman-auto-update-skip-when-busy.conf`](../systemd-dropins/podman-auto-update-skip-when-busy.conf)
这个 drop-in（覆盖）文件复制到该目录中。

```bash
cp systemd-dropins/podman-auto-update-skip-when-busy.conf ~/.config/systemd/user/podman-auto-update.service.d/
```

重新加载 systemd 配置：

```bash
systemctl --user daemon-reload
```
