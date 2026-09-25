// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import type {} from "@deepseek-ai/dsh-client-ui-slots";

export const NS = "podman";

export type ContainerPluginKey =
  | "cardTitle"
  | "cardDescription"
  | "versionMismatchMajor"
  | "versionMismatchMinor"
  | "versionsTitle"
  | "orchestrator"
  | "versionUnknown"
  | "dsh"
  | "copyVersions"
  | "copied"
  | "copyFailed"
  | "reload"
  | "notice"
  | "defaultImage"
  | "defaultImageHint"
  | "defaultEnvironment"
  | "defaultEnvironmentHint"
  | "gitIdentity"
  | "gitName"
  | "gitEmail"
  | "gitIdentityHint"
  | "applyDefaults"
  | "confirmApplyDefaults"
  | "clear"
  | "save"
  | "discard"
  | "workspacesTitle"
  | "noContainers"
  | "createContainer"
  | "containerName"
  | "image"
  | "status"
  | "created"
  | "projects"
  | "remove"
  | "removePod"
  | "confirmRemovePod"
  | "recreate"
  | "recreateWithImage"
  | "imagesTitle"
  | "imageId"
  | "imageTag"
  | "builtAt"
  | "packages"
  | "volumesTitle"
  | "createVolume"
  | "removeVolume"
  | "volumeName"
  | "secretsTitle"
  | "createSecret"
  | "secretName"
  | "secretCharset"
  | "selectImage"
  | "setSecret"
  | "removeSecret"
  | "removeImage"
  | "rebuildImage"
  | "rebuildAllImages"
  | "buildImage"
  | "build"
  | "buildImageTitle"
  | "pullImage"
  | "setDefaultImage"
  | "setDefaultImageTitle"
  | "baseImagesTitle"
  | "customImagesTitle"
  | "primitive"
  | "packageManager"
  | "parent"
  | "cancel"
  | "removeTag"
  | "env"
  | "secretEnv"
  | "envTitle"
  | "envKey"
  | "envValue"
  | "addEnv"
  | "removeEnv"
  | "secretLength"
  | "containerSecretsTitle"
  | "attachSecret"
  | "secretEnvName"
  | "detachSecret"
  | "none"
  | "unavailable"
  | "busy"
  | "confirmTitle"
  | "confirm"
  | "confirmRemoveContainer"
  | "confirmRecreate"
  | "confirmRemoveImage"
  | "confirmRebuildImage"
  | "confirmRebuildAllImages"
  | "confirmRemoveVolume"
  | "confirmSetSecret"
  | "confirmRemoveSecret"
  | "confirmDetachSecret"
  | "mountsTitle"
  | "addMount"
  | "mountKind"
  | "mountProject"
  | "mountProjectPath"
  | "browse"
  | "browseTitle"
  | "browseSelect"
  | "browseLoading"
  | "browseError"
  | "browseUnavailable"
  | "browseHidden"
  | "browseTruncated"
  | "browseOutsideRoot"
  | "mountDestination"
  | "pathsTitle"
  | "noPaths"
  | "editPaths"
  | "addPath"
  | "add"
  | "moveUp"
  | "moveDown"
  | "apply"
  | "dragToReorder"
  | "remountWaiting"
  | "remountApprove"
  | "remountReject"
  | "mountVolume"
  | "mountSecret"
  | "mountTmpfs"
  | "mountAt"
  | "mountMode"
  | "readOnly"
  | "readWrite"
  | "mountReadOnlySuffix"
  | "mountReadWriteSuffix"
  | "remountReadOnly"
  | "remountReadWrite"
  | "confirmRemountReadOnly"
  | "confirmRemountReadWrite"
  | "confirmRemoveMount"
  | "cachesTitle"
  | "noCaches"
  | "cacheUsage"
  | "cacheKeepLatest"
  | "confirmCacheKeepLatest"
  | "cacheRemoveAll"
  | "confirmCacheRemoveAll"
  | "addContainer"
  | "invalidContainerName"
  | "containerNameTaken"
  | "invalidName"
  | "invalidImageId"
  | "terminalSignal"
  | "terminalExitCode"
  | "terminalNoExitCode"
  | "terminalRunning"
  | "terminalFailed"
  | "terminalDone"
  | "terminalNoOutput"
  | "terminalCollapseAria"
  | "terminalExpandAria"
  | "terminalExpandRest"
  | "toolTitle_container_bash"
  | "toolTitle_container_exec"
  | "toolTitle_container_read"
  | "toolTitle_container_write"
  | "toolTitle_container_edit"
  | "toolTitle_container_glob"
  | "toolTitle_container_grep"
  | "toolTitle_container_list"
  | "toolTitle_container_start"
  | "toolTitle_container_recreate"
  | "toolTitle_container_remove"
  | "toolTitle_container_mount_list"
  | "toolTitle_container_mount_add"
  | "toolTitle_container_mount_remove"
  | "toolTitle_container_mount_update"
  | "toolTitle_container_path_set"
  | "toolTitle_container_path_add"
  | "toolTitle_container_path_remove"
  | "toolTitle_container_secret_add"
  | "toolTitle_container_secret_remove"
  | "toolTitle_image_list"
  | "toolTitle_image_get"
  | "toolTitle_image_build"
  | "toolTitle_image_rebuild"
  | "toolTitle_image_rebuild_all"
  | "toolTitle_image_remove"
  | "toolTitle_volume_list"
  | "toolTitle_volume_create"
  | "toolTitle_volume_remove"
  | "toolTitle_secret_list"
  | "toolTitle_secret_create"
  | "toolTitle_secret_remove"
  | "toolTitle_daemon_start"
  | "toolTitle_daemon_list"
  | "toolTitle_daemon_logs"
  | "toolTitle_daemon_restart"
  | "toolTitle_daemon_stop"
  | "terminalTabTitle"
  | "terminalGuideTitle"
  | "terminalGuideDescription"
  | "terminalShortcut"
  | "terminalShortcutNoSession"
  | "terminalContainer"
  | "terminalShell"
  | "terminalDefaultContainer"
  | "terminalStart"
  | "terminalConnect"
  | "terminalReconnect"
  | "terminalStatusConnecting"
  | "terminalStatusRunning"
  | "terminalStatusExited"
  | "terminalStatusDetached"
  | "terminalNoShells"
  | "terminalShellsFailed"
  | "terminalLoading";

