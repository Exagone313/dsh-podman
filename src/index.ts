// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { WorkspaceResolver, workspaceSlug } from "./workspace-binding.js";
import { installContainerSettings } from "./settings-bridge.js";
import {
  defaultMountMode,
  mountKindToProto,
  mountModeToProto,
} from "./mount-enums.js";
import { metadata } from "./workspace-binding.js";
import { PassThrough } from "node:stream";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function defineTool<T>(definition: T): T {
  return definition;
}
export const toolOutput = {
  schema: { type: "string" },
  render: (_args: unknown, value: string) => [{ type: "text", text: value }],
};
function withTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

export const name = "podman";
export const inject = ["tools", "workspaceRegistry"];
export interface PluginConfig {
  socketsRoot?: string;
  defaultImage?: string;
  projectsRoot?: string;
  controlToken?: string;
  imagePrefix?: string;
}
export function apply(ctx: any, config: PluginConfig = {}): void {
  ctx.on("tools/pre-execute", preExecutePolicy);
  ensurePodmanOpsPreset(ctx);
  const imagePrefix = withTrailingSlash(
    config.imagePrefix ?? process.env.DSH_PODMAN_IMAGE_PREFIX ?? "localhost/dsh-podman/",
  );
  const resolver = new WorkspaceResolver(
    {
      socketsRoot:
        config.socketsRoot ??
        process.env.DSH_PODMAN_SOCKETS_ROOT ??
        "/run/dsh-podman",
      defaultImage: config.defaultImage ?? "archlinux",
      projectsRoot:
        config.projectsRoot ??
        process.env.DSH_PODMAN_PROJECTS_ROOT ??
        "/projects",
      controlToken:
        config.controlToken ?? process.env.DSH_PODMAN_ORCHESTRATOR_TOKEN ?? "",
    },
    ctx.workspaceRegistry,
  );
  ctx.provide("workspaceResolver", resolver);
  ctx.provide("subprocess", createSubprocessProvider(resolver));
  ctx.provide("fs", createFilesystemProvider(resolver));
  registerTools(ctx, resolver);
  installContainerSettings(ctx, resolver, ctx.workspaceRegistry);
}

export interface SubprocessProvider {
  resolveExecutable(command: string): Promise<string>;
  spawn(spec: any): any;
}
export interface FilesystemProvider {
  resolve(path: string, opts?: any): Promise<any>;
  processPath(target: any): string;
  fileUrl(target: any): string;
  contains(parent: any, child: any): boolean;
  readText(target: any): Promise<string>;
  writeText(target: any, content: string, expected?: any): Promise<any>;
  stat(target: any): Promise<any>;
  listDir(target: any): Promise<any>;
  mkdir(target: any, parents?: boolean): Promise<any>;
  remove(target: any, recursive?: boolean): Promise<any>;
  editText(target: any, edit: any): Promise<any>;
}

export function createSubprocessProvider(resolver: WorkspaceResolver): SubprocessProvider {
  return {
    resolveExecutable: async (command: string) => {
      if (command.length === 0)
        throw new Error("executable name must be non-empty");
      if (command.startsWith("/")) return command;
      if (command.includes("/"))
        throw new Error("relative executable paths are not supported");
      return `/usr/bin/${command}`;
    },    spawn: (spec: any) => {
      if (
        !Array.isArray(spec.argv) ||
        spec.argv.length === 0 ||
        typeof spec.argv[0] !== "string" ||
        spec.argv[0] === ""
      )
        throw new Error("argv must contain a program");
      const stdoutReader = outputReader(spec.stdio?.stdout);
      const stderrReader = outputReader(spec.stdio?.stderr);
      const state = {
        pid: -1,
        stdin: undefined as any,
        stdout: spec.stdio?.stdout === "pipe" ? new PassThrough() : undefined,
        stderr: spec.stdio?.stderr === "pipe" ? new PassThrough() : undefined,
      };
      let processBinding: any;
      let terminated = false;
      const terminate = (): void => {
        terminated = true;
        if (processBinding !== undefined && state.pid > 0) {
          void unaryGuest({ binding: processBinding }, "signal", {
            processId: String(state.pid),
            signal: "SIGTERM",
          });
        }
      };
      const done = resolver.resolve(spec.cwd).then(
        (binding) =>
          new Promise<any>((resolveDone, reject) => {
            processBinding = binding;
            const stream = (binding.guest as any).exec(metadata(binding.token));
            stream.on("data", (output: any) => {
              if (output.stdoutChunk) {
                const data = Buffer.from(output.stdoutChunk);
                stdoutReader?.append(data);
                state.stdout?.write(data);
              }
              if (output.processId) {
                state.pid = Number(output.processId);
                if (terminated) terminate();
              }
              if (output.stderrChunk) {
                const data = Buffer.from(output.stderrChunk);
                stderrReader?.append(data);
                state.stderr?.write(data);
              }
              if (output.exit) {
                state.stdout?.end();
                state.stderr?.end();
                resolveDone({
                  exitCode: output.exit.exitCode,
                  signal: output.exit.signaled ? output.exit.signal : null,
                });
              }
            });
            stream.on("error", reject);
            stream.write({
              start: {
                argv: remoteArgv(spec.argv),
                cwd: spec.cwd,
                env: spec.env ?? {},
              },
            });
            if (spec.stdio?.stdin !== "pipe") stream.end();
            else {
              state.stdin = new PassThrough();
              state.stdin.on("data", (data: Buffer) =>
                stream.write({ stdinChunk: data }),
              );
              state.stdin.on("end", () => stream.end());
            }
          }),
      );
      return {
        ...state,
        collected: {
          ...(stdoutReader === undefined ? {} : { stdout: stdoutReader }),
          ...(stderrReader === undefined ? {} : { stderr: stderrReader }),
        },
        done,
        terminate,
        waitForExit: async () => {
          await done;
          return true;
        },
      };
    },
  };
}

export function outputReader(mode: unknown):
  | {
      append: (data: Buffer) => void;
      readFrom: (offset: number) => {
        text: string;
        nextOffset: number;
        lossy: boolean;
      };
    }
  | undefined {
  if (typeof mode !== "object" || mode === null) return undefined;
  const maxBytes = Number((mode as { maxBytes?: number }).maxBytes);
  if (!Number.isFinite(maxBytes) || maxBytes < 0) return undefined;
  let total = 0;
  let retained = Buffer.alloc(0);
  return {
    append(data) {
      total += data.length;
      retained = Buffer.concat([retained, data]).subarray(-maxBytes);
    },
    readFrom(offset) {
      const start = Math.max(0, total - retained.length);
      const requested = Math.max(0, Number.isFinite(offset) ? offset : 0);
      const local = Math.max(0, requested - start);
      return {
        text: retained.subarray(local).toString("utf8"),
        nextOffset: total,
        lossy: requested < start,
      };
    },
  };
}

