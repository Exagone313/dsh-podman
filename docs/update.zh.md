<!--
SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>

SPDX-License-Identifier: MIT
-->

# 更新

只应在没有 agent 运行时进行更新。

现有的 guest 容器随后会被重建，因此运行中的进程和守护进程会被终止。

请注意，对应的 dsh-podman 插件会在启动时从 npm 安装。

启用自动更新后，也可以在 agent 运行时跳过更新。请继续阅读以了解如何设置。

## 手动更新

拉取新镜像：

```bash
podman pull ghcr.io/exagone313/dsh-podman/dsh:1 ghcr.io/exagone313/dsh-podman/orchestrator:1
```

重启 dsh 和 dsh-podman-orchestrator：

```bash
systemctl --user restart dsh dsh-podman-orchestrator
```

## 升级到新的主版本

目前，dsh-podman 的主版本是 1。要升级到主版本 2 及以上，请查看
[发布说明](https://github.com/Exagone313/dsh-podman/releases)。

## 启用自动更新

dsh 和 dsh-podman-orchestrator 的 quadlet 配置启用了镜像自动更新
（`AutoUpdate=registry`）。要使其生效，需要启用 `podman-auto-update` systemd
计时器：

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
