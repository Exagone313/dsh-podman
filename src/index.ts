// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { WorkspaceResolver, workspaceSlug } from "./workspace-binding.js";
import { installContainerSettings } from "./settings-bridge.js";
import { metadata } from "./workspace-binding.js";
import { PassThrough } from "node:stream";
import { createHash } from "node:crypto";

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
  const imagePrefix = withTrailingSlash(
    config.imagePrefix ?? process.env.DSH_PODMAN_IMAGE_PREFIX ?? "localhost/dsh-podman/",
  );
  const resolver = new WorkspaceResolver(
    {
      socketsRoot:
        config.socketsRoot ??
        process.env.DSH_PODMAN_SOCKETS_ROOT ??
        "/run/dsh-podman",
      defaultImage:
        config.defaultImage ??
        process.env.DSH_PODMAN_DEFAULT_IMAGE ??
        `${imagePrefix}arch-base`,
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
                runInBackground: false,
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
const imageIdParam = { type: "string", description: "Image ID." };
const packageListParam = {
  type: "array",
  items: { type: "string" },
  description: "Package names to install.",
};

export const listImagesParameters = {
  type: "object",
  properties: {},
  required: [] as string[],
};
export const getImageParameters = {
  type: "object",
  properties: { imageId: imageIdParam },
  required: ["imageId"],
};
export const buildImageParameters = {
  type: "object",
  properties: {
    imageId: imageIdParam,
    baseImage: { type: "string", description: "Base image reference." },
    packages: packageListParam,
  },
  required: ["imageId", "baseImage", "packages"],
};
export const rebuildImageParameters = {
  type: "object",
  properties: { imageId: imageIdParam },
  required: ["imageId"],
};
export const listContainersParameters = {
  type: "object",
  properties: {},
  required: [] as string[],
};
export const startContainerParameters = {
  type: "object",
  properties: {
    container: containerParam,
    image: { type: "string", description: "Optional image ID." },
  },
  required: ["container"],
};
export const recreateContainerParameters = {
  type: "object",
  properties: { container: containerParam },
  required: ["container"],
};
export const replaceContainerParameters = {
  type: "object",
  properties: {
    container: containerParam,
    image: { type: "string", description: "Image ID to replace with." },
  },
  required: ["container", "image"],
};
export const removeContainerParameters = {
  type: "object",
  properties: { container: containerParam },
  required: ["container"],
};
export const containerBashParameters = {
  type: "object",
  properties: {
    container: containerParam,
    command: { type: "string", description: "Shell command to run." },
    workdir: { type: "string", description: "Working directory." },
  },
  required: ["container", "command"],
};
export const containerExecParameters = {
  type: "object",
  properties: {
    container: containerParam,
    argv: { type: "array", items: { type: "string" } },
    cwd: { type: "string", description: "Working directory." },
    env: {
      type: "object",
      additionalProperties: { type: "string" },
      description: "Environment variables.",
    },
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

export interface ToolDefinition {
  name: string;
  parameters: {
    type: string;
    properties: Record<string, any>;
    required: readonly string[];
  };
  approval?: boolean;
}

export const TOOLS: ToolDefinition[] = [
  { name: "list_images", parameters: listImagesParameters },
  { name: "get_image", parameters: getImageParameters },
  {
    name: "build_image",
    parameters: buildImageParameters,
    approval: true,
  },
  { name: "rebuild_image", parameters: rebuildImageParameters, approval: true },
  { name: "list_containers", parameters: listContainersParameters },
  { name: "start_container", parameters: startContainerParameters },
  {
    name: "recreate_container",
    parameters: recreateContainerParameters,
    approval: true,
  },
  {
    name: "replace_container",
    parameters: replaceContainerParameters,
    approval: true,
  },
  { name: "remove_container", parameters: removeContainerParameters },
  { name: "container_bash", parameters: containerBashParameters },
  { name: "container_exec", parameters: containerExecParameters },
  { name: "container_read", parameters: containerReadParameters },
  { name: "container_write", parameters: containerWriteParameters },
  { name: "container_edit", parameters: containerEditParameters },
  { name: "container_glob", parameters: containerGlobParameters },
  { name: "container_grep", parameters: containerGrepParameters },
];

const TOOL_DESCRIPTIONS: Record<string, string> = {
  list_images: "List the images available to the current workspace.",
  get_image: "Get details about a specific image.",
  build_image:
    "Build a new workspace image from a base image and a set of packages. Requires approval: building installs packages system-wide into a container image.",
  rebuild_image:
    "Rebuild an existing workspace image. Requires approval: rebuilding replaces the current image content.",
  list_containers:
    "List the containers of the current workspace, including the default container that is started on demand.",
  start_container: "Start a container in the current workspace.",
  recreate_container:
    "Recreate a container in the current workspace. Requires approval: recreating replaces the running container.",
  replace_container:
    "Replace a container in the current workspace with a new image. Requires approval: replacing destroys the existing container.",
  remove_container: "Remove a container from the current workspace.",
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
};

const toolHandlers: Record<
  string,
  (resolver: WorkspaceResolver, input: any, exec: any) => Promise<unknown>
> = {
  list_images: async (resolver) => {
    const result = await resolver.control<{ images?: any[] }>("listImages", {});
    const rows = (result.images ?? []).map((image: any) => {
      const packages = (image.packages ?? []).length > 0
        ? (image.packages ?? []).join(", ")
        : "(none)";
      return `${image.imageId}  base=${image.baseImage}  tag=${image.imageTag}  built=${image.builtAt}  packages=${packages}`;
    });
    return rows.length > 0 ? rows.join("\n") : "(no images)";
  },
  get_image: async (resolver, input) =>
    resolver.control("getImage", { imageId: input.imageId }),
  build_image: async (resolver, input) =>
    resolver.control("buildImage", {
      imageId: input.imageId,
      baseImage: input.baseImage,
      packages: input.packages,
    }),
  rebuild_image: async (resolver, input) =>
    resolver.control("rebuildImage", { imageId: input.imageId }),
  list_containers: async (resolver, _input, exec) => {
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
    const defaultRow = rows.find((row: any) => row.containerName === "default");
    lines.push(
      defaultRow === undefined
        ? "default: not started (will be started on demand)"
        : `default: ${defaultRow.status}${
            defaultRow.imageId ? ` (image ${defaultRow.imageId})` : ""
          }`,
    );
    const named = rows.filter((row: any) => row.containerName !== "default");
    if (named.length === 0) {
      lines.push("named containers: (none)");
    } else {
      lines.push("named containers:");
      for (const row of named) {
        lines.push(
          `  ${row.containerName}: ${row.status}${
            row.imageId ? ` (image ${row.imageId})` : ""
          }`,
        );
      }
    }
    return lines.join("\n");
  },
  start_container: async (resolver, input, exec) =>
    resolver.control("startContainer", {
      workspaceSlug: await sessionWorkspaceSlug(resolver, currentCwd(exec)),
      container: input.container,
      imageId: input.image,
    }),
  recreate_container: async (resolver, input, exec) =>
    resolver.control("recreateContainer", {
      workspaceSlug: await sessionWorkspaceSlug(resolver, currentCwd(exec)),
      container: input.container,
      imageId: "",
    }),
  replace_container: async (resolver, input, exec) =>
    resolver.control("replaceContainer", {
      workspaceSlug: await sessionWorkspaceSlug(resolver, currentCwd(exec)),
      container: input.container,
      imageId: input.image,
    }),
  remove_container: async (resolver, input, exec) =>
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
    return runExec(binding, ["bash", "-lc", input.command], input.workdir);
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
};

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
        runInBackground: false,
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