export function remoteArgv(argv: readonly string[]): readonly string[] {
  const runner = argv[0];
  if (runner !== undefined && /(?:^|\/)rg(?:\.exe)?$/.test(runner)) {
    return ["/usr/bin/rg", ...argv.slice(1)];
  }
  if (runner !== undefined && /(?:^|\/)landlock-run(?:$|\/)/.test(runner)) {
    const separator = argv.indexOf("--");
    if (separator >= 0) return remoteArgv(argv.slice(separator + 1));
  }
  return argv;
}

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
      description: "Destination path inside the container.",
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
      description: "Destination path inside the container.",
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
      description: "Destination path inside the container.",
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
    command: { type: "string", description: "Shell command to run." },
    workdir: { type: "string", description: "Working directory." },
    env: envParam,
  },
  required: ["container", "command"],
};
export const containerExecParameters = {
  type: "object",
  properties: {
    container: containerParam,
    argv: { type: "array", items: { type: "string" } },
    cwd: { type: "string", description: "Working directory." },
    env: envParam,
  },
  required: ["container", "argv"],
};
export const containerReadParameters = {
  type: "object",
  properties: {
    container: containerParam,
    path: { type: "string", description: "Absolute path to read." },
  },
  required: ["container", "path"],
};
export const containerWriteParameters = {
  type: "object",
  properties: {
    container: containerParam,
    path: { type: "string", description: "Absolute path to write." },
    content: { type: "string", description: "Content to write." },
    create: { type: "boolean", description: "Create if absent (default true)." },
    truncate: {
      type: "boolean",
      description: "Truncate before writing (default true).",
    },
  },
  required: ["container", "path", "content"],
};
export const containerEditParameters = {
  type: "object",
  properties: {
    container: containerParam,
    path: { type: "string", description: "Absolute path to edit." },
    oldString: { type: "string", description: "Text to replace." },
    newString: { type: "string", description: "Replacement text." },
    replaceAll: { type: "boolean", description: "Replace every occurrence." },
  },
  required: ["container", "path", "oldString", "newString"],
};
export const containerGlobParameters = {
  type: "object",
  properties: {
    container: containerParam,
    pattern: { type: "string", description: "File pattern." },
    cwd: { type: "string", description: "Working directory." },
  },
  required: ["container", "pattern"],
};
export const containerGrepParameters = {
  type: "object",
  properties: {
    container: containerParam,
    pattern: { type: "string", description: "Regex to search for." },
    path: { type: "string", description: "Path to search." },
    cwd: { type: "string", description: "Working directory." },
  },
  required: ["container", "pattern"],
};
export const daemonStartParameters = {
  type: "object",
  properties: {
    container: containerParam,
    name: { type: "string", description: "Optional daemon name." },
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
  },
  required: ["container", "argv"],
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

// Join top-level parts of an approval reason. List elements within a part
// (packages, mounts) stay comma-joined instead.
const part = (...items: (string | undefined)[]): string =>
  items.filter((item) => item !== undefined && item !== "").join(" • ");

// Join list elements, capping at 8 with a "+N more" tail.
const LIST_CAP = 8;
function list(items: readonly unknown[], format: (item: unknown) => string): string {
  if (items.length === 0) return "";
  const shown = items.slice(0, LIST_CAP).map(format);
  const extra = items.length - LIST_CAP;
  return extra > 0 ? [...shown, `+${extra} more`].join(", ") : shown.join(", ");
}

// Render a project mount path "team" or "team/src" from project + optional path.
function projectPath(project: string, path?: string): string {
  if (path === undefined || path === "") return project;
  return `${project}/${path.replace(/^\/+/, "")}`;
}

// Render a mount's mode suffix: "(ro)" for read_only, nothing for read_write.
function mountMode(mode: unknown): string {
  return mode === "read_only" ? " (ro)" : "";
}

// Summarize the mount source for container_mount_add/remove.
function mountTarget(args: Record<string, unknown>): string {
  const kind =
    args.kind === "tmpfs"
      ? "tmpfs"
      : args.kind === "volume"
        ? "volume"
        : args.kind === "secret"
          ? "secret"
          : "directory";
  switch (kind) {
    case "volume":
      return typeof args.volume === "string" ? `volume ${args.volume}` : "";
    case "tmpfs":
      return "tmpfs";
    case "secret":
      return typeof args.secret === "string" ? `secret ${args.secret}` : "";
    default:
      return typeof args.project === "string" ? `directory ${projectPath(args.project, typeof args.path === "string" ? args.path : undefined)}` : "";
  }
}

// Render a single mount item, e.g. "team/src (ro)" or "volume valkey-data → /data".
function replaceMountItem(mount: Record<string, unknown>): string {
  const kind = typeof mount.kind === "string" ? mount.kind : "";
  const destination =
    typeof mount.destination === "string" && mount.destination !== ""
      ? mount.destination
      : undefined;
  const mode = mountMode(mount.mode);
  if (kind === "volume") {
    const volume = typeof mount.volume === "string" ? mount.volume : "";
    if (volume === "") return "";
    return `volume ${volume}${destination === undefined ? "" : ` → ${destination}`}${mode}`;
  }
  if (kind === "tmpfs") {
    return `tmpfs${destination === undefined ? "" : ` at ${destination}`}${mode}`;
  }
  if (kind === "secret") {
    const secret = typeof mount.secret === "string" ? mount.secret : "";
    if (secret === "") return "";
    return `secret ${secret}${destination === undefined ? "" : ` → ${destination}`}${mode}`;
  }
  const project = typeof mount.project === "string" ? mount.project : "";
  if (project === "") return "";
  const path = typeof mount.path === "string" ? mount.path : undefined;
  const item = destination === undefined
    ? projectPath(project, path)
    : `${projectPath(project, path)} → ${destination}`;
  return item + mode;
}

// Build the single-line approval summary shown for a gated tool call.
export function summarizeArgs(name: string, args: Record<string, unknown>): string {
  const str = (key: string): string | undefined =>
    typeof args[key] === "string" && args[key] !== "" ? (args[key] as string) : undefined;
  const count = (key: string): string | undefined => {
    const value = args[key];
    return Array.isArray(value) && value.length > 0 ? String(value.length) : undefined;
  };
  const listOf = (key: string): string | undefined => {
    const value = args[key];
    if (!Array.isArray(value) || value.length === 0) return undefined;
    return list(value, (item) => String(item));
  };
  const mounts = (): string | undefined => {
    const value = args.mounts;
    if (!Array.isArray(value) || value.length === 0) return undefined;
    const items = value.map((item) =>
      typeof item === "object" && item !== null
        ? replaceMountItem(item as Record<string, unknown>)
        : "",
    ).filter((item) => item !== "");
    if (items.length === 0) return undefined;
    const shown = items.slice(0, LIST_CAP);
    const beyond = items.length - LIST_CAP;
    return beyond > 0 ? `${shown.join(", ")}, +${beyond} more` : shown.join(", ");
  };
  const envKeys = (): string | undefined => {
    const value = args.env;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }
    const keys = Object.keys(value);
    if (keys.length === 0) return undefined;
    return list(keys, (key) => String(key));
  };

  switch (name) {
    case "image_build": {
      const image = str("imageId");
      const parent = str("parent");
      const packages = listOf("packages");
      if (image === undefined) return "";
      const phrase = `build image ${image}${parent === undefined ? "" : ` from ${parent}`}`;
      return part(
        phrase,
        packages === undefined ? undefined : `packages: ${packages}`,
      );
    }
    case "image_rebuild": {
      const image = str("imageId");
      return image === undefined ? "" : `rebuild image ${image}`;
    }
    case "image_rebuild_all":
      return "rebuild all images";
    case "image_remove": {
      const image = str("imageId");
      return image === undefined ? "" : `remove image ${image}`;
    }
    case "container_recreate": {
      const container = str("container");
      const image = str("image");
      const mountItems = mounts();
      const env = envKeys();
      if (container === undefined) return "";
      const phrase = `recreate container ${container}${image === undefined ? "" : ` with ${image}`}`;
      return part(
        phrase,
        mountItems === undefined ? undefined : `mounts: ${mountItems}`,
        env === undefined ? undefined : `env: ${env}`,
      );
    }
    case "container_remove": {
      const container = str("container");
      return container === undefined ? "" : `remove container ${container}`;
    }
    case "container_start": {
      const container = str("container");
      const image = str("image");
      const mountItems = mounts();
      const env = envKeys();
      if (container === undefined) return "";
      const phrase = `start container ${container}${image === undefined ? "" : ` with ${image}`}`;
      return part(
        phrase,
        mountItems === undefined ? undefined : `mounts: ${mountItems}`,
        env === undefined ? undefined : `env: ${env}`,
      );
    }
    case "volume_remove": {
      const name = str("name");
      return name === undefined ? "" : `remove volume ${name}`;
    }
    case "secret_remove": {
      const name = str("name");
      return name === undefined ? "" : `remove secret ${name}`;
    }
    case "container_secret_add": {
      const container = str("container");
      const env = str("env");
      const secret = str("secret");
      if (container === undefined || env === undefined || secret === undefined) {
        return "";
      }
      return `container ${container}: add secret ${secret} as ${env}`;
    }
    case "container_secret_remove": {
      const container = str("container");
      const env = str("env");
      if (container === undefined || env === undefined) return "";
      return `container ${container}: remove secret ${env}`;
    }
    case "container_mount_add":
    case "container_mount_remove": {
      const container = str("container");
      const target = mountTarget(args);
      const destination = str("destination");
      const verb = name === "container_mount_add" ? "mount" : "unmount";
      if (container === undefined || target === "") return "";
      const suffix = destination === undefined ? "" : ` at ${destination}`;
      return `container ${container}: ${verb} ${target}${suffix}${name === "container_mount_add" ? mountMode(args.mode) : ""}`;
    }
    case "container_bash": {
      const container = str("container");
      const command = str("command");
      if (container === undefined || command === undefined) return "";
      return `run shell in container ${container}: ${command}`;
    }
    case "container_exec": {
      const container = str("container");
      const argv = args.argv;
      if (container === undefined || !Array.isArray(argv) || argv.length === 0) return "";
      const words = argv.map((word) => String(word)).slice(0, 8);
      const tail = argv.length > 8 ? " …" : "";
      return `run in container ${container}: ${words.join(" ")}${tail}`;
    }
    case "container_write": {
      const container = str("container");
      const path = str("path");
      if (container === undefined || path === undefined) return "";
      return `write ${path} in container ${container}`;
    }
    case "container_edit": {
      const container = str("container");
      const path = str("path");
      if (container === undefined || path === undefined) return "";
      return `edit ${path} in container ${container}`;
    }
    case "daemon_start": {
      const container = str("container");
      const argv = args.argv;
      if (container === undefined || !Array.isArray(argv) || argv.length === 0) return "";
      const named = str("name");
      const words = argv.map((word) => String(word)).slice(0, 8);
      const tail = argv.length > 8 ? " …" : "";
      const command = `${named === undefined ? "" : ` ${named}`}`;
      const uid = typeof args.uid === "number" ? String(args.uid) : undefined;
      const gid = typeof args.gid === "number" ? String(args.gid) : undefined;
      return part(
        `start daemon${command} in container ${container}: ${words.join(" ")}${tail}`,
        uid === undefined ? undefined : `uid: ${uid}`,
        gid === undefined ? undefined : `gid: ${gid}`,
      );
    }
    default:
      return "";
  }
}

