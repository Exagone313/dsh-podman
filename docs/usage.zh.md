<!--
SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>

SPDX-License-Identifier: MIT
-->

# 使用

本页面记录了面向模型的工具、Podman 页面以及镜像模型。参见[架构](architecture.zh.md)了解各部分如何组合在一起。

## 模型上下文

Harness 会添加一个提示词区段，指明其自身的磁盘检出目录，以便模型检查或扩展 DSH
本身。该检出目录位于宿主机上，无法从工作区容器访问，因此 dsh-podman
会从组装后的系统提示词中移除该区段；模型不会被告知一个具有误导性的路径。

dsh-podman 还会添加自己的提示词区段，说明内置的 shell
与文件系统工具（`bash`、`read`、`write`、`edit`、`glob`、`grep`）在工作区的默认容器内运行，而非宿主机，并说明它们与
`container_*` 工具的关系。同一区段还会引导模型：安装软件时用 `image_build`
构建自定义镜像（再用 `container_start` 或 `container_recreate`
启动），需要跨容器重建保留的数据应使用命名卷而非 `tmpfs`。

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
  中，可从 Podman 页面重建或拉取，并且它们的短名称是保留的——它们不能被覆盖构建、重建或作为自定义镜像移除。
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
策略执行，该策略读取会话生效的权限旋钮（沙箱模式 + 审批策略）：

- **Read Only** — 只有 get/list
  类工具可以运行（`image_list`、`image_get`、`container_list`、`container_read`、`container_glob`、`container_grep`、`container_mount_list`、`volume_list`、`secret_list`、`daemon_list`、`daemon_logs`）；其他所有插件工具都被拒绝。当目标容器中所有带模式的挂载（项目与卷；tmpfs
  与机密不带模式）都已是 `read_only` 时，内置的文件与 shell
  工具（`write`、`edit`、`bash`，以及 Windows 上的
  `pwsh`）及其容器对应工具（`container_bash`、`container_exec`、`container_write`、`container_edit`、`daemon_start`）可以运行——本应约束它们的
  harness 沙箱在容器内被绕过。当某个读写挂载会阻止这些工具时，插件会通过 DSH
  的审批服务询问，提示中列出将被重新挂载为 `read_only`
  的挂载与保持不变的挂载，然后以只读挂载列表重建容器再运行该工具；拒绝该提示会拒绝此次调用。`read`、`glob`
  和 `grep` 始终可运行。
- **Workspace Write** — 带 `✱` 的工具通过 DSH
  的审批服务询问（调用会显示标准审批提示，当没有可用的审批通道时被拒绝）；`container_start`
  仅在传入 `mounts` 或 `secretEnv` 时询问。
- **Full access** — 工具运行时不显示审批提示。

harness 的 `sandbox_permissions` 参数（例如 `bash`
上的一次性沙箱放宽）会被接受但在此处没有效果：沙箱在容器内被绕过，因此插件会直接授予该升权而不询问。

审批提示的原因是一句话，说明操作及其涉及的对象，并对每个标识符加引号——例如
`Add mount to container "web": volume "data" (read-only)`。它涵盖容器镜像、每个挂载的类型与目标路径、环境变量的键、机密环境变量名，以及解析后的文件路径。它会跟随界面语言：浏览器客户端将当前语言记录到插件的 `uiLocale` 偏好中，并由主机持久化到插件配置（未设置时为英文）。策略拒绝——只读沙箱，或项目挂载上指定了目标路径——也会使用相同的语言。Podman 页面操作是直接的控制调用，不进行门控。

