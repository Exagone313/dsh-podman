// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { WorkspaceResolver, metadata, workspaceSlug } from "./workspace-binding.js";
import { isAbsolute, resolve as resolvePath } from "node:path";

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
export function guestCwd(
  requested: unknown,
  sessionCwd: unknown,
  binding: { defaultCwd?: string },
): string | undefined {
  return resolveGuestCwd(requested, sessionCwd) ?? binding.defaultCwd;
}

// The path to show in an approval prompt: the resolved target when it can be
// worked out, else the value as given. Never throws — a bad path is reported
// by the handler, and the prompt must still render.
export function approvalPath(path: string, sessionCwd: unknown): string {
  try {
    return resolveGuestPath(path, sessionCwd);
  } catch {
    return path;
  }
}

// Binary detection samples only the head of a file, matching the harness's
// local backend (`fs-local`).
const BINARY_SAMPLE_BYTES = 8192;

// Cap on the contextual-diff basis read before a write; a larger existing file
// yields `before: null`, matching `fs-local`'s default (10 MiB).
export const DIFF_BASIS_MAX_BYTES = 10 * 1024 * 1024;

// Line-ending handling for edits, mirroring `fs-local`: match on LF-normalized
// text, then restore the file's original style on write-back.
export function normalizeLineEndings(content: string): string {
  return content.replaceAll("\r\n", "\n");
}

export function detectLineEndings(raw: string): "CRLF" | "LF" {
  const sample = raw.slice(0, 4096);
  const crlfCount = sample.split("\r\n").length - 1;
  const lfCount = sample.split("\n").length - 1 - crlfCount;
  return crlfCount > lfCount ? "CRLF" : "LF";
}

export function restoreLineEndings(content: string, endings: "CRLF" | "LF"): string {
  return endings === "LF"
    ? content
    : normalizeLineEndings(content).split("\n").join("\r\n");
}

export function fsError(code: string, message: string): Error {
  const error = new Error(message);
  (error as { code?: string }).code = code;
  return error;
}

// The harness's FS_ABORTED: a caller that already cancelled must fail before
// any I/O.
export function throwIfAborted(signal: AbortSignal | undefined, verb: string): void {
  if (signal?.aborted) throw fsError("FS_ABORTED", `${verb} aborted`);
}

// Cancel a gRPC call when the caller aborts; returns a detach function.
function onAbortCancel(call: any, signal: AbortSignal | undefined): () => void {
  if (signal === undefined) return () => {};
  const cancel = (): void => {
    try {
      call.cancel?.();
    } catch {
      // A finished call cannot be cancelled; nothing to do.
    }
  };
  if (signal.aborted) {
    cancel();
    return () => {};
  }
  signal.addEventListener("abort", cancel, { once: true });
  return () => signal.removeEventListener("abort", cancel);
}

// Stream raw bytes from the guest's ReadFile. A zero/absent length reads to
// EOF. Cancelling the signal cancels the call and reports FS_ABORTED.
export async function* guestChunks(
  target: any,
  range: { offset?: number; length?: number } | undefined,
  signal: AbortSignal | undefined,
): AsyncIterable<Buffer> {
  throwIfAborted(signal, "read");
  const request: Record<string, unknown> = { path: target.targetKey };
  if (range?.offset !== undefined && range.offset > 0) {
    request.offset = range.offset;
  }
  if (range?.length !== undefined && range.length > 0) {
    request.length = range.length;
  }
  const call = (target.binding.guest as any).readFile(
    request,
    metadata(target.binding.token),
  );
  const detach = onAbortCancel(call, signal);
  try {
    for await (const chunk of call) {
      yield Buffer.from(chunk.data);
    }
  } catch (error) {
    if (signal?.aborted) throw fsError("FS_ABORTED", "read aborted");
    throw error;
  } finally {
    detach();
  }
}

// Stream the guest file as decoded UTF-8 text, rejecting binary content (a NUL
// byte in the head, or invalid UTF-8) with the harness's FS_NOT_TEXT code.
export async function* guestTextChunks(
  target: any,
  signal: AbortSignal | undefined,
): AsyncIterable<string> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let sampled = 0;
  try {
    for await (const buffer of guestChunks(target, undefined, signal)) {
      if (sampled < BINARY_SAMPLE_BYTES) {
        const sample = buffer.subarray(
          0,
          Math.min(buffer.length, BINARY_SAMPLE_BYTES - sampled),
        );
        if (sample.includes(0)) {
          throw fsError(
            "FS_NOT_TEXT",
            `cannot read "${target.displayPath}": binary file`,
          );
        }
        sampled += sample.length;
      }
      const text = decoder.decode(buffer, { stream: true });
      if (text !== "") yield text;
    }
    const tail = decoder.decode();
    if (tail !== "") yield tail;
  } catch (error) {
    // A fatal TextDecoder failure is a TypeError; anything else (our own
    // FS_NOT_TEXT/FS_ABORTED, or a transport error) keeps its identity.
    if (error instanceof TypeError) {
      throw fsError(
        "FS_NOT_TEXT",
        `cannot read "${target.displayPath}": invalid UTF-8 text`,
      );
    }
    throw error;
  }
}