export const en: Record<ContainerPluginKey, string> = {
  cardTitle: "dsh-podman",
  cardDescription: "Manage the guest containers and their images.",
  versionMismatchMajor:
    "This plugin's major version differs from the orchestrator's; update the dsh image or the orchestrator image so both match.",
  versionMismatchMinor:
    "This plugin and the orchestrator have compatible but different versions; consider updating both images.",
  versionsTitle: "Versions",
  orchestrator: "dsh-podman-orchestrator",
  versionUnknown: "unknown",
  dsh: "dsh",
  copyVersions: "Copy versions",
  copied: "Copied",
  copyFailed: "Copy failed",
  reload: "Reload this view",
  notice: "Notice",
  defaultImage: "Default image",
  defaultImageHint: "Image used when a workspace has no image of its own.",
  defaultEnvironment: "Default environment",
  defaultEnvironmentHint:
    "Seeded into a container when it is created. Edit a container's own environment and recreate it to change or remove a value for that container.",
  gitIdentity: "Git identity",
  gitName: "Name",
  gitEmail: "Email",
  gitIdentityHint:
    "Fills GIT_AUTHOR_NAME/EMAIL and GIT_COMMITTER_NAME/EMAIL for new containers, so commits made inside them are attributed to you.",
  applyDefaults: "Apply default environment variables",
  confirmApplyDefaults:
    "Add the default environment variables to the containers that are missing them? Matching running containers are recreated (their processes and daemons stop); existing values are kept and stopped containers are left alone.",
  clear: "Clear",
  save: "Save",
  discard: "Discard",
  workspacesTitle: "Workspaces",
  noContainers: "This workspace has no containers yet.",
  createContainer: "Create container",
  containerName: "Container",
  image: "Image",
  status: "Status",
  created: "Created",
  projects: "Projects",
  remove: "Remove",
  removePod: "Remove pod",
  confirmRemovePod:
    "Remove this workspace's pod and all its containers? Volume and project data is kept.",
  recreate: "Recreate",
  recreateWithImage: "Recreate with image",
  imagesTitle: "Images",
  imageId: "Image ID",
  imageTag: "Tag",
  builtAt: "Built at",
  packages: "Packages",
  volumesTitle: "Volumes",
  createVolume: "Create volume",
  removeVolume: "Remove",
  volumeName: "Volume name",
  secretsTitle: "Secrets",
  createSecret: "Create secret",
  secretName: "Secret name",
  secretCharset: "Charset",
  setSecret: "Set value",
  removeSecret: "Remove",
  removeImage: "Remove",
  rebuildImage: "Rebuild",
  rebuildAllImages: "Rebuild all",
  buildImage: "Build image",
  build: "Build",
  buildImageTitle: "Build an image",
  pullImage: "Pull",
  setDefaultImage: "Set default",
  setDefaultImageTitle: "Set default image",
  baseImagesTitle: "Base images",
  customImagesTitle: "Custom images",
  primitive: "Primitive",
  packageManager: "Package manager",
  parent: "Parent",
  selectImage: "Select an image",
  cancel: "Cancel",
  removeTag: "Remove",
  env: "Env",
  secretEnv: "Secret env",
  envTitle: "Environment variables",
  envKey: "Key",
  envValue: "Value",
  addEnv: "Add",
  removeEnv: "Remove",
  secretLength: "Length",
  containerSecretsTitle: "Secret env vars",
  attachSecret: "Attach",
  secretEnvName: "Env var",
  detachSecret: "Detach",
  none: "None",
  unavailable: "The container plugin is not available.",
  busy: "Working…",
  confirmTitle: "Confirm action",
  confirm: "Confirm",
  confirmRemoveContainer: "Remove the default container of this workspace?",
  confirmRecreate: "Recreate this container? Its ephemeral state is lost.",
  confirmRemoveImage:
    "Remove this image? Containers using it must be recreated from another image.",
  confirmRebuildImage: "Rebuild this image in place?",
  confirmRebuildAllImages: "Rebuild every image in dependency order (base first)?",
  confirmRemoveVolume: "Remove this volume and its data?",
  confirmSetSecret: "Overwrite this secret's value?",
  confirmRemoveSecret: "Remove this secret? Containers using it must drop it first.",
  confirmDetachSecret: "Detach this secret environment variable from the container?",
  mountsTitle: "Mounts",
  addMount: "Add mount",
  mountKind: "Kind",
  mountProject: "Project",
  mountProjectPath: "Project path",
  browse: "Browse…",
  browseTitle: "Select a project directory",
  browseSelect: "Select this directory",
  browseLoading: "Loading…",
  browseError: "Could not read this directory.",
  browseUnavailable: "This deployment has no directory picker.",
  browseHidden: "Show hidden",
  browseTruncated: "Too many folders to list; only the beginning is shown.",
  browseOutsideRoot: "Choose a directory inside the projects root.",
  mountDestination: "Destination",
  pathsTitle: "PATH additions",
  noPaths: "No PATH additions.",
  editPaths: "Edit PATH additions",
  addPath: "Path to add",
  add: "Add",
  moveUp: "Move up",
  moveDown: "Move down",
  apply: "Apply",
  dragToReorder: "Drag to reorder",
  remountWaiting: "Waiting for approval",
  remountApprove: "Remount & run",
  remountReject: "Reject",
  mountVolume: "Volume",
  mountSecret: "Secret",
  mountTmpfs: "tmpfs",
  mountAt: "at",
  mountMode: "Mode",
  readOnly: "Read-only",
  readWrite: "Read-write",
  mountReadOnlySuffix: "(ro)",
  mountReadWriteSuffix: "(rw)",
  remountReadOnly: "Remount as read-only",
  remountReadWrite: "Remount as read-write",
  confirmRemountReadOnly: "Remount this mount as read-only and recreate the container?",
  confirmRemountReadWrite: "Remount this mount as read-write and recreate the container?",
  confirmRemoveMount: "Remove this mount from the container and recreate it?",
  cachesTitle: "Package caches",
  noCaches: "No package cache is configured.",
  cacheUsage: "{size} · {n} files",
  cacheKeepLatest: "Keep latest versions",
  confirmCacheKeepLatest: "Remove older cached package versions? Current versions are kept.",
  cacheRemoveAll: "Remove all",
  confirmCacheRemoveAll: "Remove every cached package? The next build re-downloads what it needs.",
  addContainer: "Add container",
  invalidContainerName: "Invalid container name",
  containerNameTaken: "Container name already exists",
  invalidName: "Start with a letter or digit; only letters, digits, '.', '_', '-' (max 64).",
  invalidImageId:
    "Start with a letter, digit, or '_'; only letters, digits, '.', '_', '-', '/', ':' (max 128).",
  terminalSignal: "signal {signal}",
  terminalExitCode: "exit code {code}",
  terminalNoExitCode: "no exit code",
  terminalRunning: "Running",
  terminalFailed: "Failed",
  terminalDone: "Done",
  terminalNoOutput: "No output",
  terminalCollapseAria: "Collapse output",
  terminalExpandAria: "Expand the remaining {n} output lines",
  terminalExpandRest: "… {n} more lines",
  toolTitle_container_bash: "Container bash",
  toolTitle_container_exec: "Container exec",
  toolTitle_container_read: "Container read",
  toolTitle_container_write: "Container write",
  toolTitle_container_edit: "Container edit",
  toolTitle_container_glob: "Container glob",
  toolTitle_container_grep: "Container grep",
  toolTitle_container_list: "List containers",
  toolTitle_container_start: "Start container",
  toolTitle_container_recreate: "Recreate container",
  toolTitle_container_remove: "Remove container",
  toolTitle_container_mount_list: "List mounts",
  toolTitle_container_mount_add: "Add mount",
  toolTitle_container_mount_remove: "Remove mount",
  toolTitle_container_mount_update: "Change mount mode",
  toolTitle_container_path_set: "Set PATH additions",
  toolTitle_container_path_add: "Add PATH entry",
  toolTitle_container_path_remove: "Remove PATH entry",
  toolTitle_container_secret_add: "Attach secret",
  toolTitle_container_secret_remove: "Detach secret",
  toolTitle_image_list: "List images",
  toolTitle_image_get: "Inspect image",
  toolTitle_image_build: "Build image",
  toolTitle_image_rebuild: "Rebuild image",
  toolTitle_image_rebuild_all: "Rebuild all images",
  toolTitle_image_remove: "Remove image",
  toolTitle_volume_list: "List volumes",
  toolTitle_volume_create: "Create volume",
  toolTitle_volume_remove: "Remove volume",
  toolTitle_secret_list: "List secrets",
  toolTitle_secret_create: "Create secret",
  toolTitle_secret_remove: "Remove secret",
  toolTitle_daemon_start: "Start daemon",
  toolTitle_daemon_list: "List daemons",
  toolTitle_daemon_logs: "Daemon logs",
  toolTitle_daemon_restart: "Restart daemon",
  toolTitle_daemon_stop: "Stop daemon",
  terminalTabTitle: "Podman terminal",
  terminalGuideTitle: "Podman terminal",
  terminalGuideDescription: "Open a shell in a workspace container",
  terminalShortcut: "New Podman terminal",
  terminalShortcutNoSession: "Select a session first",
  terminalContainer: "Container",
  terminalShell: "Shell",
  terminalDefaultContainer: "Default container",
  terminalStart: "Start",
  terminalConnect: "Connect",
  terminalReconnect: "Reconnect",
  terminalStatusConnecting: "Connecting…",
  terminalStatusRunning: "Connected",
  terminalStatusExited: "Process exited ({code})",
  terminalStatusDetached: "Detached (opened elsewhere)",
  terminalNoShells: "No shells available",
  terminalShellsFailed: "Could not list shells: {message}",
  terminalLoading: "Loading…",
};