// Decide whether a tool call needs approval. DSH resolves an `ask` decision
// through its approval service (`ctx.get("approval").request(...)`), showing
// the standard approval prompt; without one the call fails closed.
// Approval is per tool, optionally conditional on the call's arguments via a
// tool's `approvalWhen` predicate (e.g. container_start only asks when project
// mounts are supplied).
export function approvalDecision(
  name: string,
  args?: Record<string, unknown>,
): { kind: "ask"; reason: string } | undefined {
  const tool = TOOLS.find((entry) => entry.name === name);
  if (tool === undefined) return undefined;
  if (tool.approval === true) {
    return { kind: "ask", reason: summarizeArgs(name, args ?? {}) };
  }
  if (tool.approvalWhen !== undefined && tool.approvalWhen(args ?? {})) {
    return { kind: "ask", reason: summarizeArgs(name, args ?? {}) };
  }
  return undefined;
}

// Tools that only read or list and remain safe under a read-only permission.
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "image_list",
  "image_get",
  "container_list",
  "container_read",
  "container_glob",
  "container_grep",
  "container_mount_list",
  "volume_list",
  "secret_list",
  "daemon_list",
  "daemon_logs",
]);

// The agent preset id this plugin ships ("Podman operator mode"). Tools in
// PODMAN_OPS_APPROVAL_TOOLS are gated behind approval only for agents composed
// from this preset, so it can "do other things" (run commands, edit container
// files, start daemons) once the user approves.
export const PODMAN_OPS_PRESET = "podman-ops";

