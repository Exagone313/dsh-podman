// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { apply, inject, name } from "./index.js";
import { metadata } from "./workspace-binding.js";

export function defineTool<T>(definition: T): T {
  return definition;
}

export const toolOutput = {
  schema: { type: "string" },
  render: (_args: unknown, value: string) => [{ type: "text", text: value }],
};

const containerParam = {
  type: "string",
  description:
    'Logical container name; use "default" for the default workspace container.',
};

const imageIdParam = { type: "string", description: "Image short name." };

const packageListParam = {
  type: "array",
  items: { type: "string" },
  description: "Package names to install.",
};

const mountModeParam = {
  type: "string",
  enum: ["read_only", "read_write"],
  description:
    "Read mode of the mount. Defaults to read_only, except for tmpfs mounts, which are always read_write.",
};

const mountKindParam = {
  type: "string",
  enum: ["project", "tmpfs", "volume", "secret"],
  description:
    "Kind of mount: a project bind, a tmpfs, a named volume, or a named secret.",
};

const projectMountItemParam = {
  type: "object",
  additionalProperties: false,
  properties: {
    project: { type: "string", description: "Project name to mount." },
    mode: mountModeParam,
    path: { type: "string", description: "Path within the project to mount." },
    destination: {
      type: "string",
      description:
        "Destination path inside the container (volume, tmpfs, and secret mounts only; project mounts always mount at their project root).",
    },
    kind: mountKindParam,
    volume: { type: "string", description: "Volume name to mount." },
    secret: { type: "string", description: "Secret name to mount as a file." },
  },
  required: [],
};

const mountsParam = {
  type: "array",
  items: projectMountItemParam,
  description: "Optional project mounts to apply.",
};

export const envParam = {
  type: "object",
  additionalProperties: { type: "string" },
  description: "Environment variables.",
};

const descriptionParam = {
  type: "string",
  description:
    "Clear, concise description of what this command does in active voice, 5-10 words.",
};

const timeoutMsParam = {
  type: "number",
  description:
    "Timeout in milliseconds; the command is killed when it expires.",
};

export const imageListParameters = {
  type: "object",
  properties: {},
  required: [] as string[],
};

export const imageGetParameters = {
  type: "object",
  properties: { imageId: imageIdParam },
  required: ["imageId"],
};

export const imageBuildParameters = {
  type: "object",
  properties: {
    imageId: imageIdParam,
    parent: {
      type: "string",
      description:
        "Short name of the parent image (a base like archlinux/ubuntu/alpine, or an existing custom image).",
    },
    packages: packageListParam,
  },
  required: ["imageId", "parent", "packages"],
};

export const imageRebuildParameters = {
  type: "object",
  properties: { imageId: imageIdParam },
  required: ["imageId"],
};

export const imageRebuildAllParameters = {
  type: "object",
  properties: {},
  required: [] as string[],
};

export const imageRemoveParameters = {
  type: "object",
  properties: { imageId: imageIdParam },
  required: ["imageId"],
};

export const containerListParameters = {
  type: "object",
  properties: {},
  required: [] as string[],
};

export const containerStartParameters = {
  type: "object",
  properties: {
    container: containerParam,
    image: {
      type: "string",
      description: "Image short name (base or custom).",
    },
    mounts: mountsParam,
    env: envParam,
    secretEnv: { type: "object", additionalProperties: { type: "string" }, description: "Secret environment variables (env var name to secret short name)." },
  },
  required: ["container"],
};

export const containerRecreateParameters = {
  type: "object",
  properties: {
    container: containerParam,
    image: {
      type: "string",
      description:
        "Image ID to recreate the container with; defaults to the container's current image.",
    },
    mounts: mountsParam,
    env: envParam,
    secretEnv: { type: "object", additionalProperties: { type: "string" }, description: "Secret environment variables (env var name to secret short name)." },
  },
  required: ["container"],
};

export const containerMountListParameters = {
  type: "object",
  properties: { container: containerParam },
  required: ["container"],
};

