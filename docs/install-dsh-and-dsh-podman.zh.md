<!--
SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>

SPDX-License-Identifier: MIT
-->

# 使用 rootless Podman 安装 DeepSeek Harness 与 dsh-podman

## 目标

本指南的目标是安装：

- [DeepSeek Harness](https://deepseek.com/harness)，下文简称 _dsh_
- dsh 中的 dsh-podman 插件，它取代了宿主的文件系统和 shell 访问
- dsh-podman 编排器，一个与 Podman 集成的独立 Podman 容器

将 dsh 插件和编排器作为独立的容器运行，是 dsh-podman 安全设计的重要一环： dsh
本身不能直接访问 Podman，只有编排器可以，并且受到限制。dsh
不应能通过这条路径提权，因为提供给 dsh 的权限能力是受限的：

- pod、容器、卷和 secret 的名称都以 `dsh-podman-` 为前缀
- 挂载路径仅限于绑定挂载的项目目录和受管理的卷
- 每个 dsh 工作区分别管理各自的容器。

尽管如此，仍建议使用专用用户运行 dsh，而不是你的主用户。

请注意，目前网络访问不受限制，但未来可能会添加对此的支持。

## 术语

- **dsh**：DeepSeek Harness，由 DeepSeek 开发的面向插件的 AI agent harness
- **dsh-podman**：本项目
- **dsh-podman 插件**：安装在 dsh 中的插件，它为 agent 提供工具、提供手动设置
  UI，并连接编排器；下文简称 _plugin_
- **dsh-podman 编排器**：接收来自 dsh-podman 插件连接的守护进程，可访问 Podman
  套接字并管理容器和其他资源；它在容器中运行；下文简称 _orchestrator_
- **Podman 套接字**：虽然 Podman
  客户端可以在没有守护进程的情况下使用，但仍然可以通过套接字启用管理，这是编排器以仿佛在主机系统上运行的方式工作所必需的
- **guest 容器**：由 dsh-podman 编排器创建的容器，与 dsh 工作区相关联
- **dsh 工作区**：在 dsh 中，项目使用 _workspace_ 这一名称，并有自己的专用目录

## 要求

- 一个用于运行 dsh 的用户（不能是 root）
- 基于 systemd 的 Linux 发行版
- Podman 5 或更高版本；推荐使用 Podman 6
- 以你的 dsh 用户身份存在的 systemd 会话（**`sudo -iu` 无法工作**）：
  - 通过 machinectl（推荐；在某些发行版上，此命令属于 `systemd-container`
    包；需要以 root 身份或作为 _wheel_ 组的成员运行）：
    ```bash
    machinectl shell --uid=your-username
    ```
  - 通过 SSH 连接
  - 通过 tty 连接

## 建议

- 如果你想在开机时启动 dsh，请以 root 身份
  [为你的用户启用 _user lingering_（常驻）](https://www.freedesktop.org/software/systemd/man/loginctl.html#enable-linger%20USER%E2%80%A6)：
  ```bash
  loginctl enable-linger your-username
  ```
- 确保 Podman 在你的 dsh 用户下能正常工作（⚠️ 第一条命令可能会停止现有容器！）：
  ```bash
  podman system migrate
  podman run --rm quay.io/podman/hello
  podman rmi quay.io/podman/hello
  ```

## 准备工作

- 你需要选择一个项目目录。该目录在 dsh
  中以只读方式挂载（对于内置的项目管理器是必需的），在 guest
  容器中以读写方式挂载。在本指南中，我们将使用
  `${HOME}/project`（`%h/project`），但你可以自由选择其他路径，只要你的用户对该路径具有读写访问权限即可。
- 在所选目录中创建一个项目。这将有助于在 dsh 中创建工作区以验证安装是否成功。

## 安装

本次安装使用
[Podman Quadlet](https://docs.podman.io/en/latest/markdown/podman-systemd.unit.5.html)，
它为 systemd 增加了 Podman 集成。

注意，dsh-podman 插件会在 dsh 容器启动时安装，这需要联网。

1. 为你的用户创建 Quadlet 目录：
   ```bash
   mkdir -p ~/.config/containers/systemd
   ```
2. 将文件 [dsh.container](../quadlet/dsh.container) 和
   [dsh-podman-orchestrator.container](../quadlet/dsh-podman-orchestrator.container)
   复制到 `~/.config/containers/systemd/`。
   - 如果你希望更改项目目录，可相应调整这些文件。
3. 重新加载 systemd 会话配置：
   ```bash
   systemctl --user daemon-reload
   ```
4. 检查配置中是否有错误：
   ```bash
   journalctl --user -e
   ```
5. 启动 dsh 和 dsh-podman-orchestrator：
   ```bash
   systemctl --user start dsh dsh-podman-orchestrator
   ```
6. 检查任一容器是否有启动错误：
   ```bash
   journalctl --user -eu dsh
   ```
   ```bash
   journalctl --user -eu dsh-podman-orchestrator
   ```
7. 查看 dsh 容器日志：
   ```bash
   podman logs dsh
   ```
8. 访问形如 `http://127.0.0.1:3080/?token=xxx` 的给定 URL 以使用 dsh。
9. 浏览器保存该令牌后，即可通过 [http://127.0.0.1:3080/](http://127.0.0.1:3080/)
   访问 dsh。

## 验证

- 打开侧边栏的 **插件** 面板并选择 **dsh-podman**：页面应列出基础镜像，并针对工作区提供创建其默认容器的选项。
- 在 dsh 会话中运行一条 shell 命令。它应在当前工作区的 Podman
  容器内执行（插件会在首次使用时自动创建工作区的默认容器）。

## 启用每日自动更新（可选）

这需要为你的用户启用 lingering。

```bash
systemctl --user enable --now podman-auto-update.timer
```