// Tools the Podman operator-mode preset keeps available but approval-gated.
export const PODMAN_OPS_APPROVAL_TOOLS: ReadonlySet<string> = new Set([
  "container_bash",
  "container_exec",
  "container_write",
  "container_edit",
  "daemon_start",
]);

// Every tool this plugin registers, so the permission policy only gates its
// own tools and delegates DSH-native ones (bash, write, ...) to the harness.
const OUR_TOOL_NAMES = new Set(TOOLS.map((tool) => tool.name));

// Fold the session's effective sandbox mode (last `sandbox/mode` wins).
export function foldSandboxMode(
  events: readonly { type: string; data?: { mode?: string } }[],
): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === "sandbox/mode") return event.data?.mode;
  }
  return undefined;
}

// Fold the session's effective approval policy (last `approval/policy` wins).
export function foldApprovalPolicy(
  events: readonly { type: string; data?: { policy?: string } }[],
): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === "approval/policy") return event.data?.policy;
  }
  return undefined;
}

// The `tools/pre-execute` policy, driven by the session's permission knobs:
// - read-only sandbox: only READ_ONLY_TOOLS run; every other plugin tool is
//   denied with a reason. DSH-native tools are delegated so their own sandbox
//   policy applies.
// - approval policy "never" (Full access): run without asking.
// - otherwise (Workspace Write): ask for the approval-gated tools, including
//   the tools the Podman operator-mode preset gates per preset.
export async function preExecutePolicy(
  exec: {
    name: string;
    arguments?: unknown;
    agent?: {
      session?: {
        header?: { agentPreset?: string };
        events?: readonly { type: string; data?: { mode?: string; policy?: string } }[];
      };
    };
  },
  next: () => Promise<unknown>,
): Promise<unknown> {
  const name = exec.name;
  if (!OUR_TOOL_NAMES.has(name)) return next();
  const events = exec.agent?.session?.events ?? [];
  if (foldSandboxMode(events) === "read-only") {
    if (READ_ONLY_TOOLS.has(name)) return next();
    return {
      kind: "deny",
      reason: `tool "${name}" requires a writable permission (current: read-only)`,
    };
  }
  if (foldApprovalPolicy(events) === "never") return next();
  const args = exec.arguments;
  const parsed =
    typeof args === "object" && args !== null ? (args as Record<string, unknown>) : undefined;
  const preset = exec.agent?.session?.header?.agentPreset;
  if (preset === PODMAN_OPS_PRESET && PODMAN_OPS_APPROVAL_TOOLS.has(name)) {
    return { kind: "ask", reason: summarizeArgs(name, parsed ?? {}) };
  }
  return approvalDecision(name, parsed) ?? next();
}

// The "Podman operator mode" preset metadata, shipped verbatim into the
// harness's user-presets root.
export const PODMAN_OPS_PRESET_YML = `name: Podman operator mode
description: Podman-focused container operations — manage images, containers, volumes, mounts, secrets, and daemons. Inspections and lifecycle run directly; commands, container file edits, daemon starts, and secret changes ask for approval; supports web research.
order: 2
`;

// The "Podman operator mode" agent composition: a Podman-focused persona plus
// the built-in task and web tools. The plugin's own container tools are global
// and need no rows; the command/file/daemon/secret tools stay available but
// gated by the pre-execute policy (PODMAN_OPS_APPROVAL_TOOLS + global flags).
export const PODMAN_OPS_AGENT_CORDIS_YML = `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: >-
      You are a Podman container-operations agent powered by the {{model}} model.
      Your working directory is {{cwd}}.

      You manage container infrastructure through the dsh-podman tools: images
      (image_list, image_get, image_build, image_rebuild, image_rebuild_all,
      image_remove), containers (container_list, container_start,
      container_recreate, container_remove), mounts (container_mount_list,
      container_mount_add, container_mount_remove), volumes (volume_list,
      volume_create, volume_remove), secrets (secret_list, secret_create,
      secret_remove, container_secret_add, container_secret_remove), daemons
      (daemon_list, daemon_start, daemon_stop, daemon_restart, daemon_logs),
      and container inspection (container_read, container_glob,
      container_grep).

      Inspection and lifecycle operations run directly. Running commands inside
      a container (container_bash, container_exec), editing container files
      (container_write, container_edit), starting daemons (daemon_start),
      exposing or removing secret environment variables (container_secret_add,
      container_secret_remove), removing secrets (secret_remove), and
      rebuilding all images (image_rebuild_all) require the user's approval.
      Use web_search to research images and documentation. Use
      ask_user_question for user decisions and todo_write to track work.
- id: tool-ask-user
  name: '@deepseek-ai/dsh-tool-ask-user'
- id: tool-todo
  name: '@deepseek-ai/dsh-tool-todo'
  config:
    allowParallelInProgress: true
- id: tool-web
  name: '@deepseek-ai/dsh-tool-web'
  config:
    fetch: false
    searchTimeoutMs: 60000
`;

// Install the "Podman operator mode" agent preset into the harness's
// user-presets root (~/.dsh/.agent-presets/<id>). The plugin owns the preset
// content and (re)writes it on every load, so a local copy is always brought
// back to the shipped composition. Best-effort — a failure only logs.
export function ensurePodmanOpsPreset(ctx: any, dir?: string): void {
  const log = (message: string, ...args: unknown[]): void => {
    try {
      ctx?.logger?.warn?.(message, ...args);
    } catch {
      // Logger failure must not abort preset installation.
    }
  };
  try {
    const target = dir ?? join(homePresetsRoot(), PODMAN_OPS_PRESET);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "preset.yml"), PODMAN_OPS_PRESET_YML);
    writeFileSync(join(target, "agent.cordis.yml"), PODMAN_OPS_AGENT_CORDIS_YML);
    log(`[dsh-podman] wrote the "${PODMAN_OPS_PRESET}" agent preset to %s`, target);
  } catch (error) {
    log(`[dsh-podman] could not install the "${PODMAN_OPS_PRESET}" agent preset: %o`, error);
  }
}

// The harness user-presets root ($DSH_HOME or ~/.dsh, plus .agent-presets).
export function homePresetsRoot(): string {
  return join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), ".agent-presets");
}

