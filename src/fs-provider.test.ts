// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import { editGuest, editProvider, fakeGuest, providerFor, stubResolver } from "./test-support.js";
import { createFilesystemProvider } from "./index.js";

test("filesystem provider resolves absolute safe paths", async () => {
  const provider = createFilesystemProvider(stubResolver);
  const target = await provider.resolve("/projects/team/app", { cwd: "/x" });
  assert.equal(target.targetKey, "/projects/team/app");
  assert.equal(target.displayPath, "/projects/team/app");
  assert.deepEqual(target.binding, { kind: "binding" });
});

test("filesystem provider resolves absolute paths without a cwd", async () => {
  const seen: Array<[string, unknown]> = [];
  const provider = createFilesystemProvider({
    resolve: async () => ({ kind: "binding" }),
    resolveForPath: async (path: string, cwd: unknown) => {
      seen.push([path, cwd]);
      return { kind: "binding" };
    },
  } as any);
  const target = await provider.resolve("/projects/team/app");
  assert.equal(target.targetKey, "/projects/team/app");
  assert.deepEqual(target.binding, { kind: "binding" });
  assert.deepEqual(seen, [["/projects/team/app", undefined]]);
});

test("filesystem provider resolves relative paths against the cwd", async () => {
  const provider = createFilesystemProvider(stubResolver);
  const target = await provider.resolve("README.md", {
    cwd: "/projects/team/app",
  });
  assert.equal(target.targetKey, "/projects/team/app/README.md");
  assert.equal(target.displayPath, "/projects/team/app/README.md");
  assert.deepEqual(target.binding, { kind: "binding" });
});

test("filesystem provider rejects unsafe paths", async () => {
  const provider = createFilesystemProvider(stubResolver);
  await assert.rejects(() => provider.resolve("/a/../b"));
  await assert.rejects(() => provider.resolve("/a/b/../../etc"));
  await assert.rejects(() => provider.resolve("../escape", { cwd: "/projects/team/app" }));
});

test("filesystem provider maps targets", () => {
  const provider = createFilesystemProvider(stubResolver);
  assert.equal(provider.fileUrl({ targetKey: "/a/b" }), "file:///a/b");
  assert.equal(provider.processPath({ targetKey: "/a/b" }), "/a/b");
  const parent = { targetKey: "/a" };
  assert.equal(provider.contains(parent, { targetKey: "/a" }), true);
  assert.equal(provider.contains(parent, { targetKey: "/a/b" }), true);
  assert.equal(provider.contains(parent, { targetKey: "/a2" }), false);
  assert.equal(provider.contains(parent, { targetKey: "/b" }), false);
});

test("filesystem provider lstat maps entry types without following links", async () => {
  const requests: Record<string, unknown>[] = [];
  const provider = createFilesystemProvider({
    resolveForPath: async () => ({
      guest: {
        stat: (request: Record<string, unknown>, _metadata: unknown, callback: Function) => {
          requests.push(request);
          callback(null, {
            exists: true,
            isDir: false,
            isSymlink: true,
            size: "3",
            mode: "Lrwxrwxrwx",
            modifiedAt: "t",
          });
        },
      },
      token: "t",
    }),
  } as any);
  const info = await provider.lstat("/projects/team/link", { cwd: "/projects/team" });
  assert.equal(info.type, "symlink");
  assert.equal(info.size, 3);
  assert.deepEqual(requests, [{ path: "/projects/team/link", noFollow: true }]);
});

test("filesystem provider lstat reports an absent entry as undefined", async () => {
  const provider = createFilesystemProvider({
    resolveForPath: async () => ({
      guest: {
        stat: (_request: unknown, _metadata: unknown, callback: Function) =>
          callback(null, { exists: false }),
      },
      token: "t",
    }),
  } as any);
  assert.equal(await provider.lstat("/projects/team/missing", { cwd: "/x" }), undefined);
});

test("filesystem provider streamText decodes UTF-8 and rejects binary", async () => {
  const text = providerFor(fakeGuest(Buffer.from("héllo")).guest);
  const textTarget = await text.resolve("/a", { cwd: "/x" });
  let decoded = "";
  for await (const chunk of await text.streamText(textTarget)) decoded += chunk;
  assert.equal(decoded, "héllo");

  const binary = providerFor(fakeGuest(Buffer.from([0x68, 0x00, 0x69])).guest);
  const binaryTarget = await binary.resolve("/a", { cwd: "/x" });
  await assert.rejects(
    async () => {
      for await (const _chunk of await binary.streamText(binaryTarget)) {
        // Drain the stream so the binary sample is inspected.
      }
    },
    (error: unknown) =>
      error instanceof Error && (error as { code?: string }).code === "FS_NOT_TEXT",
  );
});