export const containerMountAddParameters = {
  type: "object",
  properties: {
    container: containerParam,
    kind: mountKindParam,
    project: { type: "string", description: "Project name to mount." },
    path: { type: "string", description: "Path within the project to mount." },
    destination: {
      type: "string",
      description:
        "Destination path inside the container (volume, tmpfs, and secret mounts only; project mounts always mount at their project root).",
    },
    mode: mountModeParam,
    volume: { type: "string", description: "Named volume to mount." },
    secret: { type: "string", description: "Named secret to mount." },
  },
  required: ["container"],
};

export const containerMountRemoveParameters = {
  type: "object",
  properties: {
    container: containerParam,
    kind: mountKindParam,
    project: { type: "string", description: "Project name to unmount." },
    path: { type: "string", description: "Path within the project to unmount." },
    volume: { type: "string", description: "Named volume to unmount." },
    secret: { type: "string", description: "Named secret to unmount." },
    destination: {
      type: "string",
      description:
        "Destination path inside the container (volume, tmpfs, and secret mounts only; project mounts are identified by project and path).",
    },
  },
  required: ["container"],
};

export const containerRemoveParameters = {
  type: "object",
  properties: { container: containerParam },
  required: ["container"],
};

export const volumeListParameters = {
  type: "object",
  properties: {},
  required: [] as string[],
};

export const volumeCreateParameters = {
  type: "object",
  properties: { name: { type: "string", description: "Volume name to create." } },
  required: ["name"],
};

export const volumeRemoveParameters = {
  type: "object",
  properties: { name: { type: "string", description: "Volume name to remove." } },
  required: ["name"],
};

export const secretListParameters = {
  type: "object",
  properties: {},
  required: [] as string[],
};

export const secretCreateParameters = {
  type: "object",
  properties: {
    name: { type: "string", description: "Secret name to create." },
    length: {
      type: "integer",
      minimum: 1,
      description: "Length of the generated random value (default 32).",
    },
    charset: {
      type: "string",
      enum: ["alphanumeric", "hex", "base64url"],
      description: "Character set for the generated random value.",
    },
  },
  required: ["name"],
};

export const secretRemoveParameters = {
  type: "object",
  properties: { name: { type: "string", description: "Secret name to remove." } },
  required: ["name"],
};

export const containerSecretAddParameters = {
  type: "object",
  properties: {
    container: containerParam,
    env: { type: "string", description: "Environment variable name." },
    secret: { type: "string", description: "Named secret to inject." },
  },
  required: ["container", "env", "secret"],
};

export const containerSecretRemoveParameters = {
  type: "object",
  properties: {
    container: containerParam,
    env: { type: "string", description: "Environment variable name." },
  },
  required: ["container", "env"],
};

export const containerBashParameters = {
  type: "object",
  properties: {
    container: containerParam,
    command: { type: "string", description: "The shell command to execute." },
    description: descriptionParam,
    workdir: { type: "string", description: "Working directory." },
    timeoutMs: timeoutMsParam,
    env: envParam,
  },
  required: ["container", "command", "description"],
};

export const containerExecParameters = {
  type: "object",
  properties: {
    container: containerParam,
    argv: {
      type: "array",
      items: { type: "string" },
      description: "The program and arguments to execute.",
    },
    description: descriptionParam,
    workdir: { type: "string", description: "Working directory." },
    timeoutMs: timeoutMsParam,
    env: envParam,
  },
  required: ["container", "argv", "description"],
};

export const containerReadParameters = {
  type: "object",
  properties: {
    container: containerParam,
    file_path: {
      type: "string",
      description: "Path to read, resolved against the session working directory.",
    },
    offset: {
      type: "integer",
      minimum: 1,
      description: "1-based first line to return. Defaults to 1.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      description: "Maximum number of lines to return. Defaults to 2000.",
    },
  },
  required: ["container", "file_path"],
};