const TOOL_DESCRIPTIONS: Record<string, string> = {
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
  container_start: "Start a container in the current workspace.",
  container_recreate:
    "Recreate a container in the current workspace, keeping its current image when no image is given, optionally with new project mounts. Requires approval: recreating replaces the running container.",
  container_remove: "Remove a container from the current workspace.",
  container_bash:
    "Run a shell command inside a container of the current workspace.",
  container_exec:
    "Run a program inside a container of the current workspace.",
  container_read: "Read a file inside a container of the current workspace.",
  container_write: "Write a file inside a container of the current workspace.",
  container_edit: "Edit a file inside a container of the current workspace.",
  container_glob:
    "List files inside a container of the current workspace matching a pattern.",
  container_grep:
    "Search file contents inside a container of the current workspace.",
  container_mount_list:
    "List the project mounts of a container in the current workspace.",
  container_mount_add:
    "Add a project mount to a container in the current workspace. Requires approval: adding a mount changes the container filesystem view.",
  container_mount_remove:
    "Remove a project mount from a container in the current workspace. Requires approval: removing a mount changes the container filesystem view.",
  volume_list:
    "List the named volumes available to the current workspace.",
  volume_create: "Create a named volume in the current workspace.",
  volume_remove: "Remove a named volume from the current workspace.",
  secret_list:
    "List the named secrets available to the current workspace (values are never exposed).",
  secret_create:
    "Create a secret with an orchestrator-generated random value (the value is never exposed).",
  secret_remove:
    "Remove a named secret from the current workspace. Requires approval: removing deletes the secret so containers using it must drop it first.",
  container_secret_add:
    "Inject a named secret into a container as an environment variable. Requires approval: exposing a secret to a container changes what it can read.",
  container_secret_remove:
    "Stop injecting a named secret into a container environment variable. Requires approval: removing a secret exposure changes what the container can read.",
  daemon_start:
    "Start a daemon inside a container of the current workspace. Optionally run it as a specific uid/gid (with optional supplementary groups).",
  daemon_list:
    "List the daemons running inside a container of the current workspace.",
  daemon_stop: "Stop a daemon inside a container of the current workspace.",
  daemon_restart:
    "Restart a daemon inside a container of the current workspace.",
  daemon_logs:
    "Read the captured logs of a daemon inside a container of the current workspace.",
};

export const toolHandlers: Record<
  string,
  (resolver: WorkspaceResolver, input: any, exec: any) => Promise<unknown>