export const zh: Record<ContainerPluginKey, string> = {
  cardTitle: "dsh-podman",
  cardDescription: "管理工作区容器及其镜像。",
  versionMismatchMajor:
    "此插件与 orchestrator 的主版本不同；请更新 dsh 镜像或 orchestrator 镜像，使两者一致。",
  versionMismatchMinor: "此插件与 orchestrator 的版本不同但兼容；建议同时更新两个镜像。",
  versionsTitle: "版本",
  orchestrator: "dsh-podman-orchestrator",
  versionUnknown: "未知",
  dsh: "dsh",
  copyVersions: "复制版本",
  copied: "已复制",
  copyFailed: "复制失败",
  reload: "刷新此视图",
  notice: "提示",
  defaultImage: "默认镜像",
  defaultImageHint: "工作区没有自带镜像时使用的镜像。",
  defaultEnvironment: "默认环境变量",
  defaultEnvironmentHint:
    "容器创建时注入的环境变量。编辑容器自身的环境变量后重建该容器，即可修改或移除其中的某一项。",
  gitIdentity: "Git 身份",
  gitName: "姓名",
  gitEmail: "邮箱",
  gitIdentityHint:
    "为新容器填入 GIT_AUTHOR_NAME/EMAIL 与 GIT_COMMITTER_NAME/EMAIL，使容器内提交的提交者信息正确。",
  applyDefaults: "应用默认环境变量",
  confirmApplyDefaults:
    "为缺少默认环境变量的容器补上这些变量？匹配的运行中容器会被重建（其进程与守护进程会停止）；已有值保持不变，已停止的容器不会被处理。",
  clear: "清除",
  save: "保存",
  discard: "放弃",
  workspacesTitle: "工作区",
  noContainers: "该工作区还没有容器。",
  createContainer: "创建容器",
  containerName: "容器",
  image: "镜像",
  status: "状态",
  created: "创建时间",
  projects: "项目",
  remove: "移除",
  removePod: "移除 Pod",
  confirmRemovePod: "移除该工作区的 Pod 及其所有容器？卷和项目数据会保留。",
  recreate: "重建",
  recreateWithImage: "使用镜像重建",
  imagesTitle: "镜像",
  imageId: "镜像 ID",
  imageTag: "标签",
  builtAt: "构建时间",
  packages: "软件包",
  volumesTitle: "卷",
  createVolume: "创建卷",
  removeVolume: "移除",
  volumeName: "卷名称",
  secretsTitle: "机密",
  createSecret: "创建机密",
  secretName: "机密名称",
  secretCharset: "字符集",
  setSecret: "设置值",
  removeSecret: "移除",
  removeImage: "移除",
  rebuildImage: "重建",
  rebuildAllImages: "重建全部",
  buildImage: "构建镜像",
  build: "构建",
  buildImageTitle: "构建镜像",
  pullImage: "拉取",
  setDefaultImage: "设为默认",
  setDefaultImageTitle: "设置默认镜像",
  baseImagesTitle: "基础镜像",
  customImagesTitle: "自定义镜像",
  primitive: "源镜像",
  packageManager: "包管理器",
  parent: "父镜像",
  selectImage: "选择镜像",
  cancel: "取消",
  removeTag: "移除",
  env: "环境变量",
  secretEnv: "机密环境变量",
  envTitle: "环境变量",
  envKey: "键",
  envValue: "值",
  addEnv: "添加",
  removeEnv: "移除",
  secretLength: "长度",
  containerSecretsTitle: "机密环境变量",
  attachSecret: "注入",
  secretEnvName: "变量名",
  detachSecret: "移除",
  none: "无",
  unavailable: "容器插件不可用。",
  busy: "处理中…",
  confirmTitle: "确认操作",
  confirm: "确认",
  confirmRemoveContainer: "移除该工作区的默认容器？",
  confirmRecreate: "重建该容器？其临时状态将丢失。",
  confirmRemoveImage: "移除该镜像？使用它的容器需要用其他镜像重建。",
  confirmRebuildImage: "就地重建该镜像？",
  confirmRebuildAllImages: "按依赖顺序重建全部镜像（先基础镜像）？",
  confirmRemoveVolume: "移除该卷及其数据？",
  confirmSetSecret: "覆盖该机密的值？",
  confirmRemoveSecret: "移除该机密？使用它的容器需先移除注入。",
  confirmDetachSecret: "从容器上移除该机密环境变量？",
  mountsTitle: "挂载",
  addMount: "添加挂载",
  mountKind: "类型",
  mountProject: "项目",
  mountProjectPath: "项目路径",
  browse: "浏览…",
  browseTitle: "选择项目目录",
  browseSelect: "选择此目录",
  browseLoading: "加载中…",
  browseError: "无法读取此目录。",
  browseUnavailable: "此部署没有目录选择器。",
  browseHidden: "显示隐藏项",
  browseTruncated: "文件夹过多，仅显示开头部分。",
  browseOutsideRoot: "请选择项目根目录内的目录。",
  mountDestination: "目标路径",
  pathsTitle: "PATH 附加项",
  noPaths: "没有 PATH 附加项。",
  editPaths: "编辑 PATH 附加项",
  addPath: "要添加的路径",
  add: "添加",
  moveUp: "上移",
  moveDown: "下移",
  apply: "应用",
  dragToReorder: "拖动以重新排序",
  remountWaiting: "等待审批",
  remountApprove: "重新挂载并运行",
  remountReject: "拒绝",
  mountVolume: "卷",
  mountSecret: "机密",
  mountTmpfs: "tmpfs",
  mountAt: "位于",
  mountMode: "模式",
  readOnly: "只读",
  readWrite: "读写",
  mountReadOnlySuffix: "(只读)",
  mountReadWriteSuffix: "(读写)",
  remountReadOnly: "重新挂载为只读",
  remountReadWrite: "重新挂载为读写",
  confirmRemountReadOnly: "将该挂载重新挂载为只读并重建容器？",
  confirmRemountReadWrite: "将该挂载重新挂载为读写并重建容器？",
  confirmRemoveMount: "从容器中移除该挂载并重建容器？",
  cachesTitle: "软件包缓存",
  noCaches: "未配置软件包缓存。",
  cacheUsage: "{size} · {n} 个文件",
  cacheKeepLatest: "保留最新版本",
  confirmCacheKeepLatest: "移除较旧的缓存软件包版本？当前版本会保留。",
  cacheRemoveAll: "全部移除",
  confirmCacheRemoveAll: "移除所有缓存的软件包？下次构建会重新下载所需内容。",
  addContainer: "添加容器",
  invalidContainerName: "容器名称无效",
  containerNameTaken: "容器名称已存在",
  invalidName: "以字母或数字开头，仅可使用字母、数字、'.'、'_'、'-'（最长 64 个字符）。",
  invalidImageId:
    "以字母、数字或 '_' 开头，仅可使用字母、数字、'.'、'_'、'-'、'/'、':'（最长 128 个字符）。",
  terminalSignal: "信号 {signal}",
  terminalExitCode: "退出码 {code}",
  terminalNoExitCode: "无退出码",
  terminalRunning: "运行中",
  terminalFailed: "失败",
  terminalDone: "已完成",
  terminalNoOutput: "无输出",
  terminalCollapseAria: "收起输出",
  terminalExpandAria: "展开其余 {n} 行输出",
  terminalExpandRest: "… 其余 {n} 行",
  toolTitle_container_bash: "容器 Bash",
  toolTitle_container_exec: "容器执行",
  toolTitle_container_read: "读取容器文件",
  toolTitle_container_write: "写入容器文件",
  toolTitle_container_edit: "编辑容器文件",
  toolTitle_container_glob: "容器文件匹配",
  toolTitle_container_grep: "容器文件搜索",
  toolTitle_container_list: "列出容器",
  toolTitle_container_start: "启动容器",
  toolTitle_container_recreate: "重建容器",
  toolTitle_container_remove: "移除容器",
  toolTitle_container_mount_list: "列出挂载",
  toolTitle_container_mount_add: "添加挂载",
  toolTitle_container_mount_remove: "移除挂载",
  toolTitle_container_mount_update: "更改挂载模式",
  toolTitle_container_path_set: "设置 PATH 附加项",
  toolTitle_container_path_add: "添加 PATH 条目",
  toolTitle_container_path_remove: "移除 PATH 条目",
  toolTitle_container_secret_add: "注入机密",
  toolTitle_container_secret_remove: "移除机密注入",
  toolTitle_image_list: "列出镜像",
  toolTitle_image_get: "查看镜像",
  toolTitle_image_build: "构建镜像",
  toolTitle_image_rebuild: "重建镜像",
  toolTitle_image_rebuild_all: "重建全部镜像",
  toolTitle_image_remove: "移除镜像",
  toolTitle_volume_list: "列出卷",
  toolTitle_volume_create: "创建卷",
  toolTitle_volume_remove: "移除卷",
  toolTitle_secret_list: "列出机密",
  toolTitle_secret_create: "创建机密",
  toolTitle_secret_remove: "移除机密",
  toolTitle_daemon_start: "启动守护进程",
  toolTitle_daemon_list: "列出守护进程",
  toolTitle_daemon_logs: "守护进程日志",
  toolTitle_daemon_restart: "重启守护进程",
  toolTitle_daemon_stop: "停止守护进程",
  terminalTabTitle: "Podman 终端",
  terminalGuideTitle: "Podman 终端",
  terminalGuideDescription: "在工作区容器中打开 Shell",
  terminalShortcut: "新建 Podman 终端",
  terminalShortcutNoSession: "请先选择会话",
  terminalContainer: "容器",
  terminalShell: "Shell",
  terminalDefaultContainer: "默认容器",
  terminalStart: "启动",
  terminalConnect: "连接",
  terminalReconnect: "重新连接",
  terminalStatusConnecting: "正在连接…",
  terminalStatusRunning: "已连接",
  terminalStatusExited: "进程已退出（{code}）",
  terminalStatusDetached: "已在其他位置打开",
  terminalNoShells: "没有可用的 Shell",
  terminalShellsFailed: "读取 Shell 失败：{message}",
  terminalLoading: "正在加载…",
};

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap {
    "podman": ContainerPluginKey;
  }
}
