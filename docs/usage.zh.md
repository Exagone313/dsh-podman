<!--
SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>

SPDX-License-Identifier: MIT
-->

# 使用

本页面记录了面向模型的工具、设置卡片以及镜像模型。参见[架构](architecture.zh.md)了解各部分如何组合在一起。

## 模型上下文

Harness 会添加一个提示词区段，指明其自身的磁盘检出目录，以便模型检查或扩展 DSH
本身。该检出目录位于宿主机上，无法从工作区容器访问，因此 dsh-podman
会从组装后的系统提示词中移除该区段；模型不会被告知一个具有误导性的路径。

## 镜像模型

dsh-podman 将容器运行的镜像组织为三个层级：

- **原始镜像**是从互联网拉取的公共上游镜像，例如
  `docker.io/library/ubuntu:latest`。基础镜像仓库固定了它们的完整引用；它们仅用作构建基础镜像时的
  `FROM`，从不被直接引用。
- **基础镜像**是 dsh-podman
  提供的固定内置集合：`archlinux`（pacman）、`ubuntu`（apt）和
  `alpine`（apk）。每个基础镜像由其原始镜像、dsh-podman
  拥有的默认软件包列表及其软件包管理器定义。默认情况下它们从原始镜像**本地构建**（安装默认软件包）；当
  `DSH_PODMAN_BASE_IMAGE_PREFIX` 指向某个镜像仓库（任何不以 `localhost/`
  开头的名称）时，它们改为被**拉取**。即使尚未构建/拉取，基础镜像也会列在设置 UI
  中，可从卡片重建或拉取，并且它们的短名称是保留的——它们不能被覆盖构建、重建或作为自定义镜像移除。
- **自定义镜像**是从**父镜像**——基础镜像或另一个自定义镜像——创建的用户构建镜像，继承其软件包管理器并在此基础上添加额外软件包。它们通过短名称引用（例如
  `valkey`）。

镜像引用（`imageId`、`parent`、`image`）**只能是短名称**（没有镜像仓库前缀，没有
`:tag`）。

## 工具

插件注册了以下面向模型的工具。标记 `✱`
的工具需要审批（有些仅在特定参数下需要——已在其所在行注明）。容器工具作用于当前工作区的**逻辑容器名称**（`"default"`
选择工作区的默认容器）。

### 审批

审批由插件自身通过 `tools/pre-execute`
策略执行，该策略读取会话的权限旋钮（沙箱模式 + 审批策略，从会话日志折叠而来）：

- **Read Only** — 只有 get/list
  类工具可以运行（`image_list`、`image_get`、`container_list`、`container_read`、`container_glob`、`container_grep`、`container_mount_list`、`volume_list`、`secret_list`、`daemon_list`、`daemon_logs`）；其他所有插件工具都被拒绝。DSH
  原生工具保持各自的沙箱行为。
- **Workspace Write** — 带 `✱` 的工具通过 DSH
  的审批服务询问（调用会显示标准审批提示，当没有可用的审批通道时被拒绝）；`container_start`
  仅在传入 `mounts` 时询问。
- **Full access** — 工具运行时不显示审批提示。

审批提示的原因会内联总结调用的关键参数（image
id/base/packages、container/image，以及每个挂载及其种类、目标和 `(ro)`
只读标记）。设置卡片操作是直接的控制调用，不进行门控。