> = {
  image_list: async (resolver) => {
    const result = await resolver.control<{ images?: any[] }>("listImages", {});
    const rows = (result.images ?? []).map((image: any) => {
      if (image.isBase) {
        return `${image.imageId}  base  pm=${image.packageManager}  primitive=${image.primitive}  status=${image.status}`;
      }
      const packages = (image.packages ?? []).length > 0
        ? (image.packages ?? []).join(", ")
        : "(none)";
      return `${image.imageId}  parent=${image.parent}  pm=${image.packageManager}  status=${image.status}  built=${image.builtAt}  packages=${packages}`;
    });
    return rows.length > 0 ? rows.join("\n") : "(no images)";
  },
  image_get: async (resolver, input) =>
    resolver.control("getImage", { imageId: input.imageId }),
  image_build: async (resolver, input) =>
    resolver.control("buildImage", {
      imageId: input.imageId,
      parent: input.parent,
      packages: input.packages,
    }),
  image_rebuild: async (resolver, input) =>
    resolver.control("rebuildImage", { imageId: input.imageId }),
  image_rebuild_all: async (resolver) => {
    const result = await resolver.control<{ rebuilt?: string[]; skipped?: string[] }>(
      "rebuildAllImages",
      {},
    );
    const rebuilt = (result.rebuilt ?? []).join(", ");
    const skipped = (result.skipped ?? []).join(", ");
    return `rebuilt: ${rebuilt || "(none)"}${skipped ? `\nskipped: ${skipped}` : ""}`;
  },
  image_remove: async (resolver, input) =>
    resolver.control("removeImage", { imageId: input.imageId }),
  container_list: async (resolver, _input, exec) => {
    const slug = await sessionWorkspaceSlug(resolver, currentCwd(exec));
    const [containersResult, workspacesResult] = await Promise.all([
      resolver.control<{ containers?: any[] }>("listContainers", {}),
      resolver.control<{ workspaces?: any[] }>("listWorkspaces", {}),
    ]);
    void workspacesResult;
    const rows = (containersResult.containers ?? []).filter(
      (row: any) => row.workspaceSlug === slug,
    );
    const lines = [`workspace ${slug}`];
    const envList = (env: unknown): string | undefined => {
      if (typeof env !== "object" || env === null || Array.isArray(env)) {
        return undefined;
      }
      const keys = Object.keys(env);
      if (keys.length === 0) return undefined;
      return list(keys, (key) => String(key));
    };
    const secretEnvList = (env: unknown): string | undefined => {
      if (typeof env !== "object" || env === null || Array.isArray(env)) {
        return undefined;
      }
      const entries = Object.entries(env);
      if (entries.length === 0) return undefined;
      return list(entries, (item) => {
        const [key, value] = item as [string, unknown];
        return `${key}=${String(value)}`;
      });
    };
    const defaultRow = rows.find((row: any) => row.containerName === "default");
    const defaultEnv = envList(defaultRow?.env);
    const defaultSecrets = secretEnvList(defaultRow?.secretEnv);
    lines.push(
      defaultRow === undefined
        ? "default: not started (will be started on demand)"
        : `default: ${defaultRow.status}${
            defaultRow.imageId ? ` (image ${defaultRow.imageId})` : ""
          }${defaultEnv === undefined ? "" : `  env=${defaultEnv}`}${
            defaultSecrets === undefined ? "" : `  secret_env=${defaultSecrets}`
          }`,
    );
    const named = rows.filter((row: any) => row.containerName !== "default");
    if (named.length === 0) {
      lines.push("named containers: (none)");
    } else {
      lines.push("named containers:");
      for (const row of named) {
        const env = envList(row.env);
        const secrets = secretEnvList(row.secretEnv);
        lines.push(
          `  ${row.containerName}: ${row.status}${
            row.imageId ? ` (image ${row.imageId})` : ""
          }${env === undefined ? "" : `  env=${env}`}${
            secrets === undefined ? "" : `  secret_env=${secrets}`
          }`,
        );
      }
    }
    return lines.join("\n");
  },
  container_start: async (resolver, input, exec) => {
    const mounts = mountsFromInput(input.mounts);
    return resolver.control("startContainer", {
      workspaceSlug: await sessionWorkspaceSlug(resolver, currentCwd(exec)),
      container: input.container,
      imageId: input.image,
      ...(mounts === undefined ? {} : { mounts }),
      ...(input.env !== undefined ? { env: input.env } : {}),
      ...(input.secretEnv !== undefined ? { secretEnv: input.secretEnv } : {}),
    });
  },
  container_recreate: async (resolver, input, exec) => {
    const mounts = mountsFromInput(input.mounts);
    return resolver.control("recreateContainer", {
      workspaceSlug: await sessionWorkspaceSlug(resolver, currentCwd(exec)),
      container: input.container,
      imageId: input.image ?? "",
      ...(mounts === undefined ? {} : { mounts }),
      ...(input.env !== undefined ? { env: input.env } : {}),
      ...(input.secretEnv !== undefined ? { secretEnv: input.secretEnv } : {}),
    });
  },
  container_remove: async (resolver, input, exec) =>
    resolver.control("removeContainer", {
      workspaceSlug: await sessionWorkspaceSlug(resolver, currentCwd(exec)),
      container: input.container,
    }),
  container_bash: async (resolver, input, exec) => {
    const binding = await resolveToolBinding(
      resolver,
      currentCwd(exec),
      input.container,
    );
    return runExec(binding, ["bash", "-lc", input.command], input.workdir, input.env);
  },
  container_exec: async (resolver, input, exec) => {
    const binding = await resolveToolBinding(
      resolver,
      currentCwd(exec),
      input.container,
    );
    return runExec(binding, input.argv, input.cwd, input.env);
  },
  container_read: async (resolver, input, exec) => {
    const binding = await resolveToolBinding(
      resolver,
      currentCwd(exec),
      input.container,
    );
    return readGuestFile(binding, input.path);
  },
  container_write: async (resolver, input, exec) => {
    const binding = await resolveToolBinding(
      resolver,
      currentCwd(exec),
      input.container,
    );
    const bytesWritten = await writeGuestFile(binding, input.path, input.content, {
      create: input.create ?? true,
      truncate: input.truncate ?? true,
    });
    return { bytesWritten };
  },
  container_edit: async (resolver, input, exec) => {
    const binding = await resolveToolBinding(
      resolver,
      currentCwd(exec),
      input.container,
    );
    const before = await readGuestFile(binding, input.path);
    if (typeof input.oldString !== "string" || input.oldString.length === 0) {
      throw new Error("oldString must be a non-empty string");
    }
    const after = input.replaceAll
      ? before.split(input.oldString).join(input.newString)
      : before.replace(input.oldString, input.newString);
    if (after === before) throw new Error("oldString was not found");
    await writeGuestFile(binding, input.path, after, {
      create: true,
      truncate: true,
    });
    return { before, after };
  },
  container_glob: async (resolver, input, exec) => {
    const binding = await resolveToolBinding(
      resolver,
      currentCwd(exec),
      input.container,
    );
    const result = await runExec(
      binding,
      ["rg", "--files", input.pattern],
      input.cwd,
    );
    return {
      files: outputLines(result.stdout),
      ...(result.stderr ? { stderr: result.stderr.trim() } : {}),
    };
  },
  container_grep: async (resolver, input, exec) => {
    const binding = await resolveToolBinding(
      resolver,
      currentCwd(exec),
      input.container,
    );
    const argv = input.path
      ? ["rg", "-n", input.pattern, input.path]
      : ["rg", "-n", input.pattern];
    const result = await runExec(binding, argv, input.cwd);
    return {
      matches: outputLines(result.stdout),
      ...(result.stderr ? { stderr: result.stderr.trim() } : {}),
    };
  },
  container_mount_list: async (resolver, input, exec) => {
    const slug = await sessionWorkspaceSlug(resolver, currentCwd(exec));
    const result = await resolver.control<{ containers?: any[] }>(
      "listContainers",
      {},
    );
    const row = (result.containers ?? []).find(
      (candidate: any) =>
        candidate.workspaceSlug === slug &&
        candidate.containerName === input.container,
    );
    if (row === undefined) {
      throw new Error(
        `container ${input.container} not found in workspace ${slug}`,
      );
    }
    const mounts = row.mounts ?? [];
    if (mounts.length === 0) return "(no mounts)";
    return mounts
      .map((mount: any) => {
        const parts = [
          `project=${mount.projectName}`,
          `mode=${mount.mode}`,
          ...(mount.path ? [`path=${mount.path}`] : []),
          ...(mount.destination ? [`destination=${mount.destination}`] : []),
        ];
        return parts.join("  ");
      })
      .join("\n");
  },
  container_mount_add: async (resolver, input, exec) => {
    const kind = input.kind ?? "project";
    const protoKind = mountKindToProto(input.kind);
    const mode = mountModeToProto(input.mode ?? defaultMountMode(kind));
    const request: Record<string, unknown> = {
      workspaceSlug: await sessionWorkspaceSlug(resolver, currentCwd(exec)),
      container: input.container,
      kind: protoKind,
    };
    if (kind === "volume") {
      request.volume = input.volume;
      request.destination = input.destination;
      request.mode = mode;
    } else if (kind === "tmpfs") {
      request.destination = input.destination;
      request.mode = mode;
    } else if (kind === "secret") {
      request.secret = input.secret;
      request.destination = input.destination;
    } else {
      request.project = input.project;
      if (input.path !== undefined) request.path = input.path;
      if (input.destination !== undefined) request.destination = input.destination;
      request.mode = mode;
    }
    return resolver.control("addContainerMount", request);
  },
  container_mount_remove: async (resolver, input, exec) => {
    const kind = input.kind ?? "project";
    const protoKind = mountKindToProto(input.kind);
    const request: Record<string, unknown> = {
      workspaceSlug: await sessionWorkspaceSlug(resolver, currentCwd(exec)),
      container: input.container,
      kind: protoKind,
    };
    if (kind === "project") {
      request.project = input.project;
      if (input.path !== undefined) request.path = input.path;
    } else if (kind === "volume") {
      if (input.volume !== undefined) request.volume = input.volume;
    } else if (kind === "secret") {
      if (input.secret !== undefined) request.secret = input.secret;
    }
    if (input.destination !== undefined) request.destination = input.destination;
    return resolver.control("removeContainerMount", request);
  },
  volume_list: async (resolver) => {
    const result = await resolver.control<{ volumes?: any[] }>("listVolumes", {});
    const rows = (result.volumes ?? []).map((volume: any) => volume.name);
    return rows.length > 0 ? rows.join("\n") : "(no volumes)";
  },
  volume_create: async (resolver, input) =>
    resolver.control("createVolume", { name: input.name }),
  volume_remove: async (resolver, input) =>
    resolver.control("removeVolume", { name: input.name }),
  secret_list: async (resolver) => {
    const result = await resolver.control<{ secrets?: any[] }>("listSecrets", {});
    const rows = (result.secrets ?? []).map((secret: any) => secret.name);
    return rows.length > 0 ? rows.join("\n") : "(no secrets)";
  },
  secret_create: async (resolver, input) =>
    resolver.control("createSecret", {
      name: input.name,
      ...(input.length ? { length: input.length } : {}),
      ...(input.charset ? { charset: input.charset } : {}),
    }),
  secret_remove: async (resolver, input) =>
    resolver.control("removeSecret", { name: input.name }),
  container_secret_add: async (resolver, input, exec) =>
    resolver.control("addContainerSecret", {
      workspaceSlug: await sessionWorkspaceSlug(resolver, currentCwd(exec)),
      container: input.container,
      env: input.env,
      secret: input.secret,
    }),
  container_secret_remove: async (resolver, input, exec) =>
    resolver.control("removeContainerSecret", {
      workspaceSlug: await sessionWorkspaceSlug(resolver, currentCwd(exec)),
      container: input.container,
      env: input.env,
    }),
  daemon_start: async (resolver, input, exec) => {
    const binding = await resolveToolBinding(
      resolver,
      currentCwd(exec),
      input.container,
    );
    const request: Record<string, unknown> = { argv: input.argv };
    if (input.name !== undefined) request.name = input.name;
    if (input.cwd !== undefined) request.cwd = input.cwd;
    if (input.env !== undefined) request.env = input.env;
    if (input.uid !== undefined) {
      if (!Number.isInteger(input.uid) || input.uid < 0) {
        throw new Error("uid must be an integer >= 0");
      }
      request.uid = { value: input.uid };
    }
    if (input.gid !== undefined) {
      if (!Number.isInteger(input.gid) || input.gid < 0) {
        throw new Error("gid must be an integer >= 0");
      }
      request.gid = { value: input.gid };
    }
    if (input.groups !== undefined) {
      if (
        !Array.isArray(input.groups) ||
        input.groups.some(
          (group: unknown) =>
            !Number.isInteger(group) || (group as number) < 0,
        )
      ) {
        throw new Error("groups must be an array of integers >= 0");
      }
      request.groups = input.groups;
    }
    const info = await unaryGuest({ binding }, "startDaemon", request);
    return formatDaemonInfo(info);
  },
  daemon_list: async (resolver, input, exec) => {
    const binding = await resolveToolBinding(
      resolver,
      currentCwd(exec),
      input.container,
    );
    const result = (await unaryGuest(
      { binding },
      "listDaemons",
      {},
    )) as { daemons?: any[] };
    const daemons = result.daemons ?? [];
    return daemons.length > 0
      ? daemons.map(formatDaemonInfo).join("\n")
      : "(no daemons)";
  },
  daemon_stop: async (resolver, input, exec) => {
    const binding = await resolveToolBinding(
      resolver,
      currentCwd(exec),
      input.container,
    );
    return unaryGuest(
      { binding },
      "stopDaemon",
      { name: input.name, signal: input.signal },
    );
  },
  daemon_restart: async (resolver, input, exec) => {
    const binding = await resolveToolBinding(
      resolver,
      currentCwd(exec),
      input.container,
    );
    const info = await unaryGuest(
      { binding },
      "restartDaemon",
      { name: input.name },
    );
    return formatDaemonInfo(info);
  },
  daemon_logs: async (resolver, input, exec) => {
    const binding = await resolveToolBinding(
      resolver,
      currentCwd(exec),
      input.container,
    );
    const result = (await unaryGuest(
      { binding },
      "daemonLogs",
      { name: input.name, tailBytes: input.tailBytes },
    )) as { stdout?: unknown; stderr?: unknown };
    return {
      stdout: bytesText(result.stdout),
      stderr: bytesText(result.stderr),
    };
  },
};

