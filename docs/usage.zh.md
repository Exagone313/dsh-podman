<!--
SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>

SPDX-License-Identifier: MIT
-->

# 使用

[English](usage.md) | 中文

本页面记录了面向模型的工具、Podman
页面以及镜像模型。参见[架构](architecture.zh.md)了解各部分如何组合在一起。

## 模型上下文

Harness 会添加一个提示词区段，指明其自身的磁盘检出目录，以便模型检查或扩展 DSH
本身。该检出目录位于宿主机上，无法从工作区容器访问，因此 dsh-podman
会从组装后的系统提示词中移除该区段；模型不会被告知一个具有误导性的路径。

dsh-podman 还会添加自己的提示词区段，说明内置的 shell
与文件系统工具（`bash`、`read`、`write`、`edit`、`glob`、`grep`）在工作区的默认容器内运行，而非宿主机，并说明它们与
`container_*` 工具的关系。同一区段还会引导模型：安装软件时用 `image_build`
构建自定义镜像（再用 `container_start` 或 `container_recreate`
启动），需要跨容器重建保留的数据应使用命名卷而非 `tmpfs`。

## 技能

skill 就是文件，不是 API：dsh
从固定位置读取它们，而它们所在的位置决定了容器能否看到。

- 项目 skill 位于工作区内的 `.dsh/skills` 或
  `.agents/skills`。工作区以读写方式挂载进其容器， 因此这些 skill
  及其脚本在任何地方都能使用。
- 用户 skill 位于 `~/.agents/skills`（`DSH_AGENTS_HOME`）。dsh
  容器以只读方式挂载该目录， 每个 guest 容器也以只读方式挂载它，因此用户 skill
  及其脚本在任何地方都能使用。
- `~/.dsh/skills`（`DSH_HOME`）中的用户 skill
  会被读取和加载，但有意**不**挂载进容器：dsh 容器本身就以读写方式挂载了
  `~/.dsh`，而挂载一个插件可以改写的目录并不安全，因为 podman
  会跟随被替换到该位置的符号链接。因此其中的脚本无法在容器内运行。

`skill` 工具与 `/` 菜单会列出已加载的 skill。harness
会缓存已打开页面的菜单，因此在宿主机上新增 或修改 skill
后，请重新加载页面（或新建会话）。

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
  中，可从 Podman
  页面重建或拉取，并且它们的短名称是保留的——它们不能被覆盖构建、重建或作为自定义镜像移除。
- **自定义镜像**是从**父镜像**——基础镜像或另一个自定义镜像——创建的用户构建镜像，继承其软件包管理器并在此基础上添加额外软件包。它们通过短名称引用（例如
  `valkey`）。

镜像引用（`imageId`、`parent`、`image`）**只能是短名称**（没有镜像仓库前缀，没有
`:tag`）。

### 基础镜像

每个基础镜像都从其原始引用构建，安装同一份由 dsh-podman
拥有的固定软件包列表；自定义镜像继承其父镜像的软件包管理器。