`container_start`、`container_recreate` 和 `container_bash` 接受应用于容器（或
bash 进程）的 `env` 映射；`container_exec` 和 `daemon_start` 已经接受 `env`，而
`daemon_restart` 复用守护进程存储的环境。`container_start` 和
`container_recreate` 还接受 `secretEnv` 映射（环境变量名 →
机密短名称），将现有机密附加到容器的环境——参见[机密](#机密)。环境变量不被视为机密，因此审批原因和
`container_list` 显示变量的**键**。以 `DSH_PODMAN`
开头的键被保留并被拒绝，因为编排器将该命名空间用于 guest-agent 接线。

### 镜像

| 工具                  | 参数                            | 描述                                                                                 |
| --------------------- | ------------------------------- | ------------------------------------------------------------------------------------ |
| `image_build` ✱       | `imageId`, `parent`, `packages` | 从基础或自定义父镜像及软件包列表构建新的自定义镜像                                   |
| `image_get`           | `imageId`                       | 单个镜像的详细信息                                                                   |
| `image_list`          | —                               | 列出已构建的工作区镜像，基础镜像在前                                                 |
| `image_rebuild_all` ✱ | —                               | 确保每个基础镜像，然后按依赖顺序重建每个自定义镜像，跳过重建失败的任何镜像及其依赖项 |
| `image_rebuild` ✱     | `imageId`                       | 原地重建现有的自定义镜像                                                             |
| `image_remove` ✱      | `imageId`                       | 移除已构建的镜像；当工作区或容器仍引用它时拒绝                                       |

### 容器

| 工具                   | 参数                                                                          | 描述                                                                  |
| ---------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `container_bash`       | `container`, `command`, `description`, optional `workdir`, `timeoutMs`, `env` | 运行 shell 命令                                                       |
| `container_edit`       | `container`, `file_path`, `old_string`, `new_string`, optional `replace_all`  | 编辑文件                                                              |
| `container_exec`       | `container`, `argv`, `description`, optional `workdir`, `timeoutMs`, `env`    | 运行程序                                                              |
| `container_glob`       | `container`, `pattern`, optional `path`                                       | 列出匹配模式的文件                                                    |
| `container_grep`       | `container`, `pattern`, optional `path`, `include`                            | 按正则表达式搜索文件                                                  |
| `container_list`       | —                                                                             | 列出当前工作区的容器                                                  |
| `container_read`       | `container`, `file_path`, optional `offset`, `limit`                          | 读取文件                                                              |
| `container_recreate` ✱ | `container`, optional `image`, `mounts`, `env`, `secretEnv`                   | 重建容器，省略 `image` 时保留其当前镜像，可选地使用新的项目挂载或环境 |
| `container_remove` ✱   | `container`                                                                   | 移除容器（先优雅地停止其守护进程）                                    |
| `container_start` ✱    | `container`, optional `image`, `mounts`, `env`, `secretEnv`                   | 启动容器（省略 `image` 时使用默认镜像）；仅在传入 `mounts` 时需要审批 |
| `container_write`      | `container`, `file_path`, `content`, optional `create`, `truncate`            | 写入文件                                                              |

`container_bash`、`container_exec`、`container_read`、`container_write`、
`container_edit`、`container_glob` 和 `container_grep` 的参数与 harness 内置的
`bash`/`read`/`write`/`edit`/`glob`/`grep` 工具保持一致（外加 `container`
目标），因此同一套参数可直接用于指定的容器。插件还为它的每个工具注册了专用的 UI
行（图标、标题、摘要和结果正文），因此它们会像内置工具一样渲染，而不是显示为
通用的 `Tool call` 行。

路径和工作目录可以是绝对路径或相对路径。相对路径会相对于会话的工作目录解析，项目也正是挂载在容器中的该目录下。`container_read`、`container_write`
和 `container_edit` 的 `file_path` 不能包含 `..`
片段；工作目录可以包含，因为命令不受限于 projects 根目录。

未指定工作目录时，`container_bash`、`container_exec` 和 `daemon_start`
会在会话的工作目录中运行（与 harness 的 `bash`
工具一致），`container_glob`/`container_grep`
默认也在其中搜索。该目录必须已挂载到容器中——否则将使用 guest agent
自身的工作目录。显式的 `workdir`（或 `path`）始终优先。

文件工具（`container_read`、`container_write`、`container_edit`）可以访问
工作区的挂载：projects 根目录下的项目目录，以及任何 `volume` 和 `tmpfs`
挂载在其绝对目标路径上的内容。`secret` 挂载不会通过文件 API
暴露——机密值只能由容器内运行的进程读取。

### 挂载与卷

| 工具                       | 参数                                                                                       | 描述                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `container_mount_add` ✱    | `container`, optional `kind`, `project`, `path`, `destination`, `mode`, `volume`, `secret` | 添加挂载；`kind` 为 `project`（默认）、`tmpfs`、`volume` 或 `secret` |
| `container_mount_list`     | `container`                                                                                | 列出容器的挂载                                                       |
| `container_mount_remove` ✱ | `container`, optional `kind`, `project`, `path`, `volume`, `destination`, `secret`         | 移除挂载                                                             |
| `volume_create`            | `name`                                                                                     | 创建受管理的命名卷                                                   |
| `volume_list`              | —                                                                                          | 列出受管理的命名卷（短名称）                                         |
| `volume_remove` ✱          | `name`                                                                                     | 移除受管理的命名卷；当容器仍在挂载它时拒绝                           |

`project` 挂载将项目工作区中的一个目录绑定到容器；`tmpfs`
挂载可写的内存文件系统，`volume` 挂载 podman
命名卷（首次使用时自动创建）——两者都位于任意绝对容器路径，绝不位于 projects
根目录或其他保留路径之下。`secret`
挂载将受管理的机密作为只读文件暴露在绝对容器路径（参见[机密](#机密)）。

`project` 挂载不接受 `destination`：项目目录始终挂载在 projects
根目录下与之对应的路径上。`destination` 仅适用于 `tmpfs`、`volume` 和 `secret`
挂载。

`mode` 为 `read_only` 或 `read_write`，默认为
`read_only`，这样添加挂载永远不会授予未被请求的写权限。`tmpfs` 挂载始终为
`read_write`，`secret` 挂载不带 mode。工作区自身的项目挂载以 `read_write`
创建；这保持不变。

**命名容器**只携带创建它时指定的挂载：项目目录不会被自动挂载。**默认容器**
始终保留其工作区项目挂载，并且无法移除。

### 机密

| 工具                        | 参数                                 | 描述                                                                                                          |
| --------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `container_secret_add` ✱    | `container`, `env`, `secret`         | 将机密作为环境变量附加到容器                                                                                  |
| `container_secret_remove` ✱ | `container`, `env`                   | 从容器的环境变量中分离机密环境变量                                                                            |
| `secret_create`             | `name`, optional `length`, `charset` | 创建具有**编排器生成的随机**值的机密（`length` 默认 32；`charset` 为 `alphanumeric` \| `hex` \| `base64url`） |
| `secret_list`               | —                                    | 列出受管理的机密（短名称）                                                                                    |
| `secret_remove` ✱           | `name`                               | 移除受管理的机密；当容器挂载它或将其作为环境变量附加时拒绝                                                    |

机密存储在 podman 的 `DSH_PODMAN_SECRET_PREFIX`（默认 `dsh-podman-`）下；工具和
UI 使用短名称。`secret_create` 的值由服务端用 `crypto/rand`
生成，且**永不暴露**——没有读取工具。机密可以附加到容器上，既可以作为**挂载**（`container_mount_add kind="secret"` +
`secret` + `destination`，只读，位于绝不位于 projects
根目录之下的绝对路径），也可以作为**环境变量**（`container_secret_add`；环境变量名不得以
`DSH_PODMAN`
开头）。设置卡片可以用用户输入的内容**覆盖**机密（只写），但绝不读取它。

### 守护进程

| 工具             | 参数                                                                       | 描述                                                               |
| ---------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `daemon_list`    | `container`                                                                | 列出守护进程（包括其有效 `uid`/`gid`）                             |
| `daemon_logs`    | `container`, `name`, optional `tailBytes`                                  | 查看守护进程 stdout/stderr 的尾部                                  |
| `daemon_restart` | `container`, `name`                                                        | 使用相同的命令、环境、用户重启守护进程                             |
| `daemon_start`   | `container`, `name`, `argv`, optional `cwd`, `env`, `uid`, `gid`, `groups` | 启动后台守护进程；可选的 `uid`/`gid`/`groups` 以其他用户身份运行它 |
| `daemon_stop`    | `container`, `name`, optional `signal`                                     | 停止守护进程                                                       |

守护进程默认以容器用户身份运行。当只设置 `uid` 时，`gid`
默认为相同值；两者都未设置时，守护进程在没有任何 uid/gid
覆盖的情况下运行。`daemon_list` 报告每个守护进程的有效 `uid`/`gid`。
使用已存在的名称启动守护进程时，会先停止该守护进程（如果它仍在运行）并将其替换；
已停止的守护进程仍会列出，以便其日志仍可读取。

## 容器管理 UI

插件附带一个浏览器端，在 dsh **Settings → Plugins**
页面注册一个卡片。该卡片列出编排器创建的 guest
容器和已构建的镜像。没有容器的工作区会得到一个 **Create container**
按钮，打开一个配置模态框——镜像、环境、挂载（project、tmpfs、volume 和
secret）以及机密环境变量——而已有容器的工作区通过同一个模态框提供 **Add
container**
按钮，用于添加额外的命名容器。容器行显示其环境和机密环境变量及其挂载，允许编辑环境变量和添加/移除挂载（每次移除都会确认），以及将命名机密附加/分离到容器的环境变量；每行还提供
**Remove**、**Recreate**（相同镜像）和 **Recreate with image**。卡片头部有一个
**Reload this view**
按钮。镜像部分可以重建单个镜像或按依赖顺序**重建全部**；**Build image**
打开一个弹窗，包含 image-id/base-image 表单和用于软件包列表的 chip
输入框（输入名称并按空格/逗号，或粘贴列表，以添加可移除的
chips）。卷和机密以独立的可展开行列出，每行都有自己的操作，**Create volume** /
**Create secret**
打开弹窗表单（机密表单接受可选的长度；机密的值可以被覆盖，但绝不读取）。卡片操作是直接的控制调用，不受审批门控。

## Podman 操作员模式

插件附带一个名为 _Podman operator mode_（id `podman-ops`）的 **agent
预设**。每次加载时，它都会将预设（重新）写入 harness
的用户预设根目录（`~/.dsh/.agent-presets/podman-ops/`），覆盖任何本地副本，使发布的内容保持权威。它出现在会话的
agent 预设选择器中，紧挨着内置预设。

该预设将聚焦 Podman 的人格与内置任务工具（`ask_user_question`、`todo_write`）和
`web_search`（web fetch 已禁用）组合在一起。它不挂载主机 shell、主机文件系统或
coding-agent 行（subagents、workflows、skills、goal、plan
mode、jobs）。插件自身的工具是全局的，全部保持可用，分为：

- **直接：**
  `image_list`、`image_get`、`container_list`、`container_read`、`container_glob`、`container_grep`、`container_mount_list`、`volume_list`、`secret_list`、`secret_create`、`daemon_list`、`daemon_logs`、`daemon_stop`、`daemon_restart`、`container_start`（仅在传入
  `mounts` 时询问）。
- **需审批**（通常的 `✱`
  工具）：`image_build`、`image_rebuild`、`image_rebuild_all`、`image_remove`、`container_recreate`、`container_remove`、`container_mount_add`、`container_mount_remove`、`volume_remove`、`secret_remove`、`container_secret_add`、`container_secret_remove`。
- **仅在此预设中需审批：**
  `container_bash`、`container_exec`、`container_write`、`container_edit`、`daemon_start`——因此一旦用户批准，agent
  就可以运行命令、编辑容器文件或启动守护进程，而无需这些工具在其他预设中询问。

上述审批策略中的权限旋钮仍然适用（Read Only 只允许直接的 read/list 工具；Full
access 跳过每个提示）。