test("filesystem provider readBytes returns content and caps at maxBytes", async () => {
  const fake = fakeGuest(Buffer.from("hello"));
  const provider = providerFor(fake.guest);
  const target = await provider.resolve("/a", { cwd: "/x" });

  const bytes = await provider.readBytes(target, undefined, 10);
  assert.equal(Buffer.from(bytes).toString(), "hello");
  assert.equal(fake.requests[0].length, 11);

  await assert.rejects(
    () => provider.readBytes(target, undefined, 3),
    (error: unknown) =>
      error instanceof Error && (error as { code?: string }).code === "FS_TOO_LARGE",
  );
});

test("filesystem provider readByteRange returns the window and empty for zero length", async () => {
  const fake = fakeGuest(Buffer.from("abcdef"));
  const provider = providerFor(fake.guest);
  const target = await provider.resolve("/a", { cwd: "/x" });

  const empty = await provider.readByteRange(target, { offset: 0, length: 0 });
  assert.equal(empty.length, 0);
  assert.equal(fake.requests.length, 0);

  const window = await provider.readByteRange(target, { offset: 1, length: 3 });
  assert.equal(Buffer.from(window).toString(), "bcd");
  assert.deepEqual(fake.requests[0], { path: "/a", offset: 1, length: 3 });
});

test("filesystem provider editText reports the harness error codes", async () => {
  const binary = editProvider(editGuest({}, Buffer.from([0x68, 0x00, 0x69])));
  const binaryTarget = await binary.resolve("/a", { cwd: "/x" });
  await assert.rejects(
    () =>
      binary.editText(binaryTarget, {
        oldString: "h",
        newString: "H",
        replaceAll: false,
      }),
    (error: unknown) => (error as { code?: string }).code === "FS_NOT_TEXT",
  );

  const notFound = editProvider(editGuest({}, Buffer.from("hello")));
  const notFoundTarget = await notFound.resolve("/a", { cwd: "/x" });
  await assert.rejects(
    () =>
      notFound.editText(notFoundTarget, {
        oldString: "zzz",
        newString: "x",
        replaceAll: false,
      }),
    (error: unknown) => (error as { code?: string }).code === "FS_EDIT_NOT_FOUND",
  );

  const ambiguous = editProvider(editGuest({}, Buffer.from("aa")));
  const ambiguousTarget = await ambiguous.resolve("/a", { cwd: "/x" });
  await assert.rejects(
    () =>
      ambiguous.editText(ambiguousTarget, {
        oldString: "a",
        newString: "b",
        replaceAll: false,
      }),
    (error: unknown) => (error as { code?: string }).code === "FS_AMBIGUOUS_EDIT",
  );

  const stale = editProvider(editGuest({}, Buffer.from("hello")));
  const staleTarget = await stale.resolve("/a", { cwd: "/x" });
  await assert.rejects(
    () =>
      stale.editText(
        staleTarget,
        { oldString: "h", newString: "H", replaceAll: false },
        { version: "other" },
      ),
    (error: unknown) => (error as { code?: string }).code === "FS_STALE_VERSION",
  );
});

test("filesystem provider writeText reports the harness error codes", async () => {
  const existing = editProvider(editGuest({}, Buffer.from("hello")));
  const target = await existing.resolve("/a", { cwd: "/x" });

  await assert.rejects(
    () => existing.writeText(target, "x", { kind: "createIfAbsent" }),
    (error: unknown) => (error as { code?: string }).code === "FS_NOT_OBSERVED",
  );
  await assert.rejects(
    () => existing.writeText(target, "x", { kind: "replaceIfVersion", version: "other" }),
    (error: unknown) => (error as { code?: string }).code === "FS_STALE_VERSION",
  );

  const dir = editProvider(editGuest({ isDir: true }));
  const dirTarget = await dir.resolve("/a", { cwd: "/x" });
  await assert.rejects(
    () => dir.writeText(dirTarget, "x"),
    (error: unknown) => (error as { code?: string }).code === "FS_NOT_REGULAR_FILE",
  );
});

test("filesystem provider writeText creates a file that was removed", async () => {
  // A read-then-removed path is a new file: creating it destroys nothing, so
  // the write must succeed instead of reporting a stale version.
  const gone = editProvider(editGuest({ exists: false }));
  const target = await gone.resolve("/a", { cwd: "/x" });
  const outcome = await gone.writeText(target, "fresh", {
    kind: "replaceIfVersion",
    version: "agent:1:5:-rw-r--r--",
  });
  assert.equal(outcome.operation, "create");
  assert.equal(outcome.before, null);
  assert.equal(outcome.after, "fresh");
});

