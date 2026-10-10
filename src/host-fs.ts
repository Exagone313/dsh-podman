// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { createReadStream } from "node:fs";
import { lstat, open, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fsError, throwIfAborted } from "./guest-rpc.js";

// The host half of the filesystem provider: a read-only view of a project's
// skill roots. The plugin serves them here rather than through a container
// because the skill provider resolves each root without a session cwd, and a
// container-backed provider cannot pick a workspace for such a path. The dsh
// container mounts the projects root read-only, so these are the same files, at
// the same paths, that the workspace's container sees.
//
// Every mutation is refused: a skill is an instruction the model follows, and
// the container route (which every tool call uses, by passing the session cwd)
// stays the only writer.

export const HOST_BINDING = { host: true } as const;

// hostTarget builds the target shape the rest of the provider passes around.
export function hostTarget(path: string): any {
  return {
    targetKey: path,
    displayPath: path,
    binding: HOST_BINDING,
    host: true,
  };
}

// isHostTarget reports whether a target came from this host view.
export function isHostTarget(target: any): boolean {
  return target?.host === true;
}

// hostVersion keeps host reads in their own version namespace, so a version
// taken from one world can never be mistaken for the other's.
function hostVersion(info: { mtimeMs: number; size: number; mode: number }) {
  return `host:${Math.trunc(info.mtimeMs)}:${info.size}:${info.mode}`;
}

// entryType names a directory entry the way the guest does.
function entryType(
  info: { isDirectory(): boolean; isFile(): boolean },
): string {
  if (info.isDirectory()) return "directory";
  if (info.isFile()) return "file";
  return "other";
}

// isMissing reports the codes that mean "this path is not here", which the
// harness's callers treat as an absent entry rather than a failure.
function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown })?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

// hostLstat stats a path without following a final symbolic link.
export async function hostLstat(
  path: string,
  signal?: AbortSignal,
): Promise<any | undefined> {
  throwIfAborted(signal, "lstat");
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  return {
    version: hostVersion(info),
    type: info.isSymbolicLink() ? "symlink" : entryType(info),
    ...(info.isSymbolicLink() ? {} : { size: info.size }),
  };
}

// hostStat stats a path, following symbolic links.
export async function hostStat(
  target: any,
  signal?: AbortSignal,
): Promise<any | undefined> {
  throwIfAborted(signal, "stat");
  let info;
  try {
    info = await stat(target.targetKey);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  return {
    version: hostVersion(info),
    type: info.isDirectory() ? "directory" : "file",
    ...(info.isDirectory() ? {} : { size: info.size }),
  };
}

// hostListDir lists a directory, following entry links so a bundle reached
// through a symbolic link is still a directory entry.
export async function hostListDir(
  target: any,
  signal?: AbortSignal,
): Promise<any[]> {
  throwIfAborted(signal, "readDir");
  const entries = await readdir(target.targetKey, { withFileTypes: true });
  const listed = [];
  for (const entry of entries) {
    throwIfAborted(signal, "readDir");
    const childKey = join(target.targetKey, entry.name);
    let info: any;
    try {
      info = await stat(childKey);
    } catch (error) {
      if (!isMissing(error)) throw error;
      info = entry;
    }
    listed.push({
      name: entry.name,
      type: entryType(info),
      target: hostTarget(childKey),
      ...(info.isFile() ? { size: info.size } : {}),
    });
  }
  return listed;
}

// hostReadText reads a file as UTF-8.
export async function hostReadText(
  target: any,
  signal?: AbortSignal,
): Promise<string> {
  throwIfAborted(signal, "read");
  return await readFile(target.targetKey, { encoding: "utf8", signal });
}

// hostTextChunks streams a file as UTF-8 chunks.
export async function* hostTextChunks(
  target: any,
  signal?: AbortSignal,
): AsyncIterable<string> {
  throwIfAborted(signal, "read");
  const stream = createReadStream(target.targetKey, {
    encoding: "utf8",
    signal,
  });
  for await (const chunk of stream) yield String(chunk);
}

// hostByteChunks reads at most range.length bytes from range.offset.
async function* hostByteChunks(
  target: any,
  range: { offset: number; length: number },
  signal?: AbortSignal,
): AsyncIterable<Buffer> {
  const handle = await open(target.targetKey, "r");
  try {
    const bufferSize = 64 * 1024;
    let position = range.offset;
    let remaining = range.length;
    while (remaining > 0) {
      throwIfAborted(signal, "read");
      const length = Math.min(bufferSize, remaining);
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      remaining -= bytesRead;
      yield buffer.subarray(0, bytesRead);
    }
  } finally {
    await handle.close();
  }
}

// hostReadBytes reads a whole file, refusing content above maxBytes.
export async function hostReadBytes(
  target: any,
  signal: AbortSignal | undefined,
  maxBytes: number,
): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (
    const buffer of hostByteChunks(
      target,
      { offset: 0, length: maxBytes + 1 },
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
}

// hostReadByteRange reads one byte range of a file.
export async function hostReadByteRange(
  target: any,
  range: { offset: number; length: number },
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (range.length === 0) return new Uint8Array(0);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const buffer of hostByteChunks(target, range, signal)) {
    total += buffer.length;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, total);
}

// hostRefuse rejects a mutation of a read-only skill root with the harness's
// permission code.
export function hostRefuse(operation: string, target: any): never {
  throw fsError(
    "FS_PERMISSION_DENIED",
    `cannot ${operation} "${target.displayPath}": skill roots are read-only`,
  );
}