`container_start`、`container_recreate` 和 `container_bash` 接受应用于容器（或
bash 进程）的 `env` 映射；`container_exec` 和 `daemon_start` 已经接受 `env`，而
`daemon_restart` 复用守护进程存储的环境。`container_start` 和
`container_recreate` 还接受 `secretEnv` 映射（环境变量名 →
机密短名称），将现有机密附加到容器的环境——参见[机密](#机密)。在
`container_start` 和 `container_recreate` 上，省略 `env`（或
`secretEnv`）会保留容器存储的映射，而提供映射会完全替换它。环境变量不被视为机密，因此审批原因和
`container_list` 显示变量的**键**。以 `DSH_PODMAN`
开头的键被保留并被拒绝，因为编排器将该命名空间用于 guest-agent 接线。

新容器还会注入插件的**默认环境变量**（`containerEnv` 设置），因此 Git
身份只需配置一次，而不必按项目重复设置——见[默认环境变量](configuration.zh.md#默认环境变量)。Podman 页面中的
**Git 身份**弹窗用一份姓名与邮箱填入四个 `GIT_AUTHOR_*`/`GIT_COMMITTER_*`
变量，**应用默认环境变量**会把它们补给尚未具备的现有运行中容器。

`container_bash` 和 `container_exec` 使用与内置 `bash`
相同的命令可见环境运行：harness 托管的 `DSH_*`
事实（`DSH_HOME`、`DSH_SHELL`、`DSH_SESSION_ID`、`DSH_WEB_URL`）及其非交互式终端覆盖项（`NO_COLOR`、`TERM=dumb`、`PAGER=cat`、`GIT_PAGER=cat`）。调用方的
`env` 条目会覆盖终端覆盖项，但无法取代托管的 `DSH_*` 事实。

### 镜像

| 工具                  | 参数                            | 描述                                                                                                                                |
| --------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `image_build` ✱       | `imageId`, `parent`, `packages` | 从基础或自定义父镜像及软件包列表构建新的自定义镜像                                                                                  |
| `image_get`           | `imageId`                       | 单个镜像的详细信息                                                                                                                  |
| `image_list`          | —                               | 列出已构建的工作区镜像，基础镜像在前                                                                                                |
| `image_rebuild_all` ✱ | —                               | 确保每个基础镜像，然后按依赖顺序重建每个自定义镜像，跳过重建失败的任何镜像及其依赖项；无法确保的基础镜像以短名称出现在 `skipped` 中 |
| `image_rebuild` ✱     | `imageId`                       | 原地重建现有的自定义镜像                                                                                                            |
| `image_remove` ✱      | `imageId`                       | 移除已构建的镜像；当工作区或容器仍引用它时拒绝                                                                                      |

### 容器

| 工具                   | 参数                                                                                                  | 描述                                                                                 |
| ---------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `container_bash`       | `container`, `command`, `description`, optional `workdir`, `timeoutMs`, `env`, `uid`, `gid`, `groups` | 运行 shell 命令                                                                      |
| `container_edit`       | `container`, `file_path`, `old_string`, `new_string`, optional `replace_all`                          | 编辑文件                                                                             |
| `container_exec`       | `container`, `argv`, `description`, optional `workdir`, `timeoutMs`, `env`, `uid`, `gid`, `groups`    | 运行程序                                                                             |
| `container_glob`       | `container`, `pattern`, optional `path`                                                               | 列出匹配模式的文件                                                                   |
| `container_grep`       | `container`, `pattern`, optional `path`, `include`                                                    | 按正则表达式搜索文件                                                                 |
| `container_list`       | —                                                                                                     | 列出当前工作区的容器                                                                 |
| `container_read`       | `container`, `file_path`, optional `offset`, `limit`                                                  | 读取文件                                                                             |
| `container_recreate` ✱ | `container`, optional `image`, `mounts`, `env`, `secretEnv`, `paths`                                  | 重建容器，省略 `image` 时保留其当前镜像，可选地使用新的项目挂载、环境或 PATH 附加项  |
| `container_remove` ✱   | `container`                                                                                           | 移除容器（先优雅地停止其守护进程）                                                   |
| `container_start` ✱    | `container`, optional `image`, `mounts`, `env`, `secretEnv`, `paths`                                  | 启动容器（省略 `image` 时使用默认镜像）；仅在传入 `mounts` 或 `secretEnv` 时需要审批 |
| `container_write`      | `container`, `file_path`, `content`                                                                   | 写入文件                                                                             |

`container_bash`、`container_exec`、`container_read`、`container_write`、
`container_edit`、`container_glob` 和 `container_grep` 的参数与 harness 内置的
`bash`/`read`/`write`/`edit`/`glob`/`grep` 工具保持一致（外加 `container`
目标），因此同一套参数可直接用于指定的容器。`container_read`、`container_write`
和 `container_edit`
还通过内置文件工具所用的同一文件系统提供者解析目标，因此行为一致：二进制文件会以相同的错误被拒绝，而先读后写保护（拒绝覆盖会话中未读取过的文件）对它们的作用与内置
`write` 和 `edit` 完全相同——`container_read` 会像内置 `read`
一样，为其读取的路径满足该保护。已被读取但随后被删除的路径视为新文件：写入会重新创建它，而不会报告版本过期。插件还为它的每个工具注册了专用的
UI 行（图标、标题、摘要和结果正文），因此它们会像内置工具一样渲染，而不是显示为
通用的 `Tool call` 行。

路径和工作目录可以是绝对路径或相对路径。相对路径会相对于会话的工作目录解析，项目也正是挂载在容器中的该目录下。`container_read`、`container_write`
和 `container_edit` 的 `file_path` 不能包含 `..`
片段；工作目录可以包含，因为命令不受限于 projects 根目录。

未指定工作目录时，`container_bash`、`container_exec` 和 `daemon_start`
会在会话的工作目录中运行（与 harness 的 `bash`
工具一致），`container_glob`/`container_grep`
默认也在其中搜索。该目录必须已挂载到容器中——否则将使用 guest agent
自身的工作目录。显式的 `workdir`（或 `path`）始终优先。

`container_bash` 和 `container_exec` 接受可选的 `uid`、`gid` 和 `groups`
以其他用户身份运行命令。这些值只能是数字：容器的 `/etc/passwd` 和 `/etc/group`
位于只读根文件系统上，因此名称无法解析。`groups`
会替换进程的整个附加组集合，而应用任何身份都要求 guest agent 以 root
运行——它正是如此。`HOME` 不受管理，因此以其他 uid 运行的命令会继承容器的
`HOME`（只读的 `/root`）；请通过 `env` 将其指向可写目录。

文件工具（`container_read`、`container_write`、`container_edit`）可以访问
工作区的挂载：projects 根目录下的项目目录，以及任何 `volume` 和 `tmpfs`
挂载在其绝对目标路径上的内容。`secret` 挂载不会通过文件 API
暴露——机密值只能由容器内运行的进程读取。

### 挂载与卷

| 工具                       | 参数                                                                               | 描述                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `container_mount_add` ✱    | `container`, optional `kind`, `project`, `destination`, `mode`, `volume`, `secret` | 添加挂载；`kind` 为 `project`（默认）、`tmpfs`、`volume` 或 `secret` |
| `container_mount_list`     | `container`                                                                        | 列出容器的挂载                                                       |
| `container_mount_remove` ✱ | `container`, optional `kind`, `project`, `volume`, `destination`, `secret`         | 移除挂载；通过 `kind` 及其标识字段指定（见下文）                     |
| `container_mount_update` ✱ | `container`, `mode`, optional `kind`, `project`, `volume`, `destination`           | 更改项目或卷挂载的模式；标识方式同移除（见下文）                     |
| `volume_create`            | `name`                                                                             | 创建受管理的命名卷                                                   |
| `volume_list`              | —                                                                                  | 列出受管理的命名卷（短名称）                                         |
| `volume_remove` ✱          | `name`                                                                             | 移除受管理的命名卷；当容器仍在挂载它时拒绝                           |

`project` 挂载将 projects 根目录下的一个路径绑定到容器（`team`，或项目内的目录
`team/src`）；`tmpfs` 挂载可写的内存文件系统，`volume` 挂载 podman
命名卷（首次使用时自动创建）——两者都位于任意绝对容器路径，绝不位于 projects
根目录、`/tmp` 或其他保留路径之下。`secret`
挂载将受管理的机密作为只读文件暴露在绝对容器路径（参见[机密](#机密)）。

`project` 挂载不接受 `destination`：项目目录始终挂载在 projects
根目录下与之对应的路径上。`destination` 仅适用于 `tmpfs`、`volume` 和 `secret`
挂载。

在 Podman 页面中，添加挂载与创建容器对话框的项目路径字段带有 **浏览…**
按钮。它会打开一个目录选择器，通过 dsh 自身的主机侧目录列表（也就是 dsh
工作区目录选择所用的同一服务）读取 projects
根目录，而不经过编排器或容器。其布局与 dsh
自带的目录浏览器一致：双栏、带箭头图标的面包屑、文件夹图标以及隐藏项开关。该对话框被限制在
projects 根目录内，生成的路径以该根目录为基准存储。

移除挂载时，通过 `kind` 及该挂载自身的标识字段指定：项目挂载用
`project`，命名卷用 `volume`，机密用 `secret`，`tmpfs` 挂载用
`destination`。若某个标识字段匹配到多个挂载，请求会被拒绝，因此当同一卷或机密被挂载到多个位置时，还需一并传入
`destination`。`container_mount_list` 会报告准确的值。`kind` 可省略——会从
`secret` 或 `volume` 推断，否则为 `project`——但 `tmpfs`
例外，它没有可推断的名称，必须显式指定。

`mode` 为 `read_only` 或 `read_write`，默认为
`read_only`，这样添加挂载永远不会授予未被请求的写权限。`tmpfs` 挂载始终为
`read_write`，`secret` 挂载不带 mode。工作区自身的项目挂载以 `read_write`
创建；当会话不应修改项目时，用 `container_mount_update` 将其重新挂载为
`read_only`。

更改挂载的模式应使用 `container_mount_update`，而不是
`container_mount_add`：重新添加已存在的挂载会被拒绝，而不会静默更改它。它的标识方式与
`container_mount_remove`
完全相同（若某个标识字段匹配到多个挂载，请求会被拒绝），必须提供
`mode`，且仅适用于 `project` 和 `volume` 挂载——`tmpfs` 始终为
`read_write`，`secret` 挂载不带 mode。将模式更改为挂载已有的模式会被拒绝。

**命名容器**只携带创建它时指定的挂载：项目目录不会被自动挂载。**默认容器**
始终保留其工作区项目挂载，并且无法移除——但可以用 `container_mount_update`
将其重新挂载为 `read_only`。

修改容器的挂载（`container_mount_add`/`container_mount_remove`/`container_mount_update`）或其机密环境变量（`container_secret_add`/`container_secret_remove`）会**重建**容器：其正在运行的进程（包括守护进程）会被终止。绑定挂载的卷中的数据会保留；`tmpfs`
的内容不会。

### PATH 附加项

| 工具                      | 参数                 | 描述                                                     |
| ------------------------- | -------------------- | -------------------------------------------------------- |
| `container_path_set` ✱    | `container`, `paths` | 替换整个有序列表，第一项优先级最高；空列表表示清除       |
| `container_path_add` ✱    | `container`, `path`  | 在最前面添加一个目录；已存在的条目会被移到最前           |
| `container_path_remove` ✱ | `container`, `path`  | 移除一个已添加的目录；属于容器默认 PATH 的目录不会被移除 |

每个条目都必须是绝对、词法干净的目录，且不含 `:`
或换行符。该列表会被添加到容器自身 `PATH`（镜像的 `PATH`，即运行中的 guest agent
所见）之前，作用于 agent 启动的每个命令：内置的 `bash`/`read`/`write`/`edit`
工具、`container_bash`、`container_exec`、终端，以及之后启动的守护进程。容器不会被重建——运行中的
guest agent 会立即收到新列表，因此已在运行的守护进程仍使用旧的
`PATH`。容器被重建后会恢复持久化的列表。该列表也可以在创建、启动或重建容器时设置：通过设置模态框，或
`container_start` 和 `container_recreate` 的 `paths` 参数。

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
开头）。Podman 页面可以用用户输入的内容**覆盖**机密（只写），但绝不读取它。

挂载到某个路径的机密以 root 所有的**文件**（而非目录）形式创建，权限为除 root
外一律拒绝，因此只有容器的默认（root）用户可以读取它；以其他 `uid`
启动的守护进程无法读取挂载的机密。作为环境变量附加的机密会被 agent
启动的每个进程继承，除非守护进程以 `inheritEnv=false`
启动（参见[守护进程](#守护进程)）。

### 守护进程

| 工具             | 参数                                                                                     | 描述                                                               |
| ---------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `daemon_list`    | `container`                                                                              | 列出守护进程（包括其有效 `uid`/`gid` 和 `groups`）                 |
| `daemon_logs`    | `container`, `name`, optional `tailBytes`                                                | 查看守护进程 stdout/stderr 的尾部                                  |
| `daemon_restart` | `container`, `name`                                                                      | 使用相同的命令、环境、用户重启守护进程                             |
| `daemon_start`   | `container`, `name`, `argv`, optional `cwd`, `env`, `inheritEnv`, `uid`, `gid`, `groups` | 启动后台守护进程；可选的 `uid`/`gid`/`groups` 以其他用户身份运行它 |
| `daemon_stop`    | `container`, `name`, optional `signal`                                                   | 停止守护进程                                                       |

守护进程默认以容器用户身份运行。当只设置 `uid` 时，`gid`
默认为相同值；两者都未设置时，守护进程在没有任何 uid/gid
覆盖的情况下运行。`groups` 会替换进程的整个附加组集合。`daemon_list`
报告每个守护进程的有效 `uid`/`gid` 和附加组 `groups`。
使用已存在的名称启动守护进程时，会先停止该守护进程（如果它仍在运行）并将其替换；
已停止的守护进程仍会列出，以便其日志仍可读取。守护进程位于容器的 guest agent
中，不会在容器重建后保留（参见[挂载与卷](#挂载与卷)）。

守护进程默认继承容器的环境——即 guest agent 拥有的所有变量（包括用
`container_secret_add` 附加的环境机密），但会去掉保留的 `DSH_PODMAN`
命名空间。传入 `inheritEnv=false`
可将其隔离启动：此时它只接收（来自容器的）`PATH` 和 `HOME` 以及自身的
`env`，因此容器环境变量和机密环境变量都不可见。`daemon_restart`
会沿用守护进程启动时的模式。

## 容器管理 UI

插件附带一个浏览器端，把卡片注册到
**@exagone313/dsh-podman** 页面（侧边栏 **插件** 面板 → **已安装**）。该页面列出编排器创建的 guest
容器和已构建的镜像。没有容器的工作区会得到一个 **Create container**
按钮，打开一个配置模态框——镜像、环境、挂载（project、tmpfs、volume 和
secret）、PATH 附加项以及机密环境变量——而已有容器的工作区通过同一个模态框提供
**Add container**
按钮，用于添加额外的命名容器，模态框标题与打开它的按钮一致。在该模态框中，每个挂载的模式是一个下拉框（read-only/read-write），因此可以在创建时就把工作区项目挂载设为只读；tmpfs
和 secret 挂载的模式是固定的（分别为 read-write 和
read-only），显示为不可编辑的下拉框。容器行显示其环境和机密环境变量及其挂载，允许编辑环境变量和添加/移除挂载（每次移除都会确认），以及将命名机密附加/分离到容器的环境变量；每行还提供
**Remove**、**Recreate**（相同镜像）和 **Recreate with
image**。每个工作区行还提供 **移除 Pod**，它会移除该工作区的
Pod、其所有容器以及编排器对应的记录（卷、机密和项目数据会保留）；移除工作区的最后一个容器也会一并移除其
Pod，因此不会留下空的 Pod。每次通过 **插件**
面板打开该页面时都会重新读取实时状态，其底部还有一个 **Reload this view**
按钮。镜像部分可以重建单个镜像或按依赖顺序**重建全部**；**Build image**
打开一个弹窗，包含 image-id/base-image 表单和用于软件包列表的 chip
输入框（输入名称并按空格/逗号，或粘贴列表，以添加可移除的
chips）。卷和机密以独立的可展开行列出，每行都有自己的操作，**Create volume** /
**Create secret**
打开弹窗表单（机密表单接受可选的长度；机密的值可以被覆盖，但绝不读取）。Podman 页面操作是直接的控制调用，不受审批门控。

**软件包缓存**区段会报告每个已配置构建缓存（`DSH_PODMAN_HOST_PACMAN_CACHE`、`DSH_PODMAN_HOST_APT_CACHE`、`DSH_PODMAN_HOST_APK_CACHE`）的大小，并提供两个清理操作：**保留最新版本**会移除每个软件包除最新版本之外的所有缓存文件（连同其签名），**全部移除**会清空缓存。两者都是安全的——缓存的软件包只会被重新下载——且都不会在镜像构建进行时运行。

## Podman 操作员模式

插件附带一个名为 _Podman operator mode_（id `podman-ops`）的 **agent
预设**。插件的 bundle patch 会把它声明为一行
`@deepseek-ai/dsh-agent-preset`，因此 harness 的预设注册表会直接提供它。它出现在会话的
agent 预设选择器中，紧挨着内置预设。

该预设将聚焦 Podman 的人格与内置任务工具（`ask_user_question`、`todo_write`）和
`web_search`（web fetch 已禁用）组合在一起。它不挂载主机 shell、主机文件系统或
coding-agent 行（subagents、workflows、skills、goal、plan
mode、jobs）。插件自身的工具是全局的，全部保持可用，分为：

- **直接：**
  `image_list`、`image_get`、`container_list`、`container_read`、`container_glob`、`container_grep`、`container_mount_list`、`volume_list`、`secret_list`、`secret_create`、`daemon_list`、`daemon_logs`、`daemon_stop`、`daemon_restart`、`container_start`（仅在传入
  `mounts` 或 `secretEnv` 时询问）。
- **需审批**（通常的 `✱`
  工具）：`image_build`、`image_rebuild`、`image_rebuild_all`、`image_remove`、`container_recreate`、`container_remove`、`container_mount_add`、`container_mount_remove`、`container_mount_update`、`container_path_set`、`container_path_add`、`container_path_remove`、`volume_remove`、`secret_remove`、`container_secret_add`、`container_secret_remove`。
- **仅在此预设中需审批：**
  `container_bash`、`container_exec`、`container_write`、`container_edit`、`daemon_start`——因此一旦用户批准，agent
  就可以运行命令、编辑容器文件或启动守护进程，而无需这些工具在其他预设中询问。

上述审批策略中的权限旋钮仍然适用（Read Only 只允许直接的 read/list 工具；Full
access 跳过每个提示）。