test("filesystem provider rejects a pre-aborted signal with FS_ABORTED", async () => {
  const provider = editProvider(editGuest({}, Buffer.from("hello")));
  const target = await provider.resolve("/a", { cwd: "/x" });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => provider.readText(target, controller.signal),
    (error: unknown) => (error as { code?: string }).code === "FS_ABORTED",
  );
});

test("filesystem provider editText normalizes line endings for matching", async () => {
  const binding = editGuest({}, Buffer.from("a\r\nb\r\n"));
  const provider = editProvider(binding);
  const target = await provider.resolve("/a", { cwd: "/x" });
  const outcome = await provider.editText(target, {
    oldString: "b",
    newString: "B",
    replaceAll: false,
  });
  // The diff basis is LF-normalized, and the file keeps its CRLF style.
  assert.equal(outcome.before, "a\nb\n");
  assert.equal(outcome.after, "a\nB\n");
  assert.equal(Buffer.concat(binding.writes).toString(), "a\r\nB\r\n");
});

test("filesystem provider maps absolute host paths into the execution world", () => {
  const provider = createFilesystemProvider({} as any);
  assert.equal(
    provider.processPathFromHostPath("/home/u/project/f"),
    "/home/u/project/f",
  );
  assert.equal(provider.processPathFromHostPath("rel/f"), undefined);
});

test("filesystem provider listDir returns resolved child targets", async () => {
  const requests: Record<string, unknown>[] = [];
  const provider = createFilesystemProvider({
    resolveForPath: async () => ({
      guest: {
        readDir: (
          request: Record<string, unknown>,
          _metadata: unknown,
          callback: Function,
        ) => {
          requests.push(request);
          callback(null, {
            entries: [
              { name: "src", isDir: true, size: "0", type: "directory" },
              { name: "a.txt", isDir: false, size: "3", type: "file" },
              { name: "link", isDir: false, size: "1", type: "other" },
            ],
          });
        },
      },
      token: "t",
    }),
  } as any);
  const target = await provider.resolve("/projects/team", { cwd: "/projects/team" });
  const entries = await provider.listDir(target);
  assert.deepEqual(requests, [{ path: "/projects/team" }]);
  assert.deepEqual(
    entries.map((entry: any) => ({
      name: entry.name,
      type: entry.type,
      path: entry.target.displayPath,
      binding: entry.target.binding.token,
    })),
    [
      { name: "src", type: "directory", path: "/projects/team/src", binding: "t" },
      { name: "a.txt", type: "file", path: "/projects/team/a.txt", binding: "t" },
      { name: "link", type: "other", path: "/projects/team/link", binding: "t" },
    ],
  );
  assert.equal(entries[1].size, 3);
  assert.equal(entries[0].size, undefined);
});

test("filesystem provider listDir falls back to the directory bit", async () => {
  const provider = createFilesystemProvider({
    resolveForPath: async () => ({
      guest: {
        readDir: (_request: unknown, _metadata: unknown, callback: Function) =>
          callback(null, {
            entries: [
              { name: "d", isDir: true, size: "0" },
              { name: "f", isDir: false, size: "1" },
            ],
          }),
      },
      token: "t",
    }),
  } as any);
  const target = await provider.resolve("/w", { cwd: "/w" });
  const entries = await provider.listDir(target);
  assert.deepEqual(entries.map((entry: any) => entry.type), ["directory", "file"]);
});

test("filesystem provider writeText normalizes the diff basis", async () => {
  const binding = editGuest({}, Buffer.from("a\r\nb\r\n"));
  const provider = editProvider(binding);
  const target = await provider.resolve("/a", { cwd: "/x" });
  const outcome = await provider.writeText(target, "c\r\nd\r\n");
  assert.equal(outcome.before, "a\nb\n");
  assert.equal(outcome.after, "c\nd\n");
  assert.equal(Buffer.concat(binding.writes).toString(), "c\r\nd\r\n");
});

test("filesystem provider reports watching as unsupported", async () => {
  const provider = createFilesystemProvider(stubResolver);
  const target = await provider.resolve("/projects/team/app", { cwd: "/x" });
  let notified = false;
  await assert.rejects(
    () =>
      provider.watch(target, () => {
        notified = true;
      }, new AbortController().signal),
    (error: any) =>
      error.code === "FS_IO_ERROR" &&
      error.message === "Filesystem watching is not supported by this provider.",
  );
  assert.equal(notified, false, "changed must not fire when watching is unsupported");

  const aborted = new AbortController();
  aborted.abort();
  assert.throws(
    () => provider.watch(target, () => {}, aborted.signal),
    (error: any) => error.code === "FS_ABORTED",
  );
});
