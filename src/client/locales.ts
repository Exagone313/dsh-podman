// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import type {} from "@deepseek-ai/dsh-client-ui-slots";

export const NS = "podman";

export type ContainerPluginKey =
  | "cardTitle"
  | "loading"
  | "versionMismatchMajor"
  | "versionMismatchMinor"
  | "versionIncompatible"
  | "versionCompatibleDifferent"
  | "stateReady"
  | "stateNotReady"
  | "stateUnknown"
  | "stateAbsent"
  | "valueMissing"
  | "columnComponent"
  | "columnState"
  | "columnVersion"
  | "columnCommit"
  | "versionsTitle"
  | "orchestrator"
  | "gateway"
  | "gatewayNotRunning"
  | "gatewayIncompatible"
  | "dsh"
  | "copyVersions"
  | "copied"
  | "copyFailed"
  | "copyWorkspaceId"
  | "reload"
  | "notice"
  | "defaultImage"
  | "noDefaultImage"
  | "defaultEnvironment"
  | "addMissingVars"
  | "applyTo"
  | "allContainers"
  | "variablesToAdd"
  | "addMissingVarsApply"
  | "gitIdentity"
  | "gitName"
  | "gitEmail"
  | "save"
  | "discard"
  | "unsavedChanges"
  | "stagedChanges"
  | "recreateContainer"
  | "updateContainer"
  | "confirmUpdate"
  | "discardChanges"
  | "discardChangesTitle"
  | "confirmDiscardChanges"
  | "containerNameReserved"
  | "invalidSecretLength"
  | "secretLengthHint"
  | "portPendingSuffix"
  | "portDuplicate"
  | "groupDefaultsTitle"
  | "groupStatusTitle"
  | "tabWorkspaces"
  | "tabImages"
  | "tabStorage"
  | "tabDefaults"
  | "tabStatus"
  | "settingsTabs"
  | "statusOverview"
  | "gatewayReady"
  | "gatewayNotReady"
  | "gatewayUnknown"
  | "edit"
  | "editContainerTitle"
  | "done"
  | "countImageOne"
  | "countImageMany"
  | "countVolumeOne"
  | "countVolumeMany"
  | "countSecretOne"
  | "countSecretMany"
  | "countCacheOne"
  | "countCacheMany"
  | "statusRunning"
  | "statusStopped"
  | "statusMissing"
  | "statusPulled"
  | "statusBuilt"
  | "countWorkspaceOne"
  | "countWorkspaceMany"
  | "countContainerOne"
  | "countContainerMany"
  | "countRunningContainerOne"
  | "countRunningContainerMany"
  | "countStoppedContainerOne"
  | "countStoppedContainerMany"
  | "countVersionOne"
  | "countVersionMany"
  | "orchestratorReady"
  | "orchestratorUnavailable"
  | "orchestratorNotReady"
  | "orchestratorUnknown"
  | "noWorkspaces"
  | "createContainer"
  | "containerName"
  | "image"
  | "copyImage"
  | "copyCreated"
  | "remove"
  | "removeWorkspace"
  | "confirmRemoveWorkspace"
  | "recreate"
  | "imageName"
  | "built"
  | "packages"
  | "noPackages"
  | "volumesTitle"
  | "noVolumes"
  | "createVolume"
  | "removeVolume"
  | "volumeName"
  | "secretsTitle"
  | "noSecrets"
  | "createSecret"
  | "secretName"
  | "secretCharset"
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
  | "baseImagesTitle"
  | "noBaseImages"
  | "customImagesTitle"
  | "noCustomImages"
  | "parentImage"
  | "cancel"
  | "removeTag"
  | "envTitle"
  | "envKey"
  | "copyEnvKey"
  | "envValue"
  | "copyEnvValue"
  | "addEnv"
  | "removeEnv"
  | "removeVariable"
  | "envNameRequired"
  | "envNameDuplicate"
  | "secretLength"
  | "containerSecretsTitle"
  | "addSecretEnv"
  | "secretEnvName"
  | "portsTitle"
  | "publishPort"
  | "unpublishPort"
  | "containerPort"
  | "copyContainerPort"
  | "hostPort"
  | "hostPortOptional"
  | "copyHostPort"
  | "protocol"
  | "copyProtocol"
  | "invalidPort"
  | "invalidHostPort"
  | "publishNeedsGateway"
  | "containerNotRunning"
  | "confirmUnpublishPort"
  | "none"
  | "unavailable"
  | "busy"
  | "confirmRemoveContainer"
  | "confirmRecreate"
  | "confirmRemoveImage"
  | "confirmRebuildImage"
  | "confirmRebuildAllImages"
  | "confirmRemoveVolume"
  | "confirmRemoveSecret"
  | "mountsTitle"
  | "addMount"
  | "mountKind"
  | "mountProject"
  | "mountProjectShort"
  | "mountPath"
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
  | "path"
  | "copyPathEntry"
  | "noPaths"
  | "editPaths"
  | "addPathEntry"
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
  | "copyMountPath"
  | "copyMountName"
  | "copyMountMode"
  | "readOnly"
  | "readWrite"
  | "mountReadOnlySuffix"
  | "mountReadWriteSuffix"
  | "confirmRemoveMount"
  | "removeContainerTitle"
  | "removeVolumeTitle"
  | "removeImageTitle"
  | "removeSecretTitle"
  | "removeMountTitle"
  | "defaultMountNotRemovable"
  | "rebuildImageTitle"
  | "rebuildAllImagesTitle"
  | "setSecretTitle"
  | "acknowledgeRemoveWorkspace"
  | "acknowledgeRebuildAllImages"
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
  | "toolTitle_container_publish_port"
  | "toolTitle_container_unpublish_port"
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

