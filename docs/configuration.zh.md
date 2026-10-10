<!--
SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>

SPDX-License-Identifier: MIT
-->

# 配置

环境变量使用 `DSH_PODMAN_`
前缀，并按读取它们的组件分组列出（被多个组件读取的变量会出现在每个组件的对应章节中）。插件还在
侧边栏 **插件** 面板 → **已安装** 中的 **dsh-podman** 页面中暴露了一些 **UI
设置**，与环境变量分开列出。

插件按以下顺序读取其配置：先是 cordis 中的插件
`config`，然后是下方列出的环境变量，最后是内置默认值。

## 插件（dsh 客户端）— 环境变量

| 变量                            | 默认值            | 说明                                                                      |
| ------------------------------- | ----------------- | ------------------------------------------------------------------------- |
| `DSH_PODMAN_ORCHESTRATOR_TOKEN` | —                 | 用于认证控制平面 gRPC 调用的共享机密；见[变量详解](#变量详解)             |
| `DSH_PODMAN_PROJECTS_ROOT`      | `/projects`       | 用于将会话工作目录解析为工作区的项目根目录                                |
| `DSH_PODMAN_SOCKETS_ROOT`       | `/run/dsh-podman` | 插件据此推导 orchestrator 控制套接字（`orchestrator.sock`）的套接字根目录 |

`projectsRoot` 与 `socketsRoot` 仅来自环境变量，以确保与 orchestrator
一致；`controlToken` 来自插件 `config` 或 `DSH_PODMAN_ORCHESTRATOR_TOKEN`。

## 插件（dsh 客户端）— UI 设置

可在侧边栏 **插件** 面板 → **已安装** 的 **dsh-podman** 页面内编辑（镜像的
Set-default 弹窗和**默认环境变量**区块）：

| 设置           | 默认值      | 说明                                                                                                                 |
| -------------- | ----------- | -------------------------------------------------------------------------------------------------------------------- |
| `defaultImage` | `archlinux` | 用于新工作区的镜像**短名称**；可通过 Set-default 弹窗从基础镜像和自定义镜像中选择                                    |
| `uiLocale`     | `""`        | 插件管理的当前语言，由浏览器客户端写入，以便主机以会话语言呈现审批文本（见[审批](usage.zh.md#审批)）；不可由用户编辑 |
| `containerEnv` | `{}`        | 容器创建时注入的默认环境变量；见[默认环境变量](#默认环境变量)                                                        |

### 默认环境变量

`containerEnv`
是一个在容器创建时注入的环境变量映射：新工作区的默认容器与每个命名容器都会收到它。容器自身的
`env`
按变量逐个优先，而重建容器时会完全采用传入的环境变量，因此在容器的环境变量里删除某一项并重建该容器，即可彻底移除它。

Podman
页面中的**默认环境变量**区块使用与容器相同的键/值行进行编辑：增删变量后点击**保存**（或**放弃**）。**Git
身份**用一份姓名与邮箱填入
`GIT_AUTHOR_NAME`、`GIT_AUTHOR_EMAIL`、`GIT_COMMITTER_NAME` 与
`GIT_COMMITTER_EMAIL`；**应用默认环境变量**会把缺少的变量补给尚未具备它们的运行中容器，只重建这些容器，且绝不覆盖已有值；已停止的容器留待下次启动。每个工作区行也提供同样的操作，只作用于该工作区。保留的
`DSH_PODMAN*` 键会被忽略，且这些值并非机密——机密请使用
`secretEnv`（见[机密](usage.zh.md#机密)）。

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
| `DSH_PODMAN_HOST_SKILL_DIR`                    | —                             | 用户级 skill 的主机绝对路径目录，以只读方式按相同路径挂载进每个 guest 容器；未设置则不挂载；见[变量详解](#变量详解)                                                 |
| `DSH_PODMAN_GATEWAY_TOKEN`                     | —                             | gateway 调用（`orchestrator` → gateway）的可选共享机密；见[变量详解](#变量详解)                                                                                     |
| `DSH_PODMAN_HOST_SOCKETS_ROOT`                 | required                      | 用于 guest 套接字绑定挂载的主机侧套接字根目录；见[变量详解](#变量详解)                                                                                              |
| `DSH_PODMAN_IMAGE_PREFIX`                      | `localhost/dsh-podman/`       | 前置到已构建的工作区镜像引用上的前缀                                                                                                                                |
| `DSH_PODMAN_ORCHESTRATOR_PODMAN_SOCKET`        | required                      | Podman API 套接字，例如 `unix:///run/podman/podman.sock`                                                                                                            |
| `DSH_PODMAN_ORCHESTRATOR_STATE`                | required                      | 持久化状态目录；见[变量详解](#变量详解)                                                                                                                             |
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

## Gateway（`dsh-podman-gateway`）

| 变量                              | 默认值                        | 说明                                                    |
| --------------------------------- | ----------------------------- | ------------------------------------------------------- |
| `DSH_PODMAN_GATEWAY_SOCKET`       | `<套接字根目录>/gateway.sock` | gateway 提供控制 API 的 Unix 套接字                     |
| `DSH_PODMAN_GATEWAY_SOCKETS_ROOT` | `/run/dsh-podman`             | 共享套接字根目录；gateway 在其下访问各容器发布的套接字  |
| `DSH_PODMAN_GATEWAY_TOKEN`        | —                             | 每次控制调用的可选 Bearer 令牌；见[变量详解](#变量详解) |

标准安装会运行 gateway。它是可选的：只有发布 pod
端口时才需要它（见[用法](usage.zh.md#端口发布)）。它只绑定
`127.0.0.1`，因此已发布端口只能从本机访问。

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

如果两个变量都未配置，orchestrator 将拒绝启动。

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

### `DSH_PODMAN_GATEWAY_TOKEN`

gateway 与 orchestrator 必须一致的任意共享机密字符串；每次 gateway
控制调用都会以 gRPC 元数据标头 `authorization: bearer <token>`
携带它。请使用足够长的随机值——例如
`openssl rand -hex
32`——并在两端设置相同的值。gateway
未设置令牌时会接受未经认证的控制调用（改由套接字文件权限保护）并记录一条警告；设置了令牌后，缺少匹配标头的调用会被拒绝并返回
`Unauthenticated`。dsh 插件不访问 gateway，因此不需要该变量。

### `DSH_PODMAN_ORCHESTRATOR_STATE`

orchestrator
持久化其状态（工作区、容器和镜像记录）的目录。该变量为必填，且必须是绑定挂载到
orchestrator
的目录的绝对路径，以便状态在容器重启后仍然保留——只有部署方知道该路径。随附的
Quadlet 会挂载 `%h/.dsh/dsh-podman/state`。orchestrator
会在需要时创建该目录，缺少该变量时拒绝启动。

### `DSH_PODMAN_SOCKETS_ROOT` and `DSH_PODMAN_HOST_SOCKETS_ROOT`

`DSH_PODMAN_SOCKETS_ROOT` 是 orchestrator 与 guest
容器共享的套接字根目录。它包含 orchestrator
控制套接字（`orchestrator.sock`）和每个工作区的一个子目录，每个 guest agent
在其中创建自己的 `guest.sock`。它保留 `/run/dsh-podman` 默认值。

`DSH_PODMAN_HOST_SOCKETS_ROOT`
为必填：它是同一目录在主机上的路径，无法从容器路径推导——随附的 Quadlet 将
`%t/dsh-podman` 挂载到 `/run/dsh-podman`。缺少该变量时 orchestrator 拒绝启动。

该目录需要绑定挂载到 orchestrator 容器中。其权限模式必须是
`0700`：当套接字根目录对组或其他用户可访问时，orchestrator
拒绝启动，因为控制平面是通往 Podman API
的全权限接口，且只有在其上层目录保持私有时，套接字自身的权限模式才有作用。

每个 guest 容器恰好绑定挂载一个套接字目录：主机目录
`<DSH_PODMAN_HOST_SOCKETS_ROOT>/<container>` 被挂载到容器内的
`<DSH_PODMAN_SOCKETS_ROOT>/<container>`。由于只挂载了这一个按工作区划分的目录，guest
容器永远看不到 orchestrator 的
`orchestrator.sock`，也看不到任何其他工作区的套接字目录。控制套接字和每个 guest
套接字都以权限模式 `0600` 创建，两个进程都会在 `0077` umask
下创建它们，这样套接字在 `bind` 和 `chmod` 之间永远不会被短暂访问。随后 guest
agent 会恢复常规的 `0022` umask，因此它运行的命令创建的文件为 `0644`、目录为
`0755`。

### `DSH_PODMAN_HOST_SKILL_DIR`

用户级 skill 所在目录（随附的 Quadlet 中为
`~/.agents/skills`），以只读方式按相同路径挂载进 每个 guest 容器，使 skill
的脚本能在 agent 工作的地方运行。不设置则不挂载。

该值必须是绝对且已规范化的路径，且不得与保留的容器路径重叠（`DSH_PODMAN_PROJECTS_ROOT`、
`DSH_PODMAN_SOCKETS_ROOT`、`DSH_PODMAN_GUEST_AGENT_IMAGE_MOUNT`、溢出目录、`/tmp`、
`/var/tmp`、`/`）；否则 orchestrator 会拒绝启动。

它绝不能指向 DSH 根目录（`~/.dsh`）内的路径。该目录树以读写方式挂载进 dsh
容器，而 podman
会跟随绑定挂载源上的符号链接，因此插件可以把该目录替换为链接，让其目标被挂载进
guest。正因如此，`~/.dsh/skills` 会被 dsh 读取，但绝不会挂载进任何容器。