function mountsFromInput(
  mounts: unknown,
): Record<string, unknown>[] | undefined {
  if (!Array.isArray(mounts) || mounts.length === 0) return undefined;
  return mounts.map((mount: any) => {
    const kind = mountKindToProto(mount.kind ?? undefined);
    const mode = mountModeToProto(mount.mode ?? defaultMountMode(mount.kind));
    const result: Record<string, unknown> = { projectName: mount.project ?? "", kind, mode };
    if (mount.path) result.path = mount.path;
    if (mount.destination) result.destination = mount.destination;
    if (mount.volume) result.volume = mount.volume;
    if (mount.secret) result.secret = mount.secret;
    return result;
  });
}

function registerTools(ctx: any, resolver: WorkspaceResolver): void {
  for (const tool of TOOLS) {
    const handler = toolHandlers[tool.name];
    ctx.tools.register(
      defineTool({
        name: tool.name,
        description: TOOL_DESCRIPTIONS[tool.name],
        parameters: tool.parameters,
        ...(tool.approval ? { approval: true } : {}),
        output: toolOutput,
        execute: async (input: any, exec: any) =>
          JSON.stringify(await handler(resolver, input, exec)),
      }),
    );
  }
}
export function createFilesystemProvider(resolver: WorkspaceResolver): FilesystemProvider {
  return {
    resolve: async (path: string, opts?: any) => {
      if (!path.startsWith("/") || path.split("/").includes(".."))
        throw new Error("path must be an absolute safe workspace path");
      return {
        targetKey: path,
        displayPath: path,
        binding: await resolver.resolve(opts?.cwd),
      };
    },
    processPath: (target: any) => target.targetKey,
    fileUrl: (target: any) => `file://${target.targetKey}`,
    contains: (parent: any, child: any) =>
      child.targetKey === parent.targetKey ||
      child.targetKey.startsWith(`${parent.targetKey}/`),
    readText: async (target: any) => {
      const chunks: Buffer[] = [];
      await new Promise<void>((resolveDone, reject) => {
        const call = (target.binding.guest as any).readFile(
          { path: target.targetKey },
          metadata(target.binding.token),
        );
        call.on("data", (chunk: any) => chunks.push(Buffer.from(chunk.data)));
        call.on("error", reject);
        call.on("end", resolveDone);
      });
      return Buffer.concat(chunks).toString("utf8");
    },
    writeText: async (target: any, content: string, expected?: any) => {
      const current = await guestStatResponse(target);
      const currentVersion = current.exists ? guestVersion(current) : undefined;
      if (expected?.kind === "createIfAbsent" && current.exists) {
        throw new Error(`file already exists: ${target.displayPath}`);
      }
      if (
        expected?.kind === "replaceIfVersion" &&
        currentVersion !== expected.version
      ) {
        throw new Error(`file version is stale: ${target.displayPath}`);
      }
      const before = current.exists ? await readRemoteText(target) : null;
      return new Promise((resolveDone, reject) => {
        const call = (target.binding.guest as any).writeFile(
          metadata(target.binding.token),
          {},
          async (error: Error | null, _result: unknown) => {
            if (error) {
              reject(error);
              return;
            }
            try {
              const after = await guestStatResponse(target);
              resolveDone({
                operation: current.exists ? "update" : "create",
                version: guestVersion(after),
                before,
                after: content,
              });
            } catch (statError) {
              reject(statError);
            }
          },
        );
        call.write({
          start: { path: target.targetKey, create: true, truncate: true },
        });
        call.write({ dataChunk: Buffer.from(content) });
        call.end();
      });
    },
    stat: async (target: any) => guestStat(target),
    listDir: async (target: any) =>
      unaryGuest(target, "readDir", { path: target.targetKey }),
    mkdir: async (target: any, parents = true) =>
      unaryGuest(target, "mkdir", { path: target.targetKey, parents }),
    remove: async (target: any, recursive = false) =>
      unaryGuest(target, "delete", { path: target.targetKey, recursive }),
    editText: async (target: any, edit: any) => {
      const before = await readRemoteText(target);
      if (edit.oldString.length === 0)
        throw new Error("oldString must be non-empty");
      const after = edit.replaceAll
        ? before.split(edit.oldString).join(edit.newString)
        : before.replace(edit.oldString, edit.newString);
      if (after === before) throw new Error("oldString was not found");
      await writeGuestFile(
        { guest: target.binding.guest, token: target.binding.token },
        target.targetKey,
        after,
        { create: true, truncate: true },
      );
      return {
        version: `agent:${createHash("sha256").update(after).digest("hex")}`,
        before,
        after,
      };
    },
  };
}

