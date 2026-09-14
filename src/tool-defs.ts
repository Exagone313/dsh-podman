// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { containerBashParameters, containerEditParameters, containerExecParameters, containerGlobParameters, containerGrepParameters, containerListParameters, containerMountAddParameters, containerMountListParameters, containerMountRemoveParameters, containerMountUpdateParameters, containerReadParameters, containerRecreateParameters, containerRemoveParameters, containerSecretAddParameters, containerSecretRemoveParameters, containerStartParameters, containerWriteParameters, daemonListParameters, daemonLogsParameters, daemonRestartParameters, daemonStartParameters, daemonStopParameters, imageBuildParameters, imageGetParameters, imageListParameters, imageRebuildAllParameters, imageRebuildParameters, imageRemoveParameters, secretCreateParameters, secretListParameters, secretRemoveParameters, volumeCreateParameters, volumeListParameters, volumeRemoveParameters } from "./tool-params.js";

export function defineTool<T>(definition: T): T {
  return definition;
}

export const toolOutput = {
  schema: { type: "string" },
  render: (_args: unknown, value: string) => [{ type: "text", text: value }],
};

export interface ToolDefinition {
  name: string;
  parameters: {
    type: string;
    properties: Record<string, any>;
    required: readonly string[];
  };
  approval?: boolean;
  approvalWhen?: (args: Record<string, unknown>) => boolean;
}

export const TOOLS: ToolDefinition[] = [
  { name: "image_list", parameters: imageListParameters },
  { name: "image_get", parameters: imageGetParameters },
  {
    name: "image_build",
    parameters: imageBuildParameters,
    approval: true,
  },
  { name: "image_rebuild", parameters: imageRebuildParameters, approval: true },
  {
    name: "image_rebuild_all",
    parameters: imageRebuildAllParameters,
    approval: true,
  },
  { name: "image_remove", parameters: imageRemoveParameters, approval: true },
  { name: "container_list", parameters: containerListParameters },
  {
    name: "container_start",
    parameters: containerStartParameters,
    approvalWhen: (args) =>
      Array.isArray(args.mounts) && args.mounts.length > 0,
  },
  {
    name: "container_recreate",
    parameters: containerRecreateParameters,
    approval: true,
  },
  { name: "container_remove", parameters: containerRemoveParameters, approval: true },
  { name: "container_bash", parameters: containerBashParameters },
  { name: "container_exec", parameters: containerExecParameters },
  { name: "container_read", parameters: containerReadParameters },
  { name: "container_write", parameters: containerWriteParameters },
  { name: "container_edit", parameters: containerEditParameters },
  { name: "container_glob", parameters: containerGlobParameters },
  { name: "container_grep", parameters: containerGrepParameters },
  {
    name: "container_mount_list",
    parameters: containerMountListParameters,
  },
  {
    name: "container_mount_add",
    parameters: containerMountAddParameters,
    approval: true,
  },
  {
    name: "container_mount_remove",
    parameters: containerMountRemoveParameters,
    approval: true,
  },
  {
    name: "container_mount_update",
    parameters: containerMountUpdateParameters,
    approval: true,
  },
  { name: "volume_list", parameters: volumeListParameters },
  { name: "volume_create", parameters: volumeCreateParameters },
  { name: "volume_remove", parameters: volumeRemoveParameters, approval: true },
  { name: "secret_list", parameters: secretListParameters },
  {
    name: "secret_create",
    parameters: secretCreateParameters,
  },
  {
    name: "secret_remove",
    parameters: secretRemoveParameters,
    approval: true,
  },
  {
    name: "container_secret_add",
    parameters: containerSecretAddParameters,
    approval: true,
  },
  {
    name: "container_secret_remove",
    parameters: containerSecretRemoveParameters,
    approval: true,
  },
  { name: "daemon_start", parameters: daemonStartParameters },
  { name: "daemon_list", parameters: daemonListParameters },
  { name: "daemon_stop", parameters: daemonStopParameters },
  { name: "daemon_restart", parameters: daemonRestartParameters },
  { name: "daemon_logs", parameters: daemonLogsParameters },
];

