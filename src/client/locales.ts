// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import type {} from "@deepseek-ai/dsh-client-ui-slots";

export const NS = "podman";

export type ContainerPluginKey =
  | "cardTitle"
  | "cardDescription"
  | "reload"
  | "reloading"
  | "notice"
  | "configTitle"
  | "defaultImage"
  | "socketsRoot"
  | "projectsRoot"
  | "defaultImageHint"
  | "save"
  | "discard"
  | "workspacesTitle"
  | "noContainers"
  | "createContainer"
  | "containersTitle"
  | "containerName"
  | "workspace"
  | "image"
  | "status"
  | "created"
  | "projects"
  | "remove"
  | "recreate"
  | "recreateWithImage"
  | "imagesTitle"
  | "imageId"
  | "baseImage"
  | "imageTag"
  | "builtAt"
  | "packages"
  | "volumesTitle"
  | "createVolume"
  | "removeVolume"
  | "secretsTitle"
  | "createSecret"
  | "setSecret"
  | "removeSecret"
  | "removeImage"
  | "none"
  | "unavailable"
  | "busy";

export const en: Record<ContainerPluginKey, string> = {
  cardTitle: "Podman",
  cardDescription: "Manage the guest containers and their images.",
  reload: "Reload this view",
  reloading: "Reloading…",
  notice: "Notice",
  configTitle: "Configuration",
  defaultImage: "Default image",
  socketsRoot: "Sockets root",
  projectsRoot: "Projects root",
  defaultImageHint: "Image used when a workspace has no image of its own.",
  save: "Save",
  discard: "Discard",
  workspacesTitle: "Workspaces",
  noContainers: "This workspace has no containers yet.",
  createContainer: "Create container",
  containersTitle: "Containers",
  containerName: "Container",
  workspace: "Workspace",
  image: "Image",
  status: "Status",
  created: "Created",
  projects: "Projects",
  remove: "Remove",
  recreate: "Recreate",
  recreateWithImage: "Recreate with image",
  imagesTitle: "Images",
  imageId: "Image ID",
  baseImage: "Base image",
  imageTag: "Tag",
  builtAt: "Built at",
  packages: "Packages",
  volumesTitle: "Volumes",
  createVolume: "Create volume",
  removeVolume: "Remove",
  secretsTitle: "Secrets",
  createSecret: "Create secret",
  setSecret: "Set value",
  removeSecret: "Remove",
  removeImage: "Remove",
  none: "None",
  unavailable: "The container plugin is not available.",
  busy: "Working…",
};

export const zh: Record<ContainerPluginKey, string> = {
  cardTitle: "Podman",
  cardDescription: "管理工作区容器及其镜像。",
  reload: "刷新此视图",
  reloading: "刷新中…",
  notice: "提示",
  configTitle: "配置",
  defaultImage: "默认镜像",
  socketsRoot: "套接字根目录",
  projectsRoot: "项目根目录",
  defaultImageHint: "工作区没有自带镜像时使用的镜像。",
  save: "保存",
  discard: "放弃",
  workspacesTitle: "工作区",
  noContainers: "该工作区还没有容器。",
  createContainer: "创建容器",
  containersTitle: "容器",
  containerName: "容器",
  workspace: "工作区",
  image: "镜像",
  status: "状态",
  created: "创建时间",
  projects: "项目",
  remove: "移除",
  recreate: "重建",
  recreateWithImage: "使用镜像重建",
  imagesTitle: "镜像",
  imageId: "镜像 ID",
  baseImage: "基础镜像",
  imageTag: "标签",
  builtAt: "构建时间",
  packages: "软件包",
  volumesTitle: "卷",
  createVolume: "创建卷",
  removeVolume: "移除",
  secretsTitle: "机密",
  createSecret: "创建机密",
  setSecret: "设置值",
  removeSecret: "移除",
  removeImage: "移除",
  none: "无",
  unavailable: "容器插件不可用。",
  busy: "处理中…",
};

declare module "@deepseek-ai/dsh-client-ui-slots" {
  interface LocaleNamespaceMap {
    "podman": ContainerPluginKey;
  }
}