function guestVersion(result: any): string {
  return `agent:${result.modifiedAt ?? ""}:${result.size ?? 0}:${result.mode ?? ""}`;
}

async function writeGuestFile(
  binding: { guest: any; token: string },
  path: string,
  content: string,
  opts: { create: boolean; truncate: boolean },
): Promise<number> {
  return new Promise((resolveDone, reject) => {
    const call = (binding.guest as any).writeFile(
      metadata(binding.token),
      {},
      (error: Error | null, result: any) =>
        error ? reject(error) : resolveDone(Number(result?.bytesWritten ?? 0)),
    );
    call.write({
      start: { path, create: opts.create, truncate: opts.truncate },
    });
    call.write({ dataChunk: Buffer.from(content) });
    call.end();
  });
}

async function readGuestFile(
  binding: { guest: any; token: string },
  path: string,
): Promise<string> {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolveDone, reject) => {
    const call = (binding.guest as any).readFile(
      { path },
      metadata(binding.token),
    );
    call.on("data", (chunk: any) => chunks.push(Buffer.from(chunk.data)));
    call.on("error", reject);
    call.on("end", resolveDone);
  });
  return Buffer.concat(chunks).toString("utf8");
}

async function runExec(
  binding: { guest: any; token: string },
  argv: readonly string[],
  cwd?: string,
  env?: Record<string, string>,
): Promise<{
  exitCode: number;
  signal: string | null;
  stdout: string;
  stderr: string;
}> {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  return new Promise((resolveDone, reject) => {
    const stream = (binding.guest as any).exec(metadata(binding.token));
    stream.on("data", (output: any) => {
      if (output.stdoutChunk) stdout.push(Buffer.from(output.stdoutChunk));
      if (output.stderrChunk) stderr.push(Buffer.from(output.stderrChunk));
      if (output.exit) {
        resolveDone({
          exitCode: output.exit.exitCode,
          signal: output.exit.signaled ? output.exit.signal : null,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
      }
    });
    stream.on("error", reject);
    stream.write({
      start: {
        argv: remoteArgv(argv),
        cwd,
        env: env ?? {},
      },
    });
    stream.end();
  });
}

function outputLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "");
}

function formatDaemonInfo(info: any): string {
  const argv = Array.isArray(info?.argv) ? info.argv.join(" ") : "";
  return `${info.name}  running=${info.running}  exitCode=${info.exitCode ?? ""}  startedAt=${info.startedAt ?? ""}  stoppedAt=${info.stoppedAt ?? ""}  argv=${argv}`;
}

function bytesText(value: unknown): string {
  if (value === undefined) return "";
  return Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
}

function currentCwd(exec: any): unknown {
  return exec?.agent?.session?.header?.cwd;
}

async function sessionWorkspaceSlug(
  resolver: WorkspaceResolver,
  cwd: unknown,
): Promise<string> {
  const workspace = await (resolver as any).registry?.resolveByPath?.(
    String(cwd),
  );
  if (workspace === undefined) return "default";
  return workspaceSlug(String(workspace.id));
}

async function resolveToolBinding(
  resolver: WorkspaceResolver,
  cwd: unknown,
  container: string,
): Promise<{ guest: any; token: string; socket: string }> {
  if (container === "default") return resolver.resolve(cwd);
  return resolver.containerBinding(cwd, container);
}

async function guestStat(target: any): Promise<any> {
  const result = await guestStatResponse(target);
  if (!result.exists) return undefined;
  return {
    version: guestVersion(result),
    type: result.isDir ? "directory" : "file",
    ...(result.isDir ? {} : { size: Number(result.size ?? 0) }),
  };
}

async function guestStatResponse(target: any): Promise<any> {
  return new Promise<any>((resolveDone, reject) =>
    target.binding.guest.stat(
      { path: target.targetKey },
      metadata(target.binding.token),
      (error: Error | null, value: any) =>
        error ? reject(error) : resolveDone(value),
    ),
  );
}

async function readRemoteText(target: any): Promise<string> {
  const chunks: Buffer[] = [];
  await new Promise<void>((resolveDone, reject) => {
    const call = target.binding.guest.readFile(
      { path: target.targetKey },
      metadata(target.binding.token),
    );
    call.on("data", (chunk: any) => chunks.push(Buffer.from(chunk.data)));
    call.on("error", reject);
    call.on("end", resolveDone);
  });
  return Buffer.concat(chunks).toString("utf8");
}
async function unaryGuest(
  target: any,
  method: string,
  request: unknown,
): Promise<unknown> {
  return new Promise((resolveDone, reject) =>
    (target.binding.guest as any)[method](
      request,
      metadata(target.binding.token),
      (error: Error | null, result: unknown) =>
        error ? reject(error) : resolveDone(result),
    ),
  );
}