export const TOOL_DESCRIPTIONS: Record<string, string> = {
  image_list:
    "List the images of the current workspace by short name, base images first, then custom images. Base images are managed from the settings.",
  image_get: "Get details about a specific image by its short name.",
  image_build:
    "Build a new custom image from a parent image by short name (a base like archlinux/ubuntu/alpine, or an existing custom image) and a set of packages. Base images themselves are managed from the settings. Requires approval: building installs packages system-wide into a container image.",
  image_rebuild:
    "Rebuild an existing custom image by short name. Base images are rebuilt from the settings. Requires approval: rebuilding replaces the current image content.",
  image_rebuild_all:
    "Rebuild every stored image in dependency order (base first), skipping any image whose rebuild fails and its dependents. Requires approval: rebuilding replaces the images' contents.",
  image_remove:
    "Remove a built custom image by short name. Base images are managed from the settings. Requires approval: removing deletes the image so containers using it must be recreated from another image.",
  container_list:
    "List the containers of the current workspace, including the default container that is started on demand.",
  container_start:
    "Start a container in the current workspace. Named containers are created with exactly the mounts you pass — the project directory is not mounted automatically. The default container always keeps its workspace project mount.",
  container_recreate:
    "Recreate a container in the current workspace, keeping its current image when no image is given, optionally with new project mounts. Requires approval: recreating replaces the running container.",
  container_remove: "Remove a container from the current workspace.",
  container_bash:
    "Run a shell command inside a container of the current workspace. Defaults to the session working directory when it is mounted; pass workdir to override.",
  container_exec:
    "Run a program inside a container of the current workspace. Defaults to the session working directory when it is mounted; pass cwd to override.",
  container_read: "Read a file inside a container of the current workspace.",
  container_write: "Write a file inside a container of the current workspace.",
  container_edit: "Edit a file inside a container of the current workspace.",
  container_glob:
    "List files inside a container of the current workspace matching a glob pattern. A pattern with no \"/\" matches basenames at any depth. Results are files only, include hidden and ignored files, and exclude VCS metadata directories. Defaults to the session working directory when it is mounted; pass path to override.",
  container_grep:
    "Search file contents inside a container of the current workspace. Defaults to the session working directory when it is mounted; pass cwd to override.",
  container_mount_list:
    "List the mounts of a container in the current workspace, with the exact kind, project, volume, secret, and destination values to pass to container_mount_remove.",
  container_mount_add:
    "Add a mount to a container in the current workspace: a project bind (project, a path under the projects root), a tmpfs, a named volume, or a secret, selected by kind (default project). Recreates the container, terminating its running processes; bind-mounted volume data persists. Requires approval: adding a mount changes the container filesystem view.",
  container_mount_remove:
    "Remove a mount from a container in the current workspace. Identify it by kind plus its own handle: project for a project mount, volume for a named volume, secret for a secret, and destination for tmpfs. A handle that matches more than one mount is rejected, so pass destination as well when a volume or secret is mounted more than once; copy the exact values from container_mount_list. Recreates the container, terminating its running processes; bind-mounted volume data persists. Requires approval: removing a mount changes the container filesystem view.",
  container_mount_update:
    "Change the mode of an existing project or volume mount in the current workspace (read_only or read_write). Identify it by kind plus its own handle, exactly like container_mount_remove; a handle that matches more than one mount is rejected. The default container's workspace project mount can be remounted read-only. Recreates the container, terminating its running processes; bind-mounted volume data persists. Requires approval: changing a mount's mode changes the container filesystem view.",
  volume_list:
    "List the named volumes available to the current workspace.",
  volume_create: "Create a named volume in the current workspace.",
  volume_remove:
    "Remove a named volume from the current workspace. Refused while a container still mounts it; detach the mount first.",
  secret_list:
    "List the named secrets available to the current workspace (values are never exposed).",
  secret_create:
    "Create a secret with an orchestrator-generated random value (the value is never exposed).",
  secret_remove:
    "Remove a named secret from the current workspace. Refused while a container mounts it or attaches it as an environment variable; detach it first. Requires approval: removing deletes the secret.",
  container_secret_add:
    "Inject a named secret into a container as an environment variable. Recreates the container, terminating its running processes; bind-mounted volume data persists. Requires approval: exposing a secret to a container changes what it can read.",
  container_secret_remove:
    "Stop injecting a named secret into a container environment variable. Recreates the container, terminating its running processes; bind-mounted volume data persists. Requires approval: removing a secret exposure changes what the container can read.",
  daemon_start:
    "Start a daemon inside a container of the current workspace. Optionally run it as a specific uid/gid (with optional supplementary groups). The daemon inherits the container's environment by default; pass inheritEnv=false to give it only PATH, HOME, and env. Defaults to the session working directory when it is mounted; pass cwd to override. An existing daemon with the same name is stopped and replaced.",
  daemon_list:
    "List the daemons running inside a container of the current workspace. Daemons live in the container's guest agent and do not survive a container recreate.",
  daemon_stop: "Stop a daemon inside a container of the current workspace.",
  daemon_restart:
    "Restart a daemon inside a container of the current workspace.",
  daemon_logs:
    "Read the captured logs of a daemon inside a container of the current workspace.",
};

