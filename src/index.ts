// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { WorkspaceResolver, workspaceSlug } from "./workspace-binding.js";
import { installContainerSettings } from "./settings-bridge.js";
import {
  defaultMountMode,
  mountKindToProto,
  mountKindFromProto,
  mountModeToProto,
  mountModeFromProto,
} from "./mount-enums.js";
import { metadata } from "./workspace-binding.js";
import { PassThrough } from "node:stream";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve as resolvePath } from "node:path";

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

// Prompt section the harness registers to name its own on-disk checkout.
// Mirrors @deepseek-ai/dsh-app-boot's HARNESS_SOURCE_SECTION.
export const HARNESS_SOURCE_SECTION = "harness:source";

// The checkout the section points at lives on the host and is never reachable
// from the workspace container, so the line is false under this plugin. Drop it
// from the assembled prompt without touching any other section.
export function withoutHarnessSourceSection(assembly: any): any {
  return {
    ...assembly,
    sections: assembly.sections.filter(
      (section: any) => section.name !== HARNESS_SOURCE_SECTION,
    ),
  };
}

// Correct the model's host/container mental model: the built-in shell and
// filesystem tools are container-backed too, so there is no host shell.
export function podmanRuntimeSection(): {
  name: string;
  order: number;
  text: string;
} {
  return {
    name: "podman:runtime",
    order: 90,
    text:
      "This session runs inside a Podman workspace. The shell and filesystem " +
      "tools execute in the workspace's default container, not on the host: " +
      "`bash`, `read`, `write`, `edit`, `glob`, and `grep` are all " +
      "container-backed and only see the mounted project and that container's " +
      "filesystem. There is no host shell, and host paths are unavailable. The " +
      "`container_*` tools are the same operations against a named container " +
      '(pass `container`; "default" selects the same default container as ' +
      "`bash`) plus container, image, mount, volume, secret, and daemon management.",
  };
}
export interface PluginConfig {
  socketsRoot?: string;
  defaultImage?: string;
  projectsRoot?: string;
  controlToken?: string;
  imagePrefix?: string;
}
export function apply(ctx: any, config: PluginConfig = {}): void {
  ctx.on(
    "tools/pre-execute",
    (exec: any, next: any) =>
      preExecutePolicy(exec, next, () => resolver.getConfig().projectsRoot),
  );
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
  ctx.inject(["systemPrompt"], (promptCtx: any) => {
    promptCtx.systemPrompt.section(podmanRuntimeSection());
    promptCtx.on(
      "system-prompt/assemble",
      async (_assembly: any, _context: any, next: any) =>
        withoutHarnessSourceSection(await next()),
      { global: true, prepend: true },
    );
  });
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
  switch (inferMountKind(args)) {
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

// The mount kind for a call: an explicit non-empty `kind` wins, otherwise it is
// inferred from the source field the caller supplied (`secret`/`volume`), since
// `kind` is optional in the mount schemas. Falls back to a project mount.
export function inferMountKind(args: {
  kind?: unknown;
  project?: unknown;
  volume?: unknown;
  secret?: unknown;
}): string {
  if (typeof args.kind === "string" && args.kind !== "") return args.kind;
  if (typeof args.secret === "string" && args.secret !== "") return "secret";
  if (typeof args.volume === "string" && args.volume !== "") return "volume";
  return "project";
}

// The container-side destination a project mount always lands at: the project
// root under projectsRoot plus the optional subpath. The container never gets a
// caller-chosen destination for a project mount.
export function projectMountMirror(
  projectsRoot: string,
  project: string,
  path: unknown,
): string {
  return [projectsRoot, project, path]
    .filter((part) => typeof part === "string" && part !== "")
    .join("/");
}

// The reason to deny a mount item that carries a destination on a project (or
// unnamed) mount, or undefined when the item is allowed. Project mounts never
// take a destination; without one the directory lands at its project root.
export function projectMountDestinationReason(
  projectsRoot: string | undefined,
  args: {
    kind?: unknown;
    project?: unknown;
    path?: unknown;
    destination?: unknown;
  },
): string | undefined {
  if (inferMountKind(args) !== "project") return undefined;
  if (args.destination === undefined || args.destination === "") return undefined;
  const mirror =
    projectsRoot === undefined
      ? ""
      : projectMountMirror(
          projectsRoot,
          typeof args.project === "string" ? args.project : "",
          args.path,
        );
  return mirror === ""
    ? "project mounts do not accept a destination"
    : `project mounts do not accept a destination; the directory will be mounted at ${mirror}`;
}

// Resolve a container-side path against the session working directory.
// Absolute paths pass through unchanged. The session cwd and the container's
// view of the project coincide because the orchestrator mounts each project at
// its mirrored path under DSH_PODMAN_PROJECTS_ROOT.
function resolveAgainstSession(path: string, sessionCwd: unknown): string {
  if (isAbsolute(path)) return path;
  const base =
    typeof sessionCwd === "string" && sessionCwd !== "" ? sessionCwd : undefined;
  if (base === undefined) {
    throw new Error(
      "relative paths need a session working directory; pass an absolute path",
    );
  }
  return resolvePath(base, path);
}

// Resolve a guest filesystem path against the session working directory.
//
// A ".." segment is refused before resolution: afterwards it would have been
// normalised away, and the guest agent would reject the result with a less
// helpful error. The guest agent confines these paths to the projects root, so
// this is a clearer error rather than the boundary itself.
export function resolveGuestPath(path: string, sessionCwd: unknown): string {
  if (path.split("/").includes("..")) {
    throw new Error("path must not escape the workspace");
  }
  return resolveAgainstSession(path, sessionCwd);
}

// Resolve a working directory, or a path handed to a command, against the
// session working directory. An unset value stays unset, leaving the guest
// agent's own working directory in place.
//
// Unlike resolveGuestPath this does not refuse "..": commands are not confined
// to the projects root, so rejecting it would be theatre while breaking a
// legitimate "../sibling" working directory.
export function resolveGuestCwd(
  cwd: unknown,
  sessionCwd: unknown,
): string | undefined {
  if (typeof cwd !== "string" || cwd === "") return undefined;
  return resolveAgainstSession(cwd, sessionCwd);
}

// guestCwd resolves a command's working directory: an explicit value is
// resolved against the session, otherwise the container's default (the session
// directory when it is mounted) is used. Undefined leaves the guest agent's own
// working directory in place.
function guestCwd(
  requested: unknown,
  sessionCwd: unknown,
  binding: { defaultCwd?: string },
): string | undefined {
  return resolveGuestCwd(requested, sessionCwd) ?? binding.defaultCwd;
}

// The path to show in an approval prompt: the resolved target when it can be
// worked out, else the value as given. Never throws — a bad path is reported
// by the handler, and the prompt must still render.
function approvalPath(path: string, sessionCwd: unknown): string {
  try {
    return resolveGuestPath(path, sessionCwd);
  } catch {
    return path;
  }
}

// Build the single-line approval summary shown for a gated tool call.
//
// sessionCwd is used to name the resolved target of a relative path, so the
// prompt describes the file that will actually be touched.
export function summarizeArgs(
  name: string,
  args: Record<string, unknown>,
  sessionCwd?: unknown,
): string {
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
      const path = str("file_path");
      if (container === undefined || path === undefined) return "";
      return `write ${approvalPath(path, sessionCwd)} in container ${container}`;
    }
    case "container_edit": {
      const container = str("container");
      const path = str("file_path");
      if (container === undefined || path === undefined) return "";
      return `edit ${approvalPath(path, sessionCwd)} in container ${container}`;
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

// The ask reason, omitted when no summary can be derived so the approval panel
// shows its own localized fallback instead of a blank headline (the panel only
// substitutes for a nullish reason, not an empty string).
function askReason(
  name: string,
  args: Record<string, unknown>,
  sessionCwd?: unknown,
): { reason?: string } {
  const reason = summarizeArgs(name, args, sessionCwd);
  return reason === "" ? {} : { reason };
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
  sessionCwd?: unknown,
): { kind: "ask"; reason?: string } | undefined {
  const tool = TOOLS.find((entry) => entry.name === name);
  if (tool === undefined) return undefined;
  if (tool.approval === true) {
    return { kind: "ask", ...askReason(name, args ?? {}, sessionCwd) };
  }
  if (tool.approvalWhen !== undefined && tool.approvalWhen(args ?? {})) {
    return { kind: "ask", ...askReason(name, args ?? {}, sessionCwd) };
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
  getProjectsRoot?: () => string,
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
  const args = exec.arguments;
  const parsed =
    typeof args === "object" && args !== null ? (args as Record<string, unknown>) : undefined;
  const projectsRoot = getProjectsRoot?.();
  const denyReason = mountDestinationsReason(name, parsed, projectsRoot);
  if (denyReason !== undefined) {
    return { kind: "deny", reason: denyReason };
  }
  if (foldApprovalPolicy(events) === "never") return next();
  const preset = exec.agent?.session?.header?.agentPreset;
  const sessionCwd = currentCwd(exec);
  if (preset === PODMAN_OPS_PRESET && PODMAN_OPS_APPROVAL_TOOLS.has(name)) {
    return { kind: "ask", ...askReason(name, parsed ?? {}, sessionCwd) };
  }
  return approvalDecision(name, parsed, sessionCwd) ?? next();
}

// The reason to deny a mount-bearing tool call that puts a destination on a
// project (or unnamed) mount, or undefined when the call is allowed. Checks the
// single-item tools (container_mount_add/remove) and the mounts arrays of
// container_start/container_recreate.
export function mountDestinationsReason(
  name: string,
  args: Record<string, unknown> | undefined,
  projectsRoot: string | undefined,
): string | undefined {
  if (args === undefined) return undefined;
  if (name === "container_mount_add" || name === "container_mount_remove") {
    return projectMountDestinationReason(projectsRoot, args);
  }
  if (name === "container_start" || name === "container_recreate") {
    const mounts = args.mounts;
    if (!Array.isArray(mounts)) return undefined;
    for (const item of mounts) {
      if (typeof item !== "object" || item === null) continue;
      const reason = projectMountDestinationReason(projectsRoot, item as Record<string, unknown>);
      if (reason !== undefined) return reason;
    }
  }
  return undefined;
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
    "Add a project mount to a container in the current workspace. Requires approval: adding a mount changes the container filesystem view.",
  container_mount_remove:
    "Remove a project mount from a container in the current workspace. Requires approval: removing a mount changes the container filesystem view.",
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
    "Inject a named secret into a container as an environment variable. Requires approval: exposing a secret to a container changes what it can read.",
  container_secret_remove:
    "Stop injecting a named secret into a container environment variable. Requires approval: removing a secret exposure changes what the container can read.",
  daemon_start:
    "Start a daemon inside a container of the current workspace. Optionally run it as a specific uid/gid (with optional supplementary groups). The daemon inherits the container's environment by default; pass inheritEnv=false to give it only PATH, HOME, and env. Defaults to the session working directory when it is mounted; pass cwd to override. An existing daemon with the same name is stopped and replaced.",
  daemon_list:
    "List the daemons running inside a container of the current workspace.",
  daemon_stop: "Stop a daemon inside a container of the current workspace.",
  daemon_restart:
    "Restart a daemon inside a container of the current workspace.",
  daemon_logs:
    "Read the captured logs of a daemon inside a container of the current workspace.",
};

// Cap on paths `container_glob` returns, matching the built-in glob tool's
// default result limit; `--sort=modified` makes the retained head the newest.
const GLOB_MAX_RESULTS = 100;

// VCS metadata directories ripgrep must never descend into for a discovery
// listing (`--no-ignore --hidden` would otherwise surface them).
const GLOB_VCS_EXCLUDES = [".git", ".svn", ".hg", ".bzr", ".jj", ".sl"];

export const toolHandlers: Record<
  string,
  (resolver: WorkspaceResolver, input: any, exec: any) => Promise<unknown>
> = {
  image_list: async (resolver) => {
    const result = await resolver.control<{ images?: any[] }>("listImages", {});
    return (result.images ?? []).map(publicImage);
  },
  image_get: async (resolver, input) =>
    publicImage(
      await resolver.control("getImage", { imageId: input.imageId }),
    ),
  image_build: async (resolver, input) =>
    publicImage(
      await resolver.control("buildImage", {
        imageId: input.imageId,
        parent: input.parent,
        packages: input.packages,
      }),
    ),
  image_rebuild: async (resolver, input) =>
    publicImage(
      await resolver.control("rebuildImage", { imageId: input.imageId }),
    ),
  image_rebuild_all: async (resolver) => {
    const result = await resolver.control<{ rebuilt?: string[]; skipped?: string[] }>(
      "rebuildAllImages",
      {},
    );
    return {
      rebuilt: result.rebuilt ?? [],
      skipped: result.skipped ?? [],
    };
  },
  image_remove: async (resolver, input) => {
    await resolver.control("removeImage", { imageId: input.imageId });
    return { removed: input.imageId };
  },
  container_list: async (resolver, _input, exec) => {
    const slug = await sessionWorkspaceSlug(resolver, currentCwd(exec));
    const result = await resolver.control<{ containers?: any[] }>(
      "listContainers",
      {},
    );
    const rows = (result.containers ?? []).filter(
      (row: any) => row.workspaceSlug === slug,
    );
    const defaultRow = rows.find((row: any) => row.containerName === "default");
    const listed = defaultRow === undefined
      ? [{ containerName: "default", status: "not started" }]
      : [publicContainer(defaultRow)];
    return [
      ...listed,
      ...rows
        .filter((row: any) => row.containerName !== "default")
        .map(publicContainer),
    ];
  },
  container_start: async (resolver, input, exec) => {
    const mounts = mountsFromInput(input.mounts);
    const row = await resolver.control("startContainer", {
      workspaceSlug: await sessionWorkspaceSlug(resolver, currentCwd(exec)),
      container: input.container,
      imageId: input.image,
      ...(mounts === undefined ? {} : { mounts }),
      ...(input.env !== undefined ? { env: input.env } : {}),
      ...(input.secretEnv !== undefined ? { secretEnv: input.secretEnv } : {}),
    });
    return publicContainer(row);
  },
  container_recreate: async (resolver, input, exec) => {
    const mounts = mountsFromInput(input.mounts);
    const row = await resolver.control("recreateContainer", {
      workspaceSlug: await sessionWorkspaceSlug(resolver, currentCwd(exec)),
      container: input.container,
      imageId: input.image ?? "",
      ...(mounts === undefined ? {} : { mounts }),
      ...(input.env !== undefined ? { env: input.env } : {}),
      ...(input.secretEnv !== undefined ? { secretEnv: input.secretEnv } : {}),
    });
    return {
      ...publicContainer(row),
      containerName: input.container || "default",
    };
  },
  container_remove: async (resolver, input, exec) => {
    await resolver.control("removeContainer", {
      workspaceSlug: await sessionWorkspaceSlug(resolver, currentCwd(exec)),
      container: input.container,
    });
    return { removed: input.container };
  },
  container_bash: async (resolver, input, exec) => {
    const sessionCwd = currentCwd(exec);
    const binding = await resolveToolBinding(resolver, sessionCwd, input.container);
    return runExec(
      binding,
      ["bash", "-lc", input.command],
      guestCwd(input.workdir, sessionCwd, binding),
      input.env,
      input.timeoutMs,
    );
  },
  container_exec: async (resolver, input, exec) => {
    const sessionCwd = currentCwd(exec);
    const binding = await resolveToolBinding(resolver, sessionCwd, input.container);
    return runExec(
      binding,
      input.argv,
      guestCwd(input.workdir, sessionCwd, binding),
      input.env,
      input.timeoutMs,
    );
  },
  container_read: async (resolver, input, exec) => {
    const sessionCwd = currentCwd(exec);
    const binding = await resolveToolBinding(resolver, sessionCwd, input.container);
    const content = await readGuestFile(
      binding,
      resolveGuestPath(input.file_path, sessionCwd),
    );
    return sliceLines(content, input.offset, input.limit);
  },
  container_write: async (resolver, input, exec) => {
    const sessionCwd = currentCwd(exec);
    const binding = await resolveToolBinding(resolver, sessionCwd, input.container);
    const path = resolveGuestPath(input.file_path, sessionCwd);
    const bytesWritten = await writeGuestFile(binding, path, input.content, {
      create: input.create ?? true,
      truncate: input.truncate ?? true,
    });
    return { bytesWritten };
  },
  container_edit: async (resolver, input, exec) => {
    const sessionCwd = currentCwd(exec);
    const binding = await resolveToolBinding(resolver, sessionCwd, input.container);
    const path = resolveGuestPath(input.file_path, sessionCwd);
    const before = await readGuestFile(binding, path);
    if (typeof input.old_string !== "string" || input.old_string.length === 0) {
      throw new Error("old_string must be a non-empty string");
    }
    const occurrences = before.split(input.old_string).length - 1;
    if (occurrences === 0) throw new Error("old_string was not found");
    if (!input.replace_all && occurrences > 1) {
      throw new Error(
        "old_string appears more than once; set replace_all to replace every occurrence",
      );
    }
    const after = input.replace_all
      ? before.split(input.old_string).join(input.new_string)
      : before.replace(input.old_string, input.new_string);
    await writeGuestFile(binding, path, after, {
      create: true,
      truncate: true,
    });
    return { before, after };
  },
  container_glob: async (resolver, input, exec) => {
    const sessionCwd = currentCwd(exec);
    const binding = await resolveToolBinding(resolver, sessionCwd, input.container);
    const argv = [
      "rg",
      "--files",
      `--glob=${input.pattern}`,
      "--sort=modified",
      "--no-ignore",
      "--hidden",
      ...GLOB_VCS_EXCLUDES.flatMap((name) => [
        `--glob=!**/${name}`,
        `--glob=!**/${name}/**`,
      ]),
    ];
    const result = await runExec(
      binding,
      argv,
      guestCwd(input.path, sessionCwd, binding),
    );
    const files = outputLines(result.stdout);
    const capped = files.length > GLOB_MAX_RESULTS;
    return {
      files: capped ? files.slice(0, GLOB_MAX_RESULTS) : files,
      ...(capped
        ? {
            note: `showing ${GLOB_MAX_RESULTS} of ${files.length} files in modification-time order; narrow pattern or path to see more`,
          }
        : {}),
      ...(result.stderr ? { stderr: result.stderr.trim() } : {}),
    };
  },
  container_grep: async (resolver, input, exec) => {
    const sessionCwd = currentCwd(exec);
    const binding = await resolveToolBinding(resolver, sessionCwd, input.container);
    const cwd = binding.defaultCwd;
    const path = resolveGuestCwd(input.path, cwd ?? sessionCwd);
    const argv = ["rg", "-n"];
    if (typeof input.include === "string" && input.include !== "") {
      argv.push("--glob", input.include);
    }
    argv.push(input.pattern);
    if (path) argv.push(path);
    const result = await runExec(binding, argv, cwd);
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
    return mounts.map(publicMount);
  },
  container_mount_add: async (resolver, input, exec) => {
    const kind = inferMountKind(input);
    const projectsRoot = resolver.getConfig().projectsRoot;
    const destinationReason = projectMountDestinationReason(projectsRoot, input);
    if (destinationReason !== undefined) throw new Error(destinationReason);
    const protoKind = mountKindToProto(kind);
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
      request.mode = mode;
    }
    const row = await resolver.control("addContainerMount", request);
    return publicContainer(row);
  },
  container_mount_remove: async (resolver, input, exec) => {
    const kind = inferMountKind(input);
    const protoKind = mountKindToProto(kind);
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
    if (kind !== "project" && input.destination !== undefined) {
      request.destination = input.destination;
    }
    const row = await resolver.control("removeContainerMount", request);
    return publicContainer(row);
  },
  volume_list: async (resolver) => {
    const result = await resolver.control<{ volumes?: any[] }>("listVolumes", {});
    return (result.volumes ?? []).map((volume: any) => ({ name: volume.name }));
  },
  volume_create: async (resolver, input) => {
    await resolver.control("createVolume", { name: input.name });
    return { name: input.name };
  },
  volume_remove: async (resolver, input) => {
    await resolver.control("removeVolume", { name: input.name });
    return { removed: input.name };
  },
  secret_list: async (resolver) => {
    const result = await resolver.control<{ secrets?: any[] }>("listSecrets", {});
    return (result.secrets ?? []).map((secret: any) => ({ name: secret.name }));
  },
  secret_create: async (resolver, input) => {
    await resolver.control("createSecret", {
      name: input.name,
      ...(input.length ? { length: input.length } : {}),
      ...(input.charset ? { charset: input.charset } : {}),
    });
    return { name: input.name };
  },
  secret_remove: async (resolver, input) => {
    await resolver.control("removeSecret", { name: input.name });
    return { removed: input.name };
  },
  container_secret_add: async (resolver, input, exec) => {
    const row = await resolver.control("addContainerSecret", {
      workspaceSlug: await sessionWorkspaceSlug(resolver, currentCwd(exec)),
      container: input.container,
      env: input.env,
      secret: input.secret,
    });
    return publicContainer(row);
  },
  container_secret_remove: async (resolver, input, exec) => {
    const row = await resolver.control("removeContainerSecret", {
      workspaceSlug: await sessionWorkspaceSlug(resolver, currentCwd(exec)),
      container: input.container,
      env: input.env,
    });
    return publicContainer(row);
  },
  daemon_start: async (resolver, input, exec) => {
    const sessionCwd = currentCwd(exec);
    const binding = await resolveToolBinding(resolver, sessionCwd, input.container);
    const request: Record<string, unknown> = {
      argv: input.argv,
      inheritEnv: { value: input.inheritEnv !== false },
    };
    if (input.name !== undefined) request.name = input.name;
    const cwd = guestCwd(input.cwd, sessionCwd, binding);
    if (cwd !== undefined) request.cwd = cwd;
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
    return publicDaemon(info);
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
    return (result.daemons ?? []).map(publicDaemon);
  },
  daemon_stop: async (resolver, input, exec) => {
    const binding = await resolveToolBinding(
      resolver,
      currentCwd(exec),
      input.container,
    );
    await unaryGuest(
      { binding },
      "stopDaemon",
      { name: input.name, signal: input.signal },
    );
    return { stopped: input.name };
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
    return publicDaemon(info);
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
    const inferredKind = inferMountKind(mount);
    const kind = mountKindToProto(inferredKind);
    const mode = mountModeToProto(mount.mode ?? defaultMountMode(inferredKind));
    const result: Record<string, unknown> = { projectName: mount.project ?? "", kind, mode };
    if (mount.path) result.path = mount.path;
    if (inferredKind !== "project" && mount.destination) {
      result.destination = mount.destination;
    }
    if (mount.volume) result.volume = mount.volume;
    if (mount.secret) result.secret = mount.secret;
    return result;
  });
}

// UI title and icon category per tool, used by the host presenters so a UI can
// label a call meaningfully instead of showing the raw tool name.
const TOOL_UI: Record<string, { title: string; kind: string }> = {
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

// The command tools render as terminal cards; every other tool gets a generic
// card with its UI title. Views are recomputed on each delivery and never
// persisted (see the harness tool-presentation contract).
export function toolCallView(name: string, args: any): unknown {
  if (name === "container_bash" || name === "container_exec") {
    const command =
      name === "container_bash"
        ? String(args?.command ?? "")
        : Array.isArray(args?.argv)
          ? args.argv.map((item: unknown) => String(item)).join(" ")
          : "";
    return {
      card: "terminal",
      title: command,
      ...(typeof args?.description === "string" && args.description !== ""
        ? { description: args.description }
        : {}),
    };
  }
  const ui = TOOL_UI[name];
  if (ui === undefined) return undefined;
  return { card: "generic", title: ui.title, kind: ui.kind };
}

export function toolResultView(
  name: string,
  _args: any,
  result: any,
): unknown {
  if (result?.isError) return undefined;
  if (name !== "container_bash" && name !== "container_exec") return undefined;
  const text = (result?.content ?? [])
    .filter((block: any) => block?.type === "text")
    .map((block: any) => block.text)
    .join("");
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (data === null || typeof data !== "object") return undefined;
  const output = [data.stdout, data.stderr]
    .filter((value: unknown) => typeof value === "string" && value !== "")
    .join("");
  return {
    card: "terminal",
    output,
    ...(data.signal
      ? { signal: String(data.signal) }
      : { exitCode: Number(data.exitCode ?? 0) }),
  };
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
        presentCall: (args: any) => toolCallView(tool.name, args),
        presentResult: (args: any, result: any) =>
          toolResultView(tool.name, args, result),
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
      const resolved = resolveGuestPath(path, opts?.cwd);
      return {
        targetKey: resolved,
        displayPath: resolved,
        binding: await resolver.resolveForPath(resolved, opts?.cwd),
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

const READ_LIMIT = 2000;

async function runExec(
  binding: { guest: any; token: string },
  argv: readonly string[],
  cwd?: string,
  env?: Record<string, string>,
  timeoutMs?: number,
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
    let processId: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stopTimer = (): void => {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    };
    if (typeof timeoutMs === "number" && timeoutMs > 0) {
      timer = setTimeout(() => {
        timer = undefined;
        if (processId !== undefined) {
          // Best effort: ask the guest to terminate the running process.
          unaryGuest({ binding }, "signal", {
            processId,
            signal: "SIGTERM",
          }).catch(() => {});
        }
        reject(new Error(`command timed out after ${timeoutMs} ms`));
      }, timeoutMs);
    }
    stream.on("data", (output: any) => {
      if (output.processId) processId = String(output.processId);
      if (output.stdoutChunk) stdout.push(Buffer.from(output.stdoutChunk));
      if (output.stderrChunk) stderr.push(Buffer.from(output.stderrChunk));
      if (output.exit) {
        stopTimer();
        resolveDone({
          exitCode: output.exit.exitCode,
          signal: output.exit.signaled ? output.exit.signal : null,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
      }
    });
    stream.on("error", (error: unknown) => {
      stopTimer();
      reject(error);
    });
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

// sliceLines returns the requested 1-based line range of a file's content,
// defaulting to the first READ_LIMIT lines like the harness's read tool.
function sliceLines(content: string, offset: unknown, limit: unknown): string {
  const start =
    typeof offset === "number" && Number.isInteger(offset) && offset > 0
      ? offset
      : 1;
  const max =
    typeof limit === "number" && Number.isInteger(limit) && limit > 0
      ? limit
      : READ_LIMIT;
  return content.split("\n").slice(start - 1, start - 1 + max).join("\n");
}

function outputLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "");
}

// Rebuild API objects so tool results never expose internal fields (see
// AGENTS.md "Security"): only allow-listed attributes reach the model.
export function publicMount(mount: any): Record<string, unknown> {
  const kind = mountKindFromProto(mount?.kind);
  const mode = mountModeFromProto(mount?.mode);
  return {
    ...(mount?.projectName ? { projectName: mount.projectName } : {}),
    ...(mount?.path ? { path: mount.path } : {}),
    ...(mount?.destination ? { destination: mount.destination } : {}),
    ...(mount?.volume ? { volume: mount.volume } : {}),
    ...(mount?.secret ? { secret: mount.secret } : {}),
    ...(kind !== undefined ? { kind } : {}),
    ...(mode !== undefined ? { mode } : {}),
  };
}

export function publicContainer(row: any): Record<string, unknown> {
  return {
    containerName: row?.containerName ?? "",
    status: row?.status ?? "",
    ...(row?.imageId ? { imageId: row.imageId } : {}),
    mounts: (row?.mounts ?? []).map(publicMount),
    env: row?.env ?? {},
    secretEnv: row?.secretEnv ?? {},
  };
}

export function publicImage(image: any): Record<string, unknown> {
  return {
    imageId: image?.imageId ?? "",
    ...(image?.parent ? { parent: image.parent } : {}),
    packages: image?.packages ?? [],
    isBase: image?.isBase ?? false,
    status: image?.status ?? "",
    ...(image?.primitive ? { primitive: image.primitive } : {}),
    ...(image?.packageManager ? { packageManager: image.packageManager } : {}),
    ...(image?.builtAt ? { builtAt: image.builtAt } : {}),
    basePublic: image?.basePublic ?? false,
    ...(image?.imageTag ? { imageTag: image.imageTag } : {}),
  };
}

export function publicDaemon(info: any): Record<string, unknown> {
  return {
    name: info?.name ?? "",
    argv: info?.argv ?? [],
    running: info?.running ?? false,
    ...(info?.exitCode !== undefined && info?.exitCode !== null
      ? { exitCode: info.exitCode }
      : {}),
    ...(info?.startedAt ? { startedAt: info.startedAt } : {}),
    ...(info?.stoppedAt ? { stoppedAt: info.stoppedAt } : {}),
    ...(info?.uid !== undefined && info?.uid !== null ? { uid: info.uid } : {}),
    ...(info?.gid !== undefined && info?.gid !== null ? { gid: info.gid } : {}),
  };
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
): Promise<{ guest: any; token: string; socket: string; defaultCwd?: string }> {
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
