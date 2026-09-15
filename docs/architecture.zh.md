<!--
SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>

SPDX-License-Identifier: MIT
-->

# 架构

dsh-podman 由三个组件组成：

| 组件                      | 运行位置                     | 功能                                                                   |
| ------------------------- | ---------------------------- | ---------------------------------------------------------------------- |
| `@exagone313/dsh-podman`  | dsh 内部                     | 注册由 orchestrator 提供支撑的 `ctx.subprocess` 和 `ctx.fs`            |
| `dsh-podman-guest-agent`  | 每个 guest 容器内部          | 为一个工作区提供 exec/filesystem gRPC API                              |
| `dsh-podman-orchestrator` | 一个可访问 Podman API 的容器 | 持有 control socket 和持久化状态；创建/删除 guest 容器；构建工作区镜像 |

该插件会自动使用其配置的默认镜像和单个读写项目挂载来创建缺失的工作区；`container_mount_update`
可将该挂载重新挂载为只读。它绝不会回退到主机执行。

## 控制平面

插件通过位于 `<socketsRoot>/orchestrator.sock` 的 Unix socket 连接
orchestrator（编排器）并通信 gRPC。请求携带共享
token（`DSH_PODMAN_ORCHESTRATOR_TOKEN`）作为 `authorization: bearer` 标头。

orchestrator 服务公开以下 gRPC 方法（同时支撑 UI
和工具）：`ListContainers`（仅返回 orchestrator 创建的 guest
容器——它不拥有的容器永远不会被暴露）、`StartContainer{workspace_slug, container, image_id, mounts, env, secret_env, paths}`（在工作区的
pod 中创建或替换容器；空的 `container`
指向默认容器，其他名称会被校验）、`RecreateContainer{workspace_slug, container, image_id, mounts, env, paths}`（停止、删除并重新创建容器，可选择使用新镜像、项目挂载、环境或
PATH 附加项；空的 `image_id`
保留工作区当前的镜像）、`RemoveContainer`、`AddContainerMount`、`RemoveContainerMount`、`SetContainerPaths`、`AddContainerSecret`
和 `RemoveContainerSecret`。

## 工作区与 pod

每个工作区映射到一个 **podman pod**（`dsh-podman-<slug>`，其中 `<slug>` 是工作区
UUID），因此其容器共享一个网络命名空间。每个工作区都有一个
**默认容器**（`dsh-podman-<slug>-default`）；可以在同一个 pod
内创建额外的、命名的容器（`dsh-podman-<slug>-<name>`）。容器的根文件系统以只读方式挂载，`/tmp`、`/var/tmp`
和 `/run` 上是 podman 的可写 tmpfs（`/dev` 和 `/dev/shm`
保持可写）。所有其他可写状态都存在于项目绑定挂载、命名卷或 tmpfs 挂载中。guest
文件 API 可以访问 `/tmp`，而 guest agent 会把超出上限的命令输出写入
`/tmp/dsh-podman` 下的溢出文件。

工作区的 Pod 会在其最后一个容器被移除时拆除，也可直接通过
`RemoveWorkspace`（设置卡片中的 **移除 Pod**
操作）拆除：它会停止各容器的守护进程、移除 Pod 及其容器、清理它们的 socket
目录，并删除存储的工作区记录。卷、机密和项目数据保持不变。

除了项目挂载之外，容器还可以在任意容器路径挂载命名卷（以
`DSH_PODMAN_VOLUME_PREFIX` 为前缀，默认 `dsh-podman-`，由 podman
在首次使用时自动创建）、机密或 tmpfs——除非它们会与保留路径重叠：

- `DSH_PODMAN_PROJECTS_ROOT`，保留给项目挂载；
- `DSH_PODMAN_SOCKETS_ROOT`，承载 guest agent 的 socket；
- `DSH_PODMAN_GUEST_AGENT_IMAGE_MOUNT`，容器从其运行入口点；
- `/tmp`，podman 在其中挂载 guest 文件 API 可访问的可写
  tmpfs，命令输出也溢出写入其中。

包含保留路径的目标会被拒绝，位于其内部的目标同样会被拒绝，因为它会隐藏其下的所有内容。

项目挂载会解析符号链接并被限制在 projects root
内，因此可写项目中的符号链接不能将绑定挂载重定向到其外部的路径。带有绝对目标的符号链接永远不会被跟随；请直接命名另一个项目。

## Guest agent 与守护进程

