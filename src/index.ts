// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { WorkspaceResolver } from "./workspace-binding.js";
import { installContainerSettings } from "./settings-bridge.js";
import { metadata } from "./workspace-binding.js";
import { PassThrough } from "node:stream";
import { createHash } from "node:crypto";

function defineTool<T>(definition: T): T {
  return definition;
}
const toolOutput = {
  schema: { type: "string" },
  render: (_args: unknown, value: string) => [{ type: "text", text: value }],
};
const workspaceParameters = {
  workspace_slug: {
    type: "string",
    required: true,
    description: "Workspace slug.",
  },
  mounts: {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      properties: {
        project_name: { type: "string", required: true },
        mode: {
          type: "string",
          enum: ["read_only", "read_write"],
          required: true,
        },
      },
    },
  },
};
const packageParameters = {
  packages: { type: "array", required: true, items: { type: "string" } },
};
const imageParameters = {
  image_id: { type: "string", required: true },
  base_image: { type: "string" },
  packages: { type: "array", items: { type: "string" } },
};

export const name = "podman";
export const inject = ["tools", "workspaceRegistry"];
export interface PluginConfig {
  controlSocket?: string;
  defaultImage?: string;
  projectsRoot?: string;
}
export function apply(ctx: any, config: PluginConfig = {}): void {
  const resolver = new WorkspaceResolver(
    {
      controlSocket:
        config.controlSocket ??
        process.env.DSH_PODMAN_ORCHESTRATOR_CONTROL_SOCKET ??
        "/run/dsh-sockets/control.sock",
      defaultImage:
        config.defaultImage ?? process.env.DSH_PODMAN_DEFAULT_IMAGE ?? "arch-base",
      projectsRoot: config.projectsRoot ?? "/mnt/project",
    },
    ctx.workspaceRegistry,
  );
  ctx.provide("workspaceResolver", resolver);
  ctx.provide("subprocess", createSubprocessProvider(resolver));
  ctx.provide("fs", createFilesystemProvider(resolver));
  registerTools(ctx, resolver);
  installContainerSettings(ctx, resolver);
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
      await writeGuestFile(target, after);
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

async function writeGuestFile(target: any, content: string): Promise<void> {
  await new Promise<void>((resolveDone, reject) => {
    const call = target.binding.guest.writeFile(
      metadata(target.binding.token),
      {},
      (error: Error | null) => (error ? reject(error) : resolveDone()),
    );
    call.write({
      start: { path: target.targetKey, create: true, truncate: true },
    });
    call.write({ dataChunk: Buffer.from(content) });
    call.end();
  });
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
function defineLifecycleTool(
  ctx: any,
  resolver: WorkspaceResolver,
  name: string,
  description: string,
  method: string,
  parameters: object,
  approval = false,
): void {
  ctx.tools.register(
    defineTool({
      name,
      description,
      parameters,
      ...(approval ? { approval: true } : {}),
      output: toolOutput,
      execute: async (input: any) =>
        JSON.stringify(await unaryControl(resolver, method, input)),
    }),
  );
}
function registerTools(ctx: any, resolver: WorkspaceResolver): void {
  defineLifecycleTool(
    ctx,
    resolver,
    "recreate_workspace",
    "Recreate the current workspace",
    "recreateWorkspace",
    workspaceParameters,
  );
  defineLifecycleTool(
    ctx,
    resolver,
    "rebuild_image",
    "Rebuild a workspace image",
    "rebuildImage",
    imageParameters,
  );
  ctx.tools.register(
    defineTool({
      name: "install_packages",
      description: "Install ephemeral workspace packages",
      parameters: packageParameters,
      output: toolOutput,
      execute: async (input: any, exec: any) => {
        const cwd = exec?.agent?.session?.header?.cwd;
        const binding =
          cwd === undefined
            ? await resolver.resolveSlug(String(input.workspace_slug ?? ""))
            : await resolver.resolve(cwd);
        return JSON.stringify(
          await unaryGuest({ binding }, "installPackages", input),
        );
      },
    }),
  );
  defineLifecycleTool(
    ctx,
    resolver,
    "share_workspace",
    "Request human approval before widening workspace access",
    "recreateWorkspace",
    workspaceParameters,
    true,
  );
}
async function unaryControl(
  resolver: WorkspaceResolver,
  method: string,
  input: unknown,
): Promise<unknown> {
  return resolver.control(method, input);
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