export async function readGuestText(
  target: any,
  signal: AbortSignal | undefined,
): Promise<string> {
  let text = "";
  for await (const chunk of guestTextChunks(target, signal)) text += chunk;
  return text;
}

// The contextual-diff basis before a write: absent for a create, binary, or
// unreadable prior file (presentation only, never a correctness input).
export async function readDiffBasis(
  target: any,
  signal: AbortSignal | undefined,
): Promise<string | null> {
  try {
    return await readGuestText(target, signal);
  } catch (error) {
    if ((error as { code?: string }).code === "FS_NOT_TEXT") return null;
    throw error;
  }
}

export function guestVersion(result: any): string {
  return `agent:${result.modifiedAt ?? ""}:${result.size ?? 0}:${result.mode ?? ""}`;
}

export async function writeGuestFile(
  binding: { guest: any; token: string },
  path: string,
  content: string,
  opts: { create: boolean; truncate: boolean },
  signal?: AbortSignal,
): Promise<number> {
  throwIfAborted(signal, "write");
  return new Promise((resolveDone, reject) => {
    let detach: () => void = () => {};
    const call = (binding.guest as any).writeFile(
      metadata(binding.token),
      {},
      (error: Error | null, result: any) => {
        detach();
        error
          ? reject(signal?.aborted ? fsError("FS_ABORTED", "write aborted") : error)
          : resolveDone(Number(result?.bytesWritten ?? 0));
      },
    );
    detach = onAbortCancel(call, signal);
    call.write({
      start: { path, create: opts.create, truncate: opts.truncate },
    });
    call.write({ dataChunk: Buffer.from(content) });
    call.end();
  });
}

export async function readGuestFile(
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

export async function runExec(
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
export function sliceLines(content: string, offset: unknown, limit: unknown): string {
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

export function outputLines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line !== "");
}

export function bytesText(value: unknown): string {
  if (value === undefined) return "";
  return Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
}

export function currentCwd(exec: any): unknown {
  return exec?.agent?.session?.header?.cwd;
}

export async function sessionWorkspaceSlug(
  resolver: WorkspaceResolver,
  cwd: unknown,
): Promise<string> {
  const workspace = await (resolver as any).registry?.resolveByPath?.(
    String(cwd),
  );
  if (workspace === undefined) return "default";
  return workspaceSlug(workspace.id);
}

export async function resolveToolBinding(
  resolver: WorkspaceResolver,
  cwd: unknown,
  container: string,
): Promise<{ guest: any; token: string; socket: string; defaultCwd?: string }> {
  if (container === "default") return resolver.resolve(cwd);
  return resolver.containerBinding(cwd, container);
}

export async function guestStat(target: any, signal?: AbortSignal): Promise<any> {
  const result = await guestStatResponse(target, signal);
  if (!result.exists) return undefined;
  return {
    version: guestVersion(result),
    type: result.isDir ? "directory" : "file",
    ...(result.isDir ? {} : { size: Number(result.size ?? 0) }),
  };
}

export function guestStatResponse(target: any, signal?: AbortSignal): Promise<any> {
  throwIfAborted(signal, "stat");
  return new Promise<any>((resolveDone, reject) => {
    let detach: () => void = () => {};
    const call = target.binding.guest.stat(
      { path: target.targetKey },
      metadata(target.binding.token),
      (error: Error | null, value: any) => {
        detach();
        error
          ? reject(signal?.aborted ? fsError("FS_ABORTED", "stat aborted") : error)
          : resolveDone(value);
      },
    );
    detach = onAbortCancel(call, signal);
  });
}

export async function unaryGuest(
  target: any,
  method: string,
  request: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  throwIfAborted(signal, method);
  return new Promise((resolveDone, reject) => {
    let detach: () => void = () => {};
    const call = (target.binding.guest as any)[method](
      request,
      metadata(target.binding.token),
      (error: Error | null, result: unknown) => {
        detach();
        error
          ? reject(
              signal?.aborted ? fsError("FS_ABORTED", `${method} aborted`) : error,
            )
          : resolveDone(result);
      },
    );
    detach = onAbortCancel(call, signal);
  });
}

// remoteArgv rewrites an argv for the guest's execution world: the harness's
// bundled ripgrep becomes the guest's /usr/bin/rg, and a landlock-run sandbox
// wrapper is unwrapped to the command it guards.
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
