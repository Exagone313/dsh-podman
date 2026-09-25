// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import {
  detectLineEndings,
  DIFF_BASIS_MAX_BYTES,
  fsError,
  guestChunks,
  guestStat,
  guestStatResponse,
  guestTextChunks,
  guestVersion,
  normalizeLineEndings,
  readDiffBasis,
  readGuestText,
  resolveGuestPath,
  restoreLineEndings,
  throwIfAborted,
  unaryGuest,
  writeGuestFile,
} from "./guest-rpc.js";
import { WorkspaceResolver } from "./workspace-binding.js";
import { isAbsolute, join, resolve as resolvePath } from "node:path";

export interface FilesystemProvider {
  resolve(path: string, opts?: any): Promise<any>;
  processPath(target: any): string;
  processPathFromHostPath(hostPath: string): string | undefined;
  fileUrl(target: any): string;
  contains(parent: any, child: any): boolean;
  readText(target: any, signal?: AbortSignal): Promise<string>;
  streamText(target: any, signal?: AbortSignal): Promise<AsyncIterable<string>>;
  readBytes(
    target: any,
    signal: AbortSignal | undefined,
    maxBytes: number,
  ): Promise<Uint8Array>;
  readByteRange(
    target: any,
    range: { offset: number; length: number },
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
  lstat(
    path: string,
    opts?: any,
    signal?: AbortSignal,
  ): Promise<any | undefined>;
  writeText(
    target: any,
    content: string,
    expected?: any,
    signal?: AbortSignal,
  ): Promise<any>;
  stat(target: any): Promise<any>;
  listDir(target: any): Promise<any>;
  mkdir(target: any, parents?: boolean): Promise<any>;
  remove(target: any, recursive?: boolean): Promise<any>;
  editText(
    target: any,
    edit: any,
    expected?: any,
    signal?: AbortSignal,
  ): Promise<any>;
  watch(
    target: any,
    changed: (error?: Error) => void,
    signal?: AbortSignal,
  ): Promise<() => Promise<void>>;
}

export function createFilesystemProvider(resolver: WorkspaceResolver): FilesystemProvider {
  return {
    resolve: async (path: string, opts?: any) => {
      throwIfAborted(opts?.signal, "resolve");
      const resolved = resolveGuestPath(path, opts?.cwd);
      // An explicit container targets that container's guest; the harness's own
      // tools never pass one and keep the session workspace's default.
      const container = typeof opts?.container === "string" ? opts.container : "";
      const binding = container !== "" && container !== "default"
        ? await resolver.containerBinding(opts?.cwd, container, opts?.signal)
        : await resolver.resolveForPath(resolved, opts?.cwd, opts?.signal);
      return {
        targetKey: resolved,
        displayPath: resolved,
        binding,
      };
    },
    processPath: (target: any) => target.targetKey,
    // The guest mounts each workspace at its mirrored path, so a host path in
    // the execution world names the same path; anything relative has no world.
    processPathFromHostPath: (hostPath: string) =>
      isAbsolute(hostPath) ? resolvePath(hostPath) : undefined,
    fileUrl: (target: any) => `file://${target.targetKey}`,
    contains: (parent: any, child: any) =>
      child.targetKey === parent.targetKey ||
      child.targetKey.startsWith(`${parent.targetKey}/`),
    readText: (target: any, signal?: AbortSignal) => readGuestText(target, signal),
    streamText: (target: any, signal?: AbortSignal) =>
      Promise.resolve(guestTextChunks(target, signal)),
    readBytes: async (
      target: any,
      signal: AbortSignal | undefined,
      maxBytes: number,
    ) => {
      const chunks: Buffer[] = [];
      let total = 0;
      for await (
        const buffer of guestChunks(
          target,
          { length: maxBytes + 1 },
          signal,
        )
      ) {
        total += buffer.length;
        if (total > maxBytes) {
          throw fsError(
            "FS_TOO_LARGE",
            `cannot read "${target.displayPath}": content exceeds the ${maxBytes}-byte limit`,
          );
        }
        chunks.push(buffer);
      }
      return Buffer.concat(chunks, total);
    },
    readByteRange: async (
      target: any,
      range: { offset: number; length: number },
      signal?: AbortSignal,
    ) => {
      if (range.length === 0) return new Uint8Array(0);
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const buffer of guestChunks(target, range, signal)) {
        total += buffer.length;
        chunks.push(buffer);
      }
      return Buffer.concat(chunks, total);
    },
    lstat: async (path: string, opts?: any, signal?: AbortSignal) => {
      throwIfAborted(signal, "lstat");
      const resolved = resolveGuestPath(path, opts?.cwd);
      const binding = await resolver.resolveForPath(resolved, opts?.cwd, signal);
      const result: any = await unaryGuest(
        { binding },
        "stat",
        { path: resolved, noFollow: true },
        signal,
      );
      if (!result?.exists) return undefined;
      return {
        version: guestVersion(result),
        type: result.isSymlink ? "symlink" : result.isDir ? "directory" : "file",
        ...(result.size !== undefined && result.size !== null ? { size: Number(result.size) } : {}),
      };
    },
    writeText: async (
      target: any,
      content: string,
      expected?: any,
      signal?: AbortSignal,
    ) => {
      throwIfAborted(signal, "write");
      const current = await guestStatResponse(target, signal);
      if (current.exists && current.isDir) {
        throw fsError(
          "FS_NOT_REGULAR_FILE",
          `cannot write "${target.displayPath}": not a regular file`,
        );
      }
      const currentVersion = current.exists ? guestVersion(current) : undefined;
      if (expected?.kind === "replaceIfVersion") {
        // A file that is gone is a new file: creating it destroys nothing, so
        // this backend creates it. (The harness's fs-local reports
        // FS_STALE_VERSION here; a path the session read and something else
        // removed must stay writable, so the container tools create it.)
        if (current.exists && currentVersion !== expected.version) {
          throw fsError(
            "FS_STALE_VERSION",
            `cannot write "${target.displayPath}": file changed since it was read`,
          );
        }
      } else if (expected?.kind === "createIfAbsent" && current.exists) {
        throw fsError(
          "FS_NOT_OBSERVED",
          `cannot overwrite existing "${target.displayPath}" without reading it first`,
        );
      }
      // The basis is gated on both sides: an incoming or existing file at or
      // above the limit yields `before: null` and the consumer falls back to a
      // whole-file diff, so writing one byte into a huge file does not read the
      // whole file back just for presentation. Both sides are LF-normalized so
      // a CRLF overwrite does not read as every line changed.
      const rawBasis = current.exists &&
          Buffer.byteLength(content, "utf8") < DIFF_BASIS_MAX_BYTES &&
          Number(current.size ?? 0) < DIFF_BASIS_MAX_BYTES
        ? await readDiffBasis(target, signal)
        : null;
      const before = rawBasis === null ? null : normalizeLineEndings(rawBasis);
      await writeGuestFile(
        target.binding,
        target.targetKey,
        content,
        { create: true, truncate: true },
        signal,
      );
      const after = await guestStatResponse(target, signal);
      return {
        operation: current.exists ? "update" : "create",
        version: guestVersion(after),
        before,
        after: normalizeLineEndings(content),
      };
    },
    stat: (target: any, signal?: AbortSignal) => guestStat(target, signal),
    listDir: async (target: any, signal?: AbortSignal) => {
      const response: any = await unaryGuest(
        target,
        "readDir",
        { path: target.targetKey },
        signal,
      );
      const entries: any[] = Array.isArray(response?.entries) ? response.entries : [];
      return entries.map((entry: any) => {
        const childKey = join(target.targetKey, entry.name);
        // Prefer the guest-reported followed type; fall back to the directory
        // bit for an agent that predates the field.
        const type = entry.type === "file" ||
            entry.type === "directory" ||
            entry.type === "other"
          ? entry.type
          : entry.isDir
          ? "directory"
          : "file";
        return {
          name: entry.name,
          type,
          target: {
            targetKey: childKey,
            displayPath: childKey,
            binding: target.binding,
          },
          ...(type === "file" &&
              entry.size !== undefined &&
              entry.size !== null
            ? { size: Number(entry.size) }
            : {}),
        };
      });
    },
    mkdir: async (target: any, parents = true) =>
      unaryGuest(target, "mkdir", { path: target.targetKey, parents }),
    remove: async (target: any, recursive = false) =>
      unaryGuest(target, "delete", { path: target.targetKey, recursive }),
    editText: async (
      target: any,
      edit: any,
      expected?: any,
      signal?: AbortSignal,
    ) => {
      throwIfAborted(signal, "edit");
      const current = await guestStatResponse(target, signal);
      if (!current.exists) {
        throw fsError(
          "FS_STALE_VERSION",
          `cannot edit "${target.displayPath}": file changed since it was read`,
        );
      }
      if (current.isDir) {
        throw fsError(
          "FS_NOT_REGULAR_FILE",
          `cannot edit "${target.displayPath}": not a regular file`,
        );
      }
      if (
        expected !== undefined &&
        guestVersion(current) !== expected.version
      ) {
        throw fsError(
          "FS_STALE_VERSION",
          `cannot edit "${target.displayPath}": file changed since it was read`,
        );
      }
      const raw = await readGuestText(target, signal);
      const before = normalizeLineEndings(raw);
      const lineEndings = detectLineEndings(raw);
      const oldNorm = normalizeLineEndings(
        typeof edit.oldString === "string" ? edit.oldString : "",
      );
      if (oldNorm.length === 0) {
        throw fsError(
          "FS_EDIT_NOT_FOUND",
          "old_string must be a non-empty string",
        );
      }
      const newNorm = normalizeLineEndings(
        typeof edit.newString === "string" ? edit.newString : "",
      );
      const occurrences = before.split(oldNorm).length - 1;
      if (occurrences === 0) {
        throw fsError(
          "FS_EDIT_NOT_FOUND",
          `old_string was not found in "${target.displayPath}"`,
        );
      }
      if (!edit.replaceAll && occurrences > 1) {
        throw fsError(
          "FS_AMBIGUOUS_EDIT",
          `old_string matched ${occurrences} times in "${target.displayPath}"; provide a more specific old_string or set replace_all to true`,
        );
      }
      const after = before.split(oldNorm).join(newNorm);
      await writeGuestFile(
        target.binding,
        target.targetKey,
        restoreLineEndings(after, lineEndings),
        { create: true, truncate: true },
        signal,
      );
      const afterInfo = await guestStatResponse(target, signal);
      return {
        version: guestVersion(afterInfo),
        before,
        after,
      };
    },
    // Watching would need a watcher inside each workspace's container (inotify
    // in the guest, or host-side polling of every open tree node), and every
    // container here is remote and disposable. Report the seam's typed
    // "unsupported" failure instead, as the harness's SSH provider does: the
    // workspace file tree then refreshes on demand rather than live. `changed`
    // is never called — the promise rejects before a watcher becomes active.
    watch: (
      _target: any,
      _changed: (error?: Error) => void,
      signal?: AbortSignal,
    ): Promise<() => Promise<void>> => {
      throwIfAborted(signal, "watch");
      return Promise.reject(
        fsError(
          "FS_IO_ERROR",
          "Filesystem watching is not supported by this provider.",
        ),
      );
    },
  };
}
