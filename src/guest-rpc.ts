// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import {
  type WorkspaceBinding,
  WorkspaceResolver,
  metadata,
  workspaceSlug,
} from "./workspace-binding.js";
import { grpc } from "./grpc/runtime-client.js";
import {
  SPILL_ROOT,
  discardUnneededSpill,
  outputReader,
} from "./output-reader.js";
import { randomUUID } from "node:crypto";
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

// isUnauthenticated reports whether a guest call failed because the agent
// rejected the caller's credential.
function isUnauthenticated(error: unknown): boolean {
  return (error as { code?: unknown })?.code === grpc.status.UNAUTHENTICATED;
}

// withGuestAuth runs a guest call and, when the agent rejects the credential,
// refreshes the binding once and retries. A rejection happens in the agent's
// auth interceptor, before the handler runs, so the retry cannot duplicate a
// side effect; a second rejection propagates.
export async function withGuestAuth<T>(
  binding: WorkspaceBinding,
  run: (guest: any, token: string) => Promise<T>,
): Promise<T> {
  try {
    return await run(binding.guest, binding.token);
  } catch (error) {
    if (!isUnauthenticated(error) || binding.refresh === undefined) throw error;
    const refreshed = await binding.refresh();
    return await run(refreshed.guest, refreshed.token);
  }
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
  // The read is retried once with a refreshed binding when the agent rejects
  // the credential, but only before any byte was emitted, so a retry can never
  // duplicate output.
  let binding = target.binding as WorkspaceBinding;
  for (let attempt = 0; ; attempt++) {
    const call = (binding.guest as any).readFile(
      request,
      metadata(binding.token),
    );
    const detach = onAbortCancel(call, signal);
    let emitted = false;
    try {
      for await (const chunk of call) {
        emitted = true;
        yield Buffer.from(chunk.data);
      }
      return;
    } catch (error) {
      if (signal?.aborted) throw fsError("FS_ABORTED", "read aborted");
      if (
        attempt === 0 &&
        !emitted &&
        isUnauthenticated(error) &&
        binding.refresh !== undefined
      ) {
        binding = await binding.refresh();
        continue;
      }
      throw error;
    } finally {
      detach();
    }
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
  binding: WorkspaceBinding,
  path: string,
  content: string,
  opts: { create: boolean; truncate: boolean },
  signal?: AbortSignal,
): Promise<number> {
  throwIfAborted(signal, "write");
  return withGuestAuth(binding, (guest, token) =>
    new Promise((resolveDone, reject) => {
      let detach: () => void = () => {};
      const call = guest.writeFile(
        metadata(token),
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
    }),
  );
}

export async function readGuestFile(
  binding: WorkspaceBinding,
  path: string,
): Promise<string> {
  return withGuestAuth(binding, (guest, token) =>
    new Promise<string>((resolveDone, reject) => {
      const chunks: Buffer[] = [];
      const call = guest.readFile({ path }, metadata(token));
      call.on("data", (chunk: any) => chunks.push(Buffer.from(chunk.data)));
      call.on("error", reject);
      call.on("end", () => resolveDone(Buffer.concat(chunks).toString("utf8")));
    }),
  );
}

const READ_LIMIT = 2000;

// The optional process identity a command may run as. Omitted fields mean "no
// override"; groups is the complete supplementary set.
export interface ExecIdentity {
  uid?: number;
  gid?: number;
  groups?: number[];
}

// In-memory retention per stream for one command. The full stream is also
// written to a bounded guest spill file, so the plugin never buffers an
// unbounded command output and the caller can read the rest back with
// container_read.
const EXEC_RETAIN_BYTES = 1 << 20;
const EXEC_SPILL_BYTES = 8 << 20;

// The optional per-call controls runExec accepts. `signal` cancels the turn's
// command; the byte caps override the retention/spill bounds.
export interface RunExecOptions {
  signal?: AbortSignal;
  maxBytes?: number;
  spillBytes?: number;
}

export async function runExec(
  binding: WorkspaceBinding,
  argv: readonly string[],
  cwd?: string,
  env?: Record<string, string>,
  timeoutMs?: number,
  identity?: ExecIdentity,
  options: RunExecOptions = {},
): Promise<{
  exitCode: number;
  signal: string | null;
  stdout: string;
  stderr: string;
  stdoutSpillPath?: string;
  stderrSpillPath?: string;
}> {
  const signal = options.signal;
  throwIfAborted(signal, "exec");
  const maxBytes = options.maxBytes ?? EXEC_RETAIN_BYTES;
  const spillBytes = options.spillBytes ?? EXEC_SPILL_BYTES;
  const stdoutSpec = { path: `${SPILL_ROOT}/${randomUUID()}.stdout`, maxBytes: spillBytes };
  const stderrSpec = { path: `${SPILL_ROOT}/${randomUUID()}.stderr`, maxBytes: spillBytes };
  return withGuestAuth(binding, (guest, token) =>
    new Promise((resolveDone, reject) => {
      const stdoutReader = outputReader({ maxBytes }, stdoutSpec);
      const stderrReader = outputReader({ maxBytes }, stderrSpec);
      if (stdoutReader === undefined || stderrReader === undefined) {
        reject(new Error("exec output reader is unavailable"));
        return;
      }
      const stream = (guest as any).exec(metadata(token));
      let processId: string | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      let detach: () => void = () => {};
      // settle runs one final action exactly once and tears down the timer and
      // the abort listener, so a timeout, an abort, and an exit cannot race.
      const settle = (finish: () => void): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        detach();
        finish();
      };
      const stopProcess = (sig: string): void => {
        if (processId === undefined) return;
        // Best effort: ask the guest to terminate the running process tree.
        unaryGuest({ binding: { guest, token } }, "signal", {
          processId,
          signal: sig,
        }).catch(() => {});
      };
      const abortWith = (error: Error): void => {
        stopProcess("SIGTERM");
        try {
          stream.cancel?.();
        } catch {
          // The stream already ended; nothing to cancel.
        }
        settle(() => reject(error));
      };
      if (typeof timeoutMs === "number" && timeoutMs > 0) {
        timer = setTimeout(() => {
          timer = undefined;
          abortWith(new Error(`command timed out after ${timeoutMs} ms`));
        }, timeoutMs);
      }
      if (signal !== undefined) {
        if (signal.aborted) {
          abortWith(fsError("FS_ABORTED", "exec aborted"));
          return;
        }
        const onAbort = (): void =>
          abortWith(fsError("FS_ABORTED", "exec aborted"));
        signal.addEventListener("abort", onAbort, { once: true });
        detach = () => signal.removeEventListener("abort", onAbort);
      }
      stream.on("data", (output: any) => {
        if (output.processId) processId = String(output.processId);
        if (output.stdoutChunk) {
          stdoutReader.append(Buffer.from(output.stdoutChunk));
        }
        if (output.stderrChunk) {
          stderrReader.append(Buffer.from(output.stderrChunk));
        }
        if (output.exit) {
          stdoutReader.setSpillValid(Boolean(output.exit.stdoutSpillValid));
          stderrReader.setSpillValid(Boolean(output.exit.stderrSpillValid));
          const out = stdoutReader.readFrom(0);
          const err = stderrReader.readFrom(0);
          // A spill the in-memory tail already covered is deleted; a valid one
          // holding dropped output stays for the caller to read.
          discardUnneededSpill({ guest, token }, stdoutReader);
          discardUnneededSpill({ guest, token }, stderrReader);
          settle(() =>
            resolveDone({
              exitCode: output.exit.exitCode,
              signal: output.exit.signaled ? output.exit.signal : null,
              stdout: out.text,
              stderr: err.text,
              ...(out.spillPath === undefined
                ? {}
                : { stdoutSpillPath: out.spillPath }),
              ...(err.spillPath === undefined
                ? {}
                : { stderrSpillPath: err.spillPath }),
            }),
          );
        }
      });
      stream.on("error", (error: unknown) => settle(() => reject(error)));
      stream.on("end", () =>
        // A stream that ends without an exit message (guest restart, dropped
        // socket) must not leave the caller pending forever.
        settle(() =>
          reject(new Error("exec stream ended before the process exited")),
        ),
      );
      stream.write({
        start: {
          argv: remoteArgv(argv),
          cwd,
          env: env ?? {},
          ...(identity?.uid !== undefined ? { uid: { value: identity.uid } } : {}),
          ...(identity?.gid !== undefined ? { gid: { value: identity.gid } } : {}),
          ...(identity?.groups !== undefined ? { groups: identity.groups } : {}),
          spillStdout: stdoutSpec,
          spillStderr: stderrSpec,
        },
      });
      stream.end();
    }),
  );
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
  if (workspace === undefined) {
    // "default" is not a workspace slug, so returning it only produced an
    // opaque orchestrator error downstream and a fabricated container_list
    // row; fail with the same shape resolve() uses instead.
    throw new Error(
      `cannot resolve a DH workspace without a session working directory (got ${JSON.stringify(cwd)})`,
    );
  }
  return workspaceSlug(workspace.id);
}

export async function resolveToolBinding(
  resolver: WorkspaceResolver,
  cwd: unknown,
  container: string,
  signal?: AbortSignal,
): Promise<WorkspaceBinding> {
  if (container === "default") return resolver.resolve(cwd, signal);
  return resolver.containerBinding(cwd, container, signal);
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
  return withGuestAuth(target.binding, (guest, token) =>
    new Promise<any>((resolveDone, reject) => {
      let detach: () => void = () => {};
      const call = guest.stat(
        { path: target.targetKey },
        metadata(token),
        (error: Error | null, value: any) => {
          detach();
          error
            ? reject(signal?.aborted ? fsError("FS_ABORTED", "stat aborted") : error)
            : resolveDone(value);
        },
      );
      detach = onAbortCancel(call, signal);
    }),
  );
}

export async function unaryGuest(
  target: any,
  method: string,
  request: unknown,
  signal?: AbortSignal,
): Promise<unknown> {
  throwIfAborted(signal, method);
  return withGuestAuth(target.binding, (guest, token) =>
    new Promise((resolveDone, reject) => {
      let detach: () => void = () => {};
      const call = (guest as any)[method](
        request,
        metadata(token),
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
    }),
  );
}

// globCwd returns the working directory a ripgrep discovery listing must run
// in, or undefined to keep the caller's. The harness's glob tool passes its
// search path as an absolute positional root, but ripgrep anchors a `--glob`
// pattern containing "/" to the process cwd, so a pattern like "sub/b.txt"
// could never match an absolute root. Running the listing from the root anchors
// the pattern to `path` while keeping the printed paths absolute, which is what
// the harness renders against the session working directory.
export function globCwd(argv: readonly string[], cwd: unknown): string | undefined {
  const runner = argv[0];
  if (runner === undefined || !/(?:^|\/)rg(?:\.exe)?$/.test(runner)) return undefined;
  if (!argv.includes("--files")) return undefined;
  const separator = argv.indexOf("--");
  if (separator < 0) return undefined;
  const roots = argv.slice(separator + 1);
  if (roots.length !== 1) return undefined;
  const root = roots[0];
  if (typeof cwd !== "string" || cwd === "" || !isAbsolute(root)) return undefined;
  return root;
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
