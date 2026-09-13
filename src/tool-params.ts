// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

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