orchestrator 通过容器的套接字目录在每个容器内启动 guest agent（来宾代理）。guest
agent 为该工作区提供 exec/filesystem gRPC
API，运行并监督后台**守护进程**，并读取和写入文件。每个 guest
容器恰好获得一个绑定挂载到其中的套接字目录，因此 guest 永远不会看到 orchestrator
的 control socket，也不会看到任何其他工作区的套接字目录。

命令和守护进程继承 guest agent 的环境，减去保留的 `DSH_PODMAN` 命名空间：agent
自身的 token 保留在 agent 中，而不会被复制到它所启动的每个东西中。以
`inheritEnv=false` 启动的守护进程则只接收 `PATH`/`HOME` 基线以及自身的 `env`。

每个容器还携带有序的 **PATH 附加项**。orchestrator
会持久化它们（`SetContainerPaths`），并在每次创建或重建时以
`DSH_PODMAN_GUEST_PATHS` 交给 guest agent；agent 将它们保存在内存中（通过其 gRPC
API 的 `SetPaths`/`GetPaths`），并添加到它启动的每个进程的 PATH 之前，包括插件的
`ctx.subprocess` 提供者，因此内置的 shell
和文件系统工具也能看到它们。更改列表不会重建容器，因此先前启动的守护进程仍使用旧的
PATH。

在 `read-only` 权限下，harness 沙箱无法约束命令（插件替换了
`ctx.subprocess`/`ctx.fs` 并解开了 `landlock-run`
包装），因此由插件自行执行该模式：只有当所有带模式的挂载都是 `read_only`
时，shell 或文件工具才能运行。否则插件会以保留的工具名
`dsh_podman_builtin_remount_read_only` 通过审批服务询问——浏览器端会用其自己的
**重新挂载并运行**
按钮渲染该提示——并在获准后以强制只读的挂载重建容器，再运行该工具。出于同样的原因，harness
的 `sandbox_permissions` 升权会被直接授予而不询问：它请求的放宽在此处没有效果。

重新创建容器或关闭 orchestrator 时，会先要求容器的 guest agent
优雅地停止其守护进程（SIGTERM，约 10 秒宽限期），然后 podman 才会拆除该容器。

## 镜像

orchestrator 通过 Podman 构建工作区镜像（有关原始/基础/自定义分层，请参阅
[使用](usage.zh.md#镜像模型)）。基础镜像在其原始引用的基础上在本地构建（或在
`DSH_PODMAN_BASE_IMAGE_PREFIX` 指向注册表时拉取），不包含任何 guest-agent
二进制。guest agent 在创建容器时通过将其自身镜像只读挂载到容器中来提供（请参阅
[配置](configuration.zh.md)）。自定义镜像在父镜像之上分层并添加额外的软件包。
每次构建都会以包含所生成 Containerfile 的 tar 形式将构建上下文流式传输给 Podman
API，因此构建不会向 orchestrator 的状态目录写入任何内容。

`image_rebuild_all` 首先确保每个基础镜像（根据 `DSH_PODMAN_BASE_IMAGE_PREFIX`
在本地构建或从公共注册表拉取），然后**按依赖顺序**重建存储的自定义镜像——每个父镜像都在从它派生的镜像之前。重建失败的镜像以及依赖它的每个镜像都会被报告在
`skipped` 中，其余镜像继续。

配置了主机缓存时（`DSH_PODMAN_HOST_*_CACHE`，同时挂载到构建容器和 orchestrator
中），构建会复用已下载的软件包。设置卡片会报告每个缓存的大小并可清理它——保留每个软件包的最新版本，或清空缓存。构建器用读写锁将清理与构建串行化，因此清理绝不会在构建进行时删除其正在使用的软件包。

## 设置卡片传输

设置卡片和 orchestrator 通过设置传输通信：

- 主机半部分注册 `podman`
  设置命名空间并保持其中的实时视图（`containers`、`images`、`volumes`、`secrets`、`notice`）。
- 卡片将其当前语言记录为
  `uiLocale`，以便主机以会话语言呈现审批文本（参见[审批](usage.zh.md#审批)）。
- 卡片将操作写入 `command`（`refresh` / `remove` / `recreate` / `create` /
  `image_rebuild` / `image_rebuild_all` / volume / secret / secret-env / mount
  操作）；主机的 `watch` 处理程序针对 orchestrator
  执行该操作，并将刷新后的视图推回。