// UI title and icon category per tool, used by the host presenters so a UI can
// label a call meaningfully instead of showing the raw tool name.
export const TOOL_UI: Record<string, { title: string; kind: string }> = {
  image_list: { title: "List images", kind: "search" },
  image_get: { title: "Inspect image", kind: "read" },
  image_build: { title: "Build image", kind: "execute" },
  image_rebuild: { title: "Rebuild image", kind: "execute" },
  image_rebuild_all: { title: "Rebuild all images", kind: "execute" },
  image_remove: { title: "Remove image", kind: "delete" },
  container_list: { title: "List containers", kind: "search" },
  container_start: { title: "Start container", kind: "execute" },
  container_recreate: { title: "Recreate container", kind: "execute" },
  container_remove: { title: "Remove container", kind: "delete" },
  container_bash: { title: "Container bash", kind: "execute" },
  container_exec: { title: "Container exec", kind: "execute" },
  container_read: { title: "Container read", kind: "read" },
  container_write: { title: "Container write", kind: "edit" },
  container_edit: { title: "Container edit", kind: "edit" },
  container_glob: { title: "Container glob", kind: "search" },
  container_grep: { title: "Container grep", kind: "search" },
  container_mount_list: { title: "List mounts", kind: "read" },
  container_mount_add: { title: "Add mount", kind: "edit" },
  container_mount_remove: { title: "Remove mount", kind: "delete" },
  container_mount_update: { title: "Change mount mode", kind: "edit" },
  volume_list: { title: "List volumes", kind: "search" },
  volume_create: { title: "Create volume", kind: "execute" },
  volume_remove: { title: "Remove volume", kind: "delete" },
  secret_list: { title: "List secrets", kind: "search" },
  secret_create: { title: "Create secret", kind: "execute" },
  secret_remove: { title: "Remove secret", kind: "delete" },
  container_secret_add: { title: "Attach secret", kind: "edit" },
  container_secret_remove: { title: "Detach secret", kind: "delete" },
  daemon_start: { title: "Start daemon", kind: "execute" },
  daemon_list: { title: "List daemons", kind: "read" },
  daemon_stop: { title: "Stop daemon", kind: "delete" },
  daemon_restart: { title: "Restart daemon", kind: "execute" },
  daemon_logs: { title: "Daemon logs", kind: "read" },
};