/**
 * Translate one key, interpolating `{name}` placeholders when given. Components
 * that build dialog copy declare this so they can name their subject.
 */
export type Translate = (
  key: ContainerPluginKey,
  params?: Record<string, string>,
) => string;

/**
 * One dictionary key with the placeholders its copy interpolates, so a
 * component can hand a message up to the footer that renders it without
 * translating it itself.
 */
export interface Translation {
  key: ContainerPluginKey;
  params?: Record<string, string>;
}

export const en: Record<ContainerPluginKey, string> = {
  cardTitle: "dsh-podman",
  versionMismatchMajor:
    "Image versions are incompatible. Update all three images (dsh, orchestrator, gateway) so they match.",
  versionMismatchMinor:
    "Some images are on different versions. Update the dsh, orchestrator and gateway images together.",
  versionIncompatible: "incompatible",
  versionCompatibleDifferent: "different versions",
  stateReady: "ready",
  stateNotReady: "not ready",
  stateUnknown: "unknown",
  stateAbsent: "absent",
  valueMissing: "—",
  columnComponent: "Component",
  columnState: "State",
  columnVersion: "Version",
  columnCommit: "Commit",
  versionsTitle: "Components",
  orchestrator: "dsh-podman-orchestrator",
  gateway: "dsh-podman-gateway",
  gatewayNotRunning: "not running",
  gatewayIncompatible: "incompatible",
  dsh: "dsh",
  copyVersions: "Copy versions",
  copied: "Copied",
  copyFailed: "Copy failed",
  copyWorkspaceId: "Copy workspace ID",
  reload: "Reload this view",
  notice: "Notice",
  defaultImage: "Default image",
  noDefaultImage: "No default image set",
  defaultEnvironment: "Default environment variables",
  addMissingVars: "Add missing variables to containers",
  applyTo: "Apply to",
  allContainers: "All containers",
  variablesToAdd: "Variables to add",
  addMissingVarsApply: "Add to {containers}",
  gitIdentity: "Git identity",
  gitName: "Name",
  gitEmail: "Email",
  save: "Save",
  discard: "Discard",
  unsavedChanges: "Unsaved changes",
  stagedChanges: "Changes to apply: {fields}",
  recreateContainer: "Recreate container",
  updateContainer: "Update container",
  confirmUpdate:
    "Apply these changes to container “{container}” in workspace “{workspace}”?",
  discardChanges: "Discard changes",
  discardChangesTitle: "Discard changes?",
  confirmDiscardChanges: "Close this dialog and discard your unsaved edits?",
  containerNameReserved:
    '"default" is reserved for the workspace\'s default container.',
  invalidSecretLength: "Length must be between 1 and 1024.",
  secretLengthHint: "Between 1 and 1024; empty uses 32.",
  portPendingSuffix: "(pending)",
  portDuplicate: "That port is already listed.",
  groupDefaultsTitle: "Defaults",
  groupStatusTitle: "Status",
  tabWorkspaces: "Workspaces",
  tabImages: "Images",
  tabStorage: "Storage",
  tabDefaults: "Defaults",
  tabStatus: "Status",
  settingsTabs: "Podman settings tabs",
  statusOverview: "Container status",
  gatewayReady: "gateway ready",
  gatewayNotReady: "gateway not ready",
  gatewayUnknown: "gateway unknown",
  edit: "Edit",
  editContainerTitle: "Edit container",
  done: "Done",
  countImageOne: "1 image",
  countImageMany: "{n} images",
  countVolumeOne: "1 volume",
  countVolumeMany: "{n} volumes",
  countSecretOne: "1 secret",
  countSecretMany: "{n} secrets",
  countCacheOne: "1 cache",
  countCacheMany: "{n} caches",
  statusRunning: "Running",
  statusStopped: "Stopped",
  statusMissing: "Missing",
  statusPulled: "Pulled",
  statusBuilt: "Built",
  countWorkspaceOne: "1 workspace",
  countWorkspaceMany: "{n} workspaces",
  countContainerOne: "1 container",
  countContainerMany: "{n} containers",
  countRunningContainerOne: "1 running container",
  countRunningContainerMany: "{n} running containers",
  countStoppedContainerOne: "1 stopped container",
  countStoppedContainerMany: "{n} stopped containers",
  countVersionOne: "1 version",
  countVersionMany: "{n} versions",
  orchestratorReady: "orchestrator ready",
  orchestratorUnavailable: "orchestrator unavailable",
  orchestratorNotReady: "orchestrator not ready",
  orchestratorUnknown: "orchestrator unknown",
  noWorkspaces: "No workspaces.",
  createContainer: "Create container",
  containerName: "Name",
  image: "Image",
  copyImage: "Copy image ID",
  copyCreated: "Copy creation time",
  remove: "Remove",
  removeWorkspace: "Remove containers",
  confirmRemoveWorkspace:
    "Remove the dsh-podman containers of workspace “{workspace}” (its pod)? The dsh workspace itself is untouched.",
  recreate: "Recreate",
  imageName: "Image name",
  built: "Built",
  packages: "Packages",
  noPackages: "No packages.",
  volumesTitle: "Volumes",
  noVolumes: "No volumes.",
  createVolume: "Create volume",
  removeVolume: "Remove",
  volumeName: "Volume name",
  secretsTitle: "Secrets",
  noSecrets: "No secrets.",
  createSecret: "Create secret",
  secretName: "Secret name",
  secretCharset: "Charset",
  setSecret: "New value",
  removeSecret: "Remove",
  removeImage: "Remove",
  rebuildImage: "Rebuild",
  rebuildAllImages: "Rebuild all images",
  buildImage: "Build custom image",
  build: "Build",
  buildImageTitle: "Build an image",
  pullImage: "Pull",
  setDefaultImage: "Set default",
  baseImagesTitle: "Base images",
  noBaseImages: "No base images.",
  customImagesTitle: "Custom images",
  noCustomImages: "No custom images.",
  parentImage: "Parent image",
  cancel: "Cancel",
  removeTag: "Remove",
  envTitle: "Environment variables",
  envKey: "Key",
  copyEnvKey: "Copy key {key}",
  envValue: "Value",
  copyEnvValue: "Copy the value of {key}",
  addEnv: "Add environment variable",
  removeEnv: "Remove",
  removeVariable: "Remove variable {key}",
  envNameRequired: "An environment variable name is required.",
  envNameDuplicate: "Variable name “{key}” is used twice.",
  secretLength: "Length",
  containerSecretsTitle: "Secret environment variables",
  addSecretEnv: "Add secret environment variable",
  secretEnvName: "Variable name",
  portsTitle: "Published ports",
  publishPort: "Publish port",
  unpublishPort: "Unpublish",
  containerPort: "Container port",
  copyContainerPort: "Copy container port {port}",
  hostPort: "Host port",
  hostPortOptional: "Host port (optional)",
  copyHostPort: "Copy host port {port}",
  protocol: "Protocol",
  copyProtocol: "Copy protocol {protocol}",
  invalidPort: "Port must be between 1 and 65535",
  invalidHostPort: "Host port must be between 1024 and 65535",
  publishNeedsGateway:
    "The dsh-podman gateway is not running; start the gateway Quadlet to publish ports.",
  containerNotRunning:
    "The container is not running; start it to publish a port.",
  confirmUnpublishPort:
    "Stop publishing {port}/{protocol}? The host port becomes unreachable.",
  none: "None",
  unavailable: "The container plugin is not available.",
  busy: "Working…",
  loading: "Loading the container plugin…",
  confirmRemoveContainer:
    "Remove container “{container}” from workspace “{workspace}”?",
  confirmRecreate:
    "Recreate container “{container}” in workspace “{workspace}”? Its ephemeral state is lost.",
  confirmRemoveImage:
    "Remove image “{image}”? Containers using it must be recreated from another image.",
  confirmRebuildImage: "Rebuild image “{image}” in place?",
  confirmRebuildAllImages:
    "Rebuild every image in dependency order (base first)?",
  confirmRemoveVolume: "Remove volume “{volume}” and its data?",
  confirmRemoveSecret:
    "Remove secret “{secret}”? Containers using it must drop it first.",
  mountsTitle: "Mounts",
  addMount: "Add mount",
  mountKind: "Kind",
  mountProject: "Project mount",
  mountProjectShort: "Project",
  mountPath: "Project path",
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
  pathsTitle: "PATH variable additions",
  path: "Path",
  copyPathEntry: "Copy PATH addition {path}",
  noPaths: "No PATH additions.",
  editPaths: "Edit PATH additions",
  addPathEntry: "Add entry",
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
  copyMountPath: "Copy mount path {path}",
  copyMountName: "Copy mount name {name}",
  copyMountMode: "Copy mount mode {mode}",
  readOnly: "Read-only",
  readWrite: "Read-write",
  mountReadOnlySuffix: "(ro)",
  mountReadWriteSuffix: "(rw)",
  confirmRemoveMount:
    "Remove mount {mount} from the container and recreate it?",
  removeContainerTitle: "Remove container",
  removeVolumeTitle: "Remove volume",
  removeImageTitle: "Remove image",
  removeSecretTitle: "Remove secret",
  removeMountTitle: "Remove mount",
  defaultMountNotRemovable:
    "The default container's main project mount cannot be removed.",
  rebuildImageTitle: "Rebuild image",
  rebuildAllImagesTitle: "Rebuild all images",
  setSecretTitle: "Set secret value",
  acknowledgeRemoveWorkspace:
    "I understand every container of this workspace is removed.",
  acknowledgeRebuildAllImages:
    "I understand every image is rebuilt, which can take a long time.",
  cachesTitle: "Package caches",
  noCaches: "No package caches.",
  cacheUsage: "{size} · {n} files",
  cacheKeepLatest: "Keep latest versions",
  confirmCacheKeepLatest:
    "Remove older cached package versions? Current versions are kept.",
  cacheRemoveAll: "Remove all",
  confirmCacheRemoveAll:
    "Remove every cached package? The next build re-downloads what it needs.",
  addContainer: "Add container",
  invalidContainerName:
    "Invalid container name. Start with a letter or digit; only letters, digits, '.', '_', '-' (max 64).",
  containerNameTaken: "Container name already exists",
  invalidName:
    "Start with a letter or digit; only letters, digits, '.', '_', '-' (max 64).",
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
  toolTitle_container_publish_port: "Publish port",
  toolTitle_container_unpublish_port: "Unpublish port",
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
  terminalTabTitle: "Terminal",
  terminalGuideTitle: "New terminal",
  terminalGuideDescription: "Run commands in the Session workspace",
  terminalShortcut: "New terminal",
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
  versionMismatchMajor:
    "镜像版本不兼容。请更新全部三个镜像（dsh、orchestrator、gateway），使其一致。",
  versionMismatchMinor:
    "部分镜像版本不同。请同时更新 dsh、orchestrator 与 gateway 镜像。",
  versionIncompatible: "不兼容",
  versionCompatibleDifferent: "版本不同",
  stateReady: "就绪",
  stateNotReady: "未就绪",
  stateUnknown: "未知",
  stateAbsent: "不存在",
  valueMissing: "—",
  columnComponent: "组件",
  columnState: "状态",
  columnVersion: "版本",
  columnCommit: "提交",
  versionsTitle: "组件",
  orchestrator: "dsh-podman-orchestrator",
  gateway: "dsh-podman-gateway",
  gatewayNotRunning: "未运行",
  gatewayIncompatible: "版本不兼容",
  dsh: "dsh",
  copyVersions: "复制版本",
  copied: "已复制",
  copyFailed: "复制失败",
  copyWorkspaceId: "复制工作区 ID",
  reload: "刷新此视图",
  notice: "提示",
  defaultImage: "默认镜像",
  noDefaultImage: "未设置默认镜像",
  defaultEnvironment: "默认环境变量",
  addMissingVars: "为容器补上缺失的变量",
  applyTo: "应用到",
  allContainers: "所有容器",
  variablesToAdd: "将添加的变量",
  addMissingVarsApply: "添加到 {containers}",
  gitIdentity: "Git 身份",
  gitName: "姓名",
  gitEmail: "邮箱",
  save: "保存",
  discard: "放弃",
  unsavedChanges: "有未保存的更改",
  stagedChanges: "将应用的更改：{fields}",
  recreateContainer: "重建容器",
  updateContainer: "更新容器",
  confirmUpdate: "将更改应用到工作区“{workspace}”中的容器“{container}”？",
  discardChanges: "放弃更改",
  discardChangesTitle: "放弃更改？",
  confirmDiscardChanges: "关闭此对话框并放弃未保存的编辑？",
  containerNameReserved: "“default”是工作区默认容器的保留名称。",
  invalidSecretLength: "长度必须在 1 到 1024 之间。",
  secretLengthHint: "1 到 1024；留空使用 32。",
  portPendingSuffix: "（待发布）",
  portDuplicate: "该端口已在列表中。",
  groupDefaultsTitle: "默认设置",
  groupStatusTitle: "状态",
  tabWorkspaces: "工作区",
  tabImages: "镜像",
  tabStorage: "存储",
  tabDefaults: "默认设置",
  tabStatus: "状态",
  settingsTabs: "Podman 设置标签页",
  statusOverview: "容器状态",
  gatewayReady: "gateway 就绪",
  gatewayNotReady: "gateway 未就绪",
  gatewayUnknown: "gateway 状态未知",
  edit: "编辑",
  editContainerTitle: "编辑容器",
  done: "完成",
  countImageOne: "1 个镜像",
  countImageMany: "{n} 个镜像",
  countVolumeOne: "1 个卷",
  countVolumeMany: "{n} 个卷",
  countSecretOne: "1 个机密",
  countSecretMany: "{n} 个机密",
  countCacheOne: "1 个缓存",
  countCacheMany: "{n} 个缓存",
  statusRunning: "运行中",
  statusStopped: "已停止",
  statusMissing: "缺失",
  statusPulled: "已拉取",
  statusBuilt: "已构建",
  countWorkspaceOne: "1 个工作区",
  countWorkspaceMany: "{n} 个工作区",
  countContainerOne: "1 个容器",
  countContainerMany: "{n} 个容器",
  countRunningContainerOne: "1 个运行中容器",
  countRunningContainerMany: "{n} 个运行中容器",
  countStoppedContainerOne: "1 个已停止容器",
  countStoppedContainerMany: "{n} 个已停止容器",
  countVersionOne: "1 个版本",
  countVersionMany: "{n} 个版本",
  orchestratorReady: "orchestrator 就绪",
  orchestratorUnavailable: "orchestrator 不可用",
  orchestratorNotReady: "orchestrator 未就绪",
  orchestratorUnknown: "orchestrator 状态未知",
  noWorkspaces: "无工作区。",
  createContainer: "创建容器",
  containerName: "名称",
  image: "镜像",
  copyImage: "复制镜像 ID",
  copyCreated: "复制创建时间",
  remove: "移除",
  removeWorkspace: "移除容器",
  confirmRemoveWorkspace:
    "移除工作区“{workspace}”的 dsh-podman 容器（其 pod）？dsh 工作区本身不受影响。",
  recreate: "重建",
  imageName: "镜像名称",
  built: "构建",
  packages: "软件包",
  noPackages: "无软件包。",
  volumesTitle: "卷",
  noVolumes: "无卷。",
  createVolume: "创建卷",
  removeVolume: "移除",
  volumeName: "卷名称",
  secretsTitle: "机密",
  noSecrets: "无机密。",
  createSecret: "创建机密",
  secretName: "机密名称",
  secretCharset: "字符集",
  setSecret: "新值",
  removeSecret: "移除",
  removeImage: "移除",
  rebuildImage: "重建",
  rebuildAllImages: "重建全部镜像",
  buildImage: "构建自定义镜像",
  build: "构建",
  buildImageTitle: "构建镜像",
  pullImage: "拉取",
  setDefaultImage: "设为默认",
  baseImagesTitle: "基础镜像",
  noBaseImages: "无基础镜像。",
  customImagesTitle: "自定义镜像",
  noCustomImages: "无自定义镜像。",
  parentImage: "父镜像",
  cancel: "取消",
  removeTag: "移除",
  envTitle: "环境变量",
  envKey: "键",
  copyEnvKey: "复制键 {key}",
  envValue: "值",
  copyEnvValue: "复制 {key} 的值",
  addEnv: "添加环境变量",
  removeEnv: "移除",
  removeVariable: "移除变量 {key}",
  envNameRequired: "环境变量名称为必填项。",
  envNameDuplicate: "变量名称“{key}”使用了两次。",
  secretLength: "长度",
  containerSecretsTitle: "机密环境变量",
  addSecretEnv: "添加机密环境变量",
  secretEnvName: "变量名",
  portsTitle: "已发布端口",
  publishPort: "发布端口",
  unpublishPort: "取消发布",
  containerPort: "容器端口",
  copyContainerPort: "复制容器端口 {port}",
  hostPort: "主机端口",
  hostPortOptional: "主机端口（可选）",
  copyHostPort: "复制主机端口 {port}",
  protocol: "协议",
  copyProtocol: "复制协议 {protocol}",
  invalidPort: "端口必须在 1 到 65535 之间",
  invalidHostPort: "主机端口必须在 1024 到 65535 之间",
  publishNeedsGateway:
    "dsh-podman gateway 未运行；请启动 gateway Quadlet 后再发布端口。",
  containerNotRunning: "容器未运行；请先启动容器再发布端口。",
  confirmUnpublishPort: "停止发布 {port}/{protocol}？该主机端口将不再可访问。",
  none: "无",
  unavailable: "容器插件不可用。",
  busy: "处理中…",
  loading: "正在加载容器插件…",
  confirmRemoveContainer: "移除工作区“{workspace}”中的容器“{container}”？",
  confirmRecreate:
    "重建工作区“{workspace}”中的容器“{container}”？其临时状态将丢失。",
  confirmRemoveImage: "移除镜像“{image}”？使用它的容器需要用其他镜像重建。",
  confirmRebuildImage: "就地重建镜像“{image}”？",
  confirmRebuildAllImages: "按依赖顺序重建全部镜像（先基础镜像）？",
  confirmRemoveVolume: "移除卷“{volume}”及其数据？",
  confirmRemoveSecret: "移除机密“{secret}”？使用它的容器需先移除注入。",
  mountsTitle: "挂载",
  addMount: "添加挂载",
  mountKind: "类型",
  mountProject: "项目挂载",
  mountProjectShort: "项目",
  mountPath: "项目路径",
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
  pathsTitle: "PATH 变量附加项",
  path: "路径",
  copyPathEntry: "复制 PATH 变量附加项 {path}",
  noPaths: "无 PATH 附加项。",
  editPaths: "编辑 PATH 附加项",
  addPathEntry: "添加条目",
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
  copyMountPath: "复制挂载路径 {path}",
  copyMountName: "复制挂载名称 {name}",
  copyMountMode: "复制挂载模式 {mode}",
  readOnly: "只读",
  readWrite: "读写",
  mountReadOnlySuffix: "(只读)",
  mountReadWriteSuffix: "(读写)",
  confirmRemoveMount: "从容器中移除挂载 {mount} 并重建容器？",
  removeContainerTitle: "移除容器",
  removeVolumeTitle: "移除卷",
  removeImageTitle: "移除镜像",
  removeSecretTitle: "移除机密",
  removeMountTitle: "移除挂载",
  defaultMountNotRemovable: "默认容器的主项目挂载无法移除。",
  rebuildImageTitle: "重建镜像",
  rebuildAllImagesTitle: "重建全部镜像",
  setSecretTitle: "设置机密值",
  acknowledgeRemoveWorkspace: "我明白这会移除该工作区的所有容器。",
  acknowledgeRebuildAllImages: "我明白这会重建全部镜像，可能需要较长时间。",
  cachesTitle: "软件包缓存",
  noCaches: "无软件包缓存。",
  cacheUsage: "{size} · {n} 个文件",
  cacheKeepLatest: "保留最新版本",
  confirmCacheKeepLatest: "移除较旧的缓存软件包版本？当前版本会保留。",
  cacheRemoveAll: "全部移除",
  confirmCacheRemoveAll: "移除所有缓存的软件包？下次构建会重新下载所需内容。",
  addContainer: "添加容器",
  invalidContainerName:
    "容器名称无效。以字母或数字开头，仅可使用字母、数字、'.'、'_'、'-'（最长 64 个字符）。",
  containerNameTaken: "容器名称已存在",
  invalidName:
    "以字母或数字开头，仅可使用字母、数字、'.'、'_'、'-'（最长 64 个字符）。",
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
  toolTitle_container_publish_port: "发布端口",
  toolTitle_container_unpublish_port: "取消发布端口",
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
  terminalTabTitle: "终端",
  terminalGuideTitle: "新建终端",
  terminalGuideDescription: "在会话工作区运行命令",
  terminalShortcut: "新建终端",
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
