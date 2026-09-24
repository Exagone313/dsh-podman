<!--
SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>

SPDX-License-Identifier: MIT
-->

# 配置

环境变量使用 `DSH_PODMAN_`
前缀，并按读取它们的组件分组列出（被多个组件读取的变量会出现在每个组件的对应章节中）。插件还在
dsh 的 **设置 → 插件** 卡片中暴露了一些 **UI 设置**，与环境变量分开列出。

插件按以下顺序读取其配置：先是 cordis 中的插件
`config`，然后是下方列出的环境变量，最后是内置默认值。

## 插件（dsh 客户端）— 环境变量

| 变量                            | 默认值                  | 说明                                                                      |
| ------------------------------- | ----------------------- | ------------------------------------------------------------------------- |
| `DSH_PODMAN_IMAGE_PREFIX`       | `localhost/dsh-podman/` | 前置到工作区镜像引用上的前缀                                              |
| `DSH_PODMAN_ORCHESTRATOR_TOKEN` | —                       | 用于认证控制平面 gRPC 调用的共享机密；见[变量详解](#变量详解)             |
| `DSH_PODMAN_PROJECTS_ROOT`      | `/projects`             | 用于将会话工作目录解析为工作区的项目根目录                                |
| `DSH_PODMAN_SOCKETS_ROOT`       | `/run/dsh-podman`       | 插件据此推导 orchestrator 控制套接字（`orchestrator.sock`）的套接字根目录 |

`projectsRoot` 和 `imagePrefix` 仅来自环境变量，以确保与 orchestrator
一致；`controlToken` 来自插件 `config` 或 `DSH_PODMAN_ORCHESTRATOR_TOKEN`。

## 插件（dsh 客户端）— UI 设置

可在卡片中的 **设置 → 插件 → Podman** 面板内编辑（配置部分和镜像的 Set-default
弹窗）：

| 设置           | 默认值                    | 说明                                                                              |
| -------------- | ------------------------- | --------------------------------------------------------------------------------- |
| `defaultImage` | `archlinux`               | 用于新工作区的镜像**短名称**；可通过 Set-default 弹窗从基础镜像和自定义镜像中选择 |
| `socketsRoot`  | `DSH_PODMAN_SOCKETS_ROOT` | 插件用于连接 orchestrator 的套接字根目录；回退到环境变量                          |

## Orchestrator（`dsh-podman-orchestrator`）

| 变量                                           | 默认值                        | 说明                                                                                                                                                                |
| ---------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DSH_PODMAN_BASE_IMAGE_PREFIX`                 | `localhost/dsh-podman/base/`  | 基础镜像的标签前缀；以 `localhost/` 开头的前缀会在本地构建它们，否则从公共镜像仓库拉取                                                                              |
| `DSH_PODMAN_GUEST_AGENT_IMAGE`                 | —                             | 以只读方式挂载到每个 guest 容器中的 guest-agent 镜像；未设置时禁用该功能；见[变量详解](#变量详解)                                                                   |
| `DSH_PODMAN_GUEST_AGENT_IMAGE_AGENT_BIN`       | `/bin/dsh-podman-guest-agent` | guest-agent 镜像中 guest agent 二进制的路径；容器命令为 `<mount>/<agent_bin>`；见[变量详解](#变量详解)                                                              |
| `DSH_PODMAN_GUEST_AGENT_IMAGE_MOUNT`           | `/opt/dsh-podman/guest-agent` | guest-agent 镜像以只读方式挂载到的容器内部目录；见[变量详解](#变量详解)                                                                                             |
| `DSH_PODMAN_GUEST_AGENT_IMAGE_USE_VERSION_TAG` | `false`                       | 为真值时，guest-agent 镜像引用使用 orchestrator 的 git 版本作为其标签（替换 `DSH_PODMAN_GUEST_AGENT_IMAGE` 中的标签，或在缺失时添加一个）；摘要引用会在启动时 panic |
| `DSH_PODMAN_HOST_APK_CACHE`                    | —                             | 挂载在 `/etc/apk/cache` 的主机绝对路径目录，用于在 apk 构建之间持久化已下载的软件包；未设置时禁用缓存                                                               |
| `DSH_PODMAN_HOST_APT_CACHE`                    | —                             | 挂载在 `/var/cache/apt/archives` 的主机绝对路径目录，用于在 apt 构建之间持久化已下载的软件包；未设置时禁用缓存                                                      |
| `DSH_PODMAN_HOST_GUEST_AGENT_BIN`              | —                             | 主机侧的 guest agent 二进制路径；设置后会绑定挂载；见[变量详解](#变量详解)                                                                                          |
| `DSH_PODMAN_HOST_PACMAN_CACHE`                 | —                             | 挂载在 `/var/cache/pacman/pkg` 的主机绝对路径目录，用于在 pacman 构建之间持久化已下载的软件包；未设置时禁用缓存                                                     |
| `DSH_PODMAN_HOST_PROJECTS_ROOT`                | `DSH_PODMAN_PROJECTS_ROOT`    | 用作绑定挂载源的主机侧项目根目录                                                                                                                                    |
| `DSH_PODMAN_HOST_SOCKETS_ROOT`                 | `DSH_PODMAN_SOCKETS_ROOT`     | 用于 guest 套接字绑定挂载的主机侧套接字根目录                                                                                                                       |
| `DSH_PODMAN_IMAGE_PREFIX`                      | `localhost/dsh-podman/`       | 前置到已构建的工作区镜像引用上的前缀                                                                                                                                |
| `DSH_PODMAN_ORCHESTRATOR_PODMAN_SOCKET`        | required                      | Podman API 套接字，例如 `unix:///run/podman/podman.sock`                                                                                                            |
| `DSH_PODMAN_ORCHESTRATOR_STATE`                | `/var/lib/dsh-orchestrator`   | 持久化状态目录（二进制默认值；随附的 Quadlet 会将其覆盖为 `%h/.dsh/dsh-podman/state`）                                                                              |
| `DSH_PODMAN_ORCHESTRATOR_TOKEN`                | —                             | 用于认证控制平面 gRPC 调用的共享机密；见[变量详解](#变量详解)                                                                                                       |
| `DSH_PODMAN_PROJECTS_ROOT`                     | `/projects`                   | 每个 guest 容器内的项目根目录                                                                                                                                       |
| `DSH_PODMAN_SECRET_PREFIX`                     | `dsh-podman-`                 | 应用于受管 podman 机密的前缀（见[使用](usage.zh.md#机密)）                                                                                                          |
| `DSH_PODMAN_SOCKETS_ROOT`                      | `/run/dsh-podman`             | 套接字根目录（从主机绑定挂载）；包含 `orchestrator.sock` 和每个工作区的 guest 套接字；见[变量详解](#变量详解)                                                       |
| `DSH_PODMAN_VOLUME_PREFIX`                     | `dsh-podman-`                 | 应用于受管命名卷的前缀（见[使用](usage.zh.md#挂载与卷)）                                                                                                            |

## Guest agent（`dsh-podman-guest-agent`）

| 变量                       | 默认值      | 说明                                                                |
| -------------------------- | ----------- | ------------------------------------------------------------------- |
| `DSH_PODMAN_GUEST_SOCKET`  | required    | guest agent 提供服务的 Unix 套接字；orchestrator 在启动容器时设置它 |
| `DSH_PODMAN_GUEST_TOKEN`   | —           | 每次 gRPC 调用所需的 Bearer 令牌；见[变量详解](#变量详解)           |
| `DSH_PODMAN_PROJECTS_ROOT` | `/projects` | 工作区的项目被挂载到的根目录                                        |

## 变量详解

### `DSH_PODMAN_BASE_IMAGE_PREFIX`

基础镜像的标签前缀，格式为 `BASE_IMAGE_PREFIX + <short> + ":latest"`。当前缀以
`localhost/` 开头时，orchestrator
会从其上游原始引用**本地构建**基础镜像；任何其他前缀则将其标记为**公共**镜像，此时
orchestrator
会从该镜像仓库**拉取**带标签的基础镜像，而不是构建它们。内置基础镜像为
`archlinux`（pacman）、`ubuntu`（apt）和
`alpine`（apk）；它们的短名称是保留的，不能作为自定义镜像覆盖、重建或删除。

### `DSH_PODMAN_GUEST_AGENT_IMAGE` and `DSH_PODMAN_HOST_GUEST_AGENT_BIN`

当设置了 `DSH_PODMAN_GUEST_AGENT_IMAGE` 时，orchestrator
会将该镜像以只读方式挂载到每个 guest 容器的
`DSH_PODMAN_GUEST_AGENT_IMAGE_MOUNT`（默认 `/opt/dsh-podman/guest-agent`），并从
`<mount>/<agent_bin>` 运行 guest agent
二进制——该路径就是容器命令（二进制路径和挂载位置见下一节）。

`DSH_PODMAN_HOST_GUEST_AGENT_BIN` 是 guest agent
二进制在_主机上_的路径。设置它会将该二进制以只读方式绑定挂载到容器内相同路径，而不是挂载
guest-agent 镜像；这是一个可选的开发回退方案，优先于镜像挂载。默认情况下未设置。

如果两个变量都未配置，guest 容器将没有可运行的 guest
agent，创建工作区容器将会失败。

### `DSH_PODMAN_GUEST_AGENT_IMAGE`, `DSH_PODMAN_GUEST_AGENT_IMAGE_AGENT_BIN`, `DSH_PODMAN_GUEST_AGENT_IMAGE_MOUNT` and `DSH_PODMAN_GUEST_AGENT_IMAGE_USE_VERSION_TAG`

guest-agent 镜像在容器创建时提供 agent：orchestrator 使用 podman
的镜像挂载机制，将其**只读**挂载到每个 guest 容器的
`DSH_PODMAN_GUEST_AGENT_IMAGE_MOUNT`（默认
`/opt/dsh-podman/guest-agent`），容器命令为 `<mount>/<agent_bin>`。Podman
镜像卷始终以只读方式挂载。

该挂载是**隐藏的**——由 orchestrator 自行注入，因此不会列在用户挂载中。由于 agent
是在运行时提供的，guest-agent 版本变化时不再需要重建基础镜像。

`DSH_PODMAN_GUEST_AGENT_IMAGE_AGENT_BIN` 是 guest-agent 镜像内二进制的路径（默认
`/bin/dsh-podman-guest-agent`）。

当 `DSH_PODMAN_GUEST_AGENT_IMAGE_USE_VERSION_TAG` 设置为真值时，orchestrator
使用自己的 git 版本作为镜像标签，而不是 `DSH_PODMAN_GUEST_AGENT_IMAGE`
中的标签（该标签可以完全省略）。由于摘要引用无法被覆盖，当该变量与摘要式的
`DSH_PODMAN_GUEST_AGENT_IMAGE` 一起设置时，orchestrator 将无法启动。

如果容器的 agent 来自与当前配置不同的 guest-agent
镜像，该容器会在下次被使用时被重新创建，因此升级 orchestrator
后无需手动重建容器即可生效。只有在镜像不存在时才会拉取，因此本地构建的开发镜像绝不会被拉取覆盖。

### `DSH_PODMAN_GUEST_TOKEN`

每次 guest-agent gRPC 调用所需的共享机密，以 gRPC 元数据头
`authorization: bearer <token>` 传递。实际上，orchestrator
会为每个工作区生成一个新的随机令牌，并通过 `DSH_PODMAN_GUEST_TOKEN` 注入到 guest
容器中，同时将相同的值连同 guest 套接字路径一起交给插件——因此通常无需手动配置。

### `DSH_PODMAN_ORCHESTRATOR_TOKEN`

orchestrator 和插件必须约定的任意共享机密字符串；每个控制平面请求都以 gRPC
元数据头 `authorization: bearer <token>` 携带它。请使用一个长且随机的值——例如
`openssl rand -hex 32`——并在两端设置相同的值。当 orchestrator
未设置令牌时，它接受未经认证的控制平面调用（转而依赖套接字的文件权限）；当设置了令牌时，不带匹配头的请求会被以
`Unauthenticated` 拒绝。

### `DSH_PODMAN_SOCKETS_ROOT` and `DSH_PODMAN_HOST_SOCKETS_ROOT`

`DSH_PODMAN_SOCKETS_ROOT` 是 orchestrator 与 guest
容器共享的套接字根目录。它包含 orchestrator
控制套接字（`orchestrator.sock`）和每个工作区的一个子目录，每个 guest agent
在其中创建自己的 `guest.sock`。

该目录需要绑定挂载到 orchestrator 容器中。其权限模式必须是
`0700`：当套接字根目录对组或其他用户可访问时，orchestrator
拒绝启动，因为控制平面是通往 Podman API
的全权限接口，且只有在其上层目录保持私有时，套接字自身的权限模式才有作用。

每个 guest 容器恰好绑定挂载一个套接字目录：主机目录
`<DSH_PODMAN_HOST_SOCKETS_ROOT>/<container>` 被挂载到容器内的
`<DSH_PODMAN_SOCKETS_ROOT>/<container>`。由于只挂载了这一个按工作区划分的目录，guest
容器永远看不到 orchestrator 的
`orchestrator.sock`，也看不到任何其他工作区的套接字目录。控制套接字和每个 guest
套接字都以权限模式 `0600` 创建，两个进程都会在启动时设置 `0077`
umask，这样套接字在 `bind` 和 `chmod` 之间永远不会被短暂访问。