| 短名称      | 软件包管理器 | 原始镜像                             | 软件包                                                                                                                                                                                                  |
| ----------- | ------------ | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `archlinux` | `pacman`     | `docker.io/library/archlinux:latest` | `base-devel`、`ca-certificates`、`curl`、`diffutils`、`fd`、`git`、`inetutils`、`jq`、`less`、`openbsd-netcat`、`openssh`、`patch`、`procps-ng`、`python`、`ripgrep`、`tree`、`unzip`、`wget`、`zstd`   |
| `ubuntu`    | `apt`        | `docker.io/library/ubuntu:latest`    | `build-essential`、`ca-certificates`、`curl`、`diffutils`、`fd-find`、`git`、`jq`、`less`、`netcat-openbsd`、`openssh-client`、`patch`、`procps`、`python3`、`ripgrep`、`tree`、`unzip`、`wget`、`zstd` |
| `alpine`    | `apk`        | `docker.io/library/alpine:latest`    | `bash`、`build-base`、`ca-certificates`、`curl`、`diffutils`、`fd`、`git`、`jq`、`less`、`openssh-client`、`patch`、`procps`、`python3`、`ripgrep`、`tree`、`unzip`、`wget`、`zstd`                     |

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
`Add mount to container "web": volume "data" (read-only)`。它涵盖容器镜像、每个挂载的类型与目标路径、环境变量的键、机密环境变量名，以及解析后的文件路径。它会跟随界面语言：浏览器客户端将当前语言记录到插件的
`uiLocale`
偏好中，并由主机持久化到插件配置（未设置时为英文）。策略拒绝——只读沙箱，或项目挂载上指定了目标路径——也会使用相同的语言。Podman
页面操作是直接的控制调用，不进行门控。

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
身份只需配置一次，而不必按项目重复设置——见[默认环境变量](configuration.zh.md#默认环境变量)。Podman
页面中的 **Git 身份**弹窗用一份姓名与邮箱填入四个
`GIT_AUTHOR_*`/`GIT_COMMITTER_*` 变量。

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
`DSH_PODMAN` 开头）。Podman
页面可以用用户输入的内容**覆盖**机密（只写），但绝不读取它。

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

### 端口发布

| 工具                       | 参数                                                               | 说明                                                        |
| -------------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------- |
| `container_publish_port`   | `container`、`port`，可选 `protocol`（`tcp`）、`suggestedHostPort` | 在主机 `127.0.0.1` 上暴露 pod 的一个 TCP 端口，并返回其地址 |
| `container_unpublish_port` | `container`、`port`，可选 `protocol`（`tcp`）                      | 停止暴露已发布的端口                                        |

默认情况下，主机无法访问 pod 的端口。发布通过标准安装会运行的
`dsh-podman-gateway` 容器（见[安装](install-dsh-and-dsh-podman.zh.md)）把一个
TCP 端口带出来：guest agent 通过共享套接字根目录中的 UNIX 套接字转发到 pod
内的端口，gateway
则把一个主机地址和端口绑定到该套接字并转发过去。绑定地址始终只有
`127.0.0.1`，因此已发布端口只能从本机访问，而本机上的任何进程都可以访问——这也是该工具需要审批的原因。

`container_publish_port` 返回可展示给用户的地址，例如
`tcp://127.0.0.1:6666`。传入
`suggestedHostPort`（1024-65535）可指定主机端口；省略时由 gateway
选择一个空闲端口，返回的地址会带上实际绑定的端口。重复发布同一端口是幂等的。已发布端口在容器重建后仍使用同一主机端口，并在取消发布、移除容器或销毁工作区时释放——除了
orchestrator 持有租约的部分，gateway 不会自行保留任何主机端口。

目前只实现 TCP；`protocol` 默认为
`tcp`，而请求、存储记录和返回的地址都已能表达协议，因此将来可以加入 `udp` 和
`http` 而不改变工具形态。gateway
是可选的：未安装时，这两个工具会报告其未运行，其他功能不受影响。

## 容器管理 UI

插件附带一个浏览器端，把卡片注册到 **dsh-podman** 页面（打开侧边栏的 **插件**
面板并选择
**已安装**）。该页面是一组标签页——**工作区**、**镜像**、**存储**、**默认设置**
和 **状态**——顶部是状态条，统计持有容器的工作区数与运行中的容器数，随后是
orchestrator 与 gateway 的就绪／未就绪标签。每次通过 **插件**
面板打开该页面时都会重新读取实时状态，标签页下方还有一个 **刷新此视图**
按钮，因此从任何标签页都能刷新。Podman 页面操作是直接的控制调用，不受审批门控。

### 工作区

**工作区**标签页列出编排器创建的 guest
容器。每个工作区卡片用一句话说明其容器有多少在运行、多少已停止（已停止部分以灰色呈现）。唯一的共享
PTC 容器不属于任何工作区，因此绝不会出现在这里：它的卡片位于 **状态** 标签页。

卡片以工作区的可读名称作为标题，并在其旁提供一个低调的 **复制工作区 ID**
按钮用于复制其 UUID，并把每个容器呈现为一个堆叠区块。

没有容器的工作区会得到一个 **创建容器** 按钮；已有容器的工作区则得到
**添加容器** 按钮，用于添加额外的命名容器。每个工作区行还提供
**移除容器**，它会移除该工作区的 dsh-podman 容器及其
Pod，以及编排器对应的记录（卷、机密和项目数据会保留，dsh
工作区本身不受影响）；移除工作区的最后一个容器也会一并移除其
Pod，因此不会留下空的 Pod。

#### 容器

区块的身份行包含容器名称、状态标签与创建时间（相对时间，精确时刻作为提示）。

其 **编辑**、**重建** 与 **移除**
操作位于该行右端——有空间时右对齐，空间不足时移到名称下方：**重建**
会在确认（确认框会指明容器）后按原样重建容器。

有一个容器是保留的：`ptc`，即服务工作流与 PTC
运行的容器。它不属于任何工作区，因此绝不会出现在某个工作区内部：其卡片位于
**状态** 标签页，紧接在组件表格下方，并在状态标签之后带有紫色的 **PTC**
标签。尚未创建的 PTC 容器以灰色的 **缺失**
显示，而不会被视为错误：它会在首次使用时按需创建。其运行的 PTC
程序没有文件系统或网络访问权限，而是在宿主机侧调用工具，因此该容器不携带挂载、环境变量、机密或发布端口；编排器创建它时也不带这些内容。其镜像是单一的
`ptc` 镜像，按需构建：当它所携带的 harness
版本发生变化时重建，否则在各工作区之间复用。

agent 的工具看不到它——`container_list`、`container_read`
等永远不会返回它——其卡片提供 **重建** 与 **移除**，没有
**编辑**，因此它的名称与所有字段都保持固定。**重建**
通过编排器的不带工作区的移除操作删除这个共享容器，再从当前 PTC
镜像重新确保其存在；**移除** 则停用该容器，下次运行 PTC 时会重新创建。升级
harness 时会重建这个唯一的 PTC 镜像，并在下次使用时重建容器；未升级的 agent
会继续报告与之前相同的 PTC 错误。

字段按各对话框共用的规范顺序排列，每个都是自带复制控件的只读字段：环境变量与机密环境变量为键／值字段对，PATH
附加项为目录字段列表，挂载与端口为逐条字段，所有值都完整显示并可换行。

#### 容器对话框

**添加容器** 与 **创建容器** 打开与 **编辑**
相同的对话框——宽度相同、高度同样限制在视口内、分组顺序相同、底部布局也相同——其标题与打开它的操作一致，并以
**名称** 分组开头：在 **添加容器** 中可编辑，在工作区默认容器的 **创建容器** 与
**编辑** 中为只读。**编辑**
会打开一个对话框集中呈现这些内容——只读名称、镜像、环境变量、挂载、PATH
变量附加项、机密环境变量与已发布端口。

**名称** 之后的分组依次为 **镜像**、**环境变量**、**挂载**、**PATH
变量附加项**、**机密环境变量** 和
**已发布端口**。编辑器中的每一行都是容器区块所用的同一种带标签字段行，只是把区块中的只读字段及其复制控件换成可编辑控件。

对话框会将自身限制在视口内，标题与底部栏固定，正文滚动；**放弃**
放弃草稿，对话框底部唯一的主操作在确认（确认框会指明容器）后应用草稿——当更改会重建容器时，它是破坏性色调的
**重建容器**；当运行中的容器可以直接接受更改时，它是中性色调的 **更新容器**。

其旁有一个标记说明将应用的更改。

当变量名为空，或在环境变量与机密环境变量中重复使用时，应用会被拒绝：底部栏以红色说明冲突，冲突的键带有红色边框，冲突所指的行会留在原处，直到用该行自己的
**移除** 删除，而未命名的行不会被应用。

#### 挂载

挂载行以简短的标签标明类型——**项目**、**tmpfs**、**卷** 或
**机密**。在对话框中可以添加和移除挂载，从运行中的容器移除会要求确认。

添加时需要选择其类型；对于项目挂载，还要选择项目本身，目标路径由此推导：项目路径在
projects
根目录下的镜像路径，并显示在只读字段中，因为项目挂载本身不接受目标路径。

创建或添加容器时，项目与卷挂载的模式是一个下拉框（只读／读写），因此可以在创建时就把工作区项目挂载设为只读；机密与
tmpfs 挂载不带模式控件。

默认容器的主项目挂载的 **移除**
按钮保持灰色且禁用，并以提示说明原因，因为它无法移除。

#### 环境变量

环境变量在键／值行中编辑，每个键／值行都有自己的可见标签，以及一个以变量名命名的
**移除**。

**添加容器** 与 **创建容器** 的 **环境变量**
分组会以工作区的默认环境变量开头，使新容器将继承的值可见；不改动的值保留默认值，改动过的值成为该容器自身的环境变量。

机密环境变量通过新增一行并从命名机密中选择来附加——变量名可像环境变量的键一样就地编辑——就地改换其机密，或用该行自己的
**移除** 按钮移除。工作区没有机密时，机密选择器会替换为
**创建机密**，在对话框之上打开机密表单。

变量名必填，且在环境变量与机密环境变量中必须唯一。

#### PATH 附加项与端口

PATH 变量附加项通过 **编辑 PATH 附加项** 按钮编辑，其对话框为每个条目列出
**路径** 字段，并通过 **添加条目** 在最前面新增一个；UI 中称之为 **PATH
变量附加项**，而下方工具章节称之为 PATH 附加项。

对话框的 **已发布端口** 分组列出已暴露到主机的端口，**发布端口**
按钮会打开一个弹窗：填写容器端口、协议（目前只实现
tcp），以及可选的首选主机端口；在弹窗中确认后暂存该添加——未填写主机端口时由
gateway 选择一个空闲端口，通知中会给出实际绑定的地址。

gateway 尚未绑定的端口会保留所请求的主机端口并在其后加上 **（待发布）**。当
gateway
未运行或容器未运行时，发布会显示提示并保持禁用；已暴露到主机的端口可通过其自身的
**取消发布** 操作取消，确认（确认框会指明该端口）后生效。

### 镜像

**镜像**标签页以 **基础镜像** 卡片和 **自定义镜像**
卡片列出已构建的镜像。它可以重建单个镜像或按依赖顺序 **重建全部镜像**。

每个镜像行是一个区块，首行是镜像名称、状态及其 **重建**/**设为默认**
操作（有空间时右对齐，空间不足时移到名称下方），随后是带标签的构建时间（仅在镜像已构建时显示；相对时间，精确时刻作为提示）、父镜像与软件包（chips
单独成行）。

自定义镜像的破坏性 **移除** 位于同一操作组中，而不是区块下方的独立一行。

保留的 `ptc` 镜像位于 **基础镜像**
卡片的最后，列在所有基础镜像之后：其名称、**已构建**／**缺失** 状态与紫色的
**PTC** 标签、标明其构建来源 `node:26-slim` 原语的父镜像行，以及一个
**构建**/**重建** 按钮：**构建** 在镜像缺失时创建 PTC 容器及其镜像，**重建**
只重建该镜像，而 **重建全部镜像**
会重建包括该镜像在内的每个镜像，缺失时先构建，并使用插件所针对的 harness
版本。其 **设为默认** 按钮保持禁用，提示说明该镜像专用于 PTC（Programmatic Tool
Calling）；它没有 **移除**：编排器拥有它，并将其排除在可编辑镜像集之外。

**构建自定义镜像**（位于 **自定义镜像**
卡片上）打开一个弹窗，包含镜像名称表单、预选为默认镜像的父镜像选择器，以及用于软件包列表的
chip 输入框（输入名称并按空格/逗号，或粘贴列表，以添加可移除的 chips；chips
显示在输入框下方）。

### 存储

卷和机密以独立的可展开行列出，每行都有自己的操作。

**创建卷** / **创建机密** 打开弹窗表单（机密表单接受可选的长度）。

机密行依次带有**编辑**和**移除**：**编辑**打开同一表单，其**新值**字段可以设置或覆盖，但绝不读取；**移除**则移除该机密。

**软件包缓存**区段会报告每个已配置构建缓存（`DSH_PODMAN_HOST_PACMAN_CACHE`、`DSH_PODMAN_HOST_APT_CACHE`、`DSH_PODMAN_HOST_APK_CACHE`）的大小，并提供两个清理操作：**保留最新版本**
会移除每个软件包除最新版本之外的所有缓存文件（连同其签名），**全部移除**
会清空缓存。

两者都是安全的——缓存的软件包只会被重新下载——且都不会在镜像构建进行时运行。

### 默认设置

**默认设置**标签页会在带标签的选择器中显示实际生效的默认镜像（已配置的镜像，或首个基础镜像，并标注为“基础镜像”）及
**默认环境变量**。

**Git 身份** 按钮打开一个弹窗，填写姓名与邮箱，把四个
`GIT_AUTHOR_*`/`GIT_COMMITTER_*` 变量填入草稿。

**为容器补上缺失的变量**
操作会打开一个对话框，把默认环境变量应用到所有容器或某个工作区的容器，并列出将添加的变量。

### 状态

**状态**标签页以组件表格列出 dsh、本插件与两个守护进程的运行时状态、版本与提交。

版本差异会标注在它所限定的状态旁。

紧接该表格下方是共享 PTC 容器的卡片：其身份、状态与 **PTC**
标签、相对创建时间、只读镜像，以及 **重建**／**移除** 操作。

## Podman 终端

插件自带一个右侧边栏的 **Podman 终端**标签页，与 dsh
自带的终端标签页相互独立。可从右侧边栏的“新建标签页”指南中打开（卡片名为**新建终端**），或按
**Ctrl+`**；标签页以所运行的 shell 命名（`bash`、`sh`等）。插件的 bundle patch 会禁用 dsh 自带的终端界面，从而让出该快捷键（若重新启用，插件会回退到 **Ctrl+Shift+`**）；agent
的 `terminal`
工具不受影响。它始终在会话所在的工作区中运行——每个工作区都有自己的侧边栏和终端——因此启动表单只需选择容器和
shell，既可在默认容器中运行，也可在命名容器中运行；若会话目录不属于任何已知工作区，表单会直接提示而不是猜测。harness
自带的终端始终使用该工作区的默认容器。上次启动所使用的容器与 shell
会记录在浏览器的本地存储中，只要仍然可用就会预先选中——容器已不存在时回退到默认容器，镜像不再提供该
shell 时回退到容器提供的第一个 shell。

shell 列表在**所选容器内部**探测：按候选名称在该容器的 PATH
中查找（`command -v`），并与 `/etc/shells` 和 `$SHELL` 合并，因此通过 PATH
追加项或挂载卷安装的 shell
会出现，而镜像中不存在的则不会。列表按能力从强到弱排列（`zsh`、`bash`、`fish`……直到
`dash`、`ash`、`sh`），因此选择器会预选容器中最好的
shell。启动前还会再次校验所选 shell。

终端由主机保留：切换标签页、关闭侧边栏或刷新页面都不会丢失 shell
及其回滚缓冲，重新接入时会回放屏幕内容。关闭标签页后 shell
仍会保留一段时间（直到主机回收）；**重新连接**会在当前选择中启动一个新的
shell。关闭或重建容器会丢弃其终端，之后请重新连接。

## Podman 操作员模式

插件附带一个名为 _Podman operator mode_（id `podman-ops`）的 **agent
预设**。插件的 bundle patch 会把它声明为一行
`@deepseek-ai/dsh-agent-preset`，因此 harness
的预设注册表会直接提供它。它出现在会话的 agent 预设选择器中，紧挨着内置预设。

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