export const containerWriteParameters = {
  type: "object",
  properties: {
    container: containerParam,
    file_path: {
      type: "string",
      description: "Path to write, resolved against the session working directory.",
    },
    content: { type: "string", description: "Content to write." },
    create: { type: "boolean", description: "Create if absent (default true)." },
    truncate: {
      type: "boolean",
      description: "Truncate before writing (default true).",
    },
  },
  required: ["container", "file_path", "content"],
};

export const containerEditParameters = {
  type: "object",
  properties: {
    container: containerParam,
    file_path: {
      type: "string",
      description: "Path to edit, resolved against the session working directory.",
    },
    old_string: { type: "string", description: "Literal text to replace." },
    new_string: { type: "string", description: "Replacement text." },
    replace_all: {
      type: "boolean",
      description:
        "Replace every occurrence. Defaults to false; when false, old_string must appear exactly once.",
    },
  },
  required: ["container", "file_path", "old_string", "new_string"],
};

export const containerGlobParameters = {
  type: "object",
  properties: {
    container: containerParam,
    pattern: { type: "string", description: "File pattern." },
    path: {
      type: "string",
      description:
        "Directory to search in. Defaults to the session working directory.",
    },
  },
  required: ["container", "pattern"],
};

export const containerGrepParameters = {
  type: "object",
  properties: {
    container: containerParam,
    pattern: { type: "string", description: "Regex to search for." },
    path: {
      type: "string",
      description:
        "File or directory to search. Defaults to the session working directory.",
    },
    include: {
      type: "string",
      description:
        'One glob filter for which files to search (e.g. "*.ts").',
    },
  },
  required: ["container", "pattern"],
};

export const daemonStartParameters = {
  type: "object",
  properties: {
    container: containerParam,
    name: { type: "string", description: "Daemon name." },
    argv: {
      type: "array",
      items: { type: "string" },
      description: "Command to run as a daemon.",
    },
    cwd: { type: "string", description: "Working directory." },
    env: envParam,
    uid: {
      type: "integer",
      minimum: 0,
      description: "Run the daemon as this uid (defaults to the container user).",
    },
    gid: {
      type: "integer",
      minimum: 0,
      description: "Run the daemon as this gid. Defaults to the uid when uid is set.",
    },
    groups: {
      type: "array",
      items: { type: "integer", minimum: 0 },
      description: "Supplementary group ids.",
    },
    inheritEnv: {
      type: "boolean",
      description:
        "Inherit the container's environment (default true). When false the daemon receives only PATH and HOME plus env, so container and secret environment variables are not visible.",
    },
  },
  required: ["container", "name", "argv"],
};

export const daemonListParameters = {
  type: "object",
  properties: { container: containerParam },
  required: ["container"],
};

export const daemonStopParameters = {
  type: "object",
  properties: {
    container: containerParam,
    name: { type: "string", description: "Daemon name to stop." },
    signal: { type: "string", description: 'Signal to send (e.g. "SIGTERM").' },
  },
  required: ["container", "name"],
};

export const daemonRestartParameters = {
  type: "object",
  properties: {
    container: containerParam,
    name: { type: "string", description: "Daemon name to restart." },
  },
  required: ["container", "name"],
};

export const daemonLogsParameters = {
  type: "object",
  properties: {
    container: containerParam,
    name: { type: "string", description: "Daemon name to read logs for." },
    tailBytes: {
      type: "integer",
      description: "Maximum trailing bytes to retain per stream.",
    },
  },
  required: ["container", "name"],
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
    "List the project mounts of a container in the current workspace.",
  container_mount_add:
    "Add a project mount to a container in the current workspace. Recreates the container, terminating its running processes; bind-mounted volume data persists. Requires approval: adding a mount changes the container filesystem view.",
  container_mount_remove:
    "Remove a project mount from a container in the current workspace. Recreates the container, terminating its running processes; bind-mounted volume data persists. Requires approval: removing a mount changes the container filesystem view.",
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
