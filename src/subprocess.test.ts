// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import { FakeTerminalCall, fakeTerminalResolver, spawnGuest, spawnSpec } from "./test-support.js";
import { createSubprocessProvider, globCwd, outputReader, remoteArgv } from "./index.js";

test("globCwd runs a discovery listing from its absolute search root", () => {
  assert.equal(
    globCwd(["rg", "--files", "--glob=sub/b.txt", "--", "/tmp/globtest"], "/projects/team"),
    "/tmp/globtest",
  );
  assert.equal(
    globCwd(["rg", "--files", "--glob=a", "--", "sub"], "/projects/team"),
    undefined,
    "a relative root keeps the caller's cwd",
  );
  assert.equal(
    globCwd(["rg", "--files", "--glob=a"], "/projects/team"),
    undefined,
    "no search root keeps the caller's cwd",
  );
  assert.equal(
    globCwd(["rg", "-n", "x", "--", "/tmp/x"], "/projects/team"),
    undefined,
    "only a discovery listing is re-anchored",
  );
  assert.equal(globCwd(["bash", "-c", "rg"], "/projects/team"), undefined);
  assert.equal(
    globCwd(["rg", "--files", "--", "/a", "/b"], "/projects/team"),
    undefined,
    "several search roots keep the caller's cwd",
  );
});

test("subprocess provider runs a glob listing from its search root", async () => {
  const fake = spawnGuest();
  const provider = createSubprocessProvider(fake.resolver as any);
  const handle = provider.spawn(
    spawnSpec({
      argv: ["rg", "--files", "--glob=sub/b.txt", "--", "/tmp/globtest"],
    }),
  );
  await handle.done;
  const start = fake.starts[0].start;
  assert.equal(start.cwd, "/tmp/globtest");
  assert.deepEqual(start.argv, [
    "/usr/bin/rg",
    "--files",
    "--glob=sub/b.txt",
    "--",
    "/tmp/globtest",
  ]);
});

test("remoteArgv remaps ripgrep onto the guest path", () => {
  assert.deepEqual(remoteArgv(["rg", "-n", "foo"]), [
    "/usr/bin/rg",
    "-n",
    "foo",
  ]);
  assert.deepEqual(remoteArgv(["/usr/bin/rg", "-l", "x"]), [
    "/usr/bin/rg",
    "-l",
    "x",
  ]);
});

test("remoteArgv unwraps landlock-run wrappers", () => {
  assert.deepEqual(remoteArgv(["landlock-run", "--", "/usr/bin/rg", "-l"]), [
    "/usr/bin/rg",
    "-l",
  ]);
  assert.deepEqual(
    remoteArgv(["landlock-run", "--", "rg", "-l", "src"]),
    ["/usr/bin/rg", "-l", "src"],
  );
});

test("remoteArgv leaves ordinary commands untouched", () => {
  assert.deepEqual(remoteArgv(["bash", "-c", "echo hi"]), [
    "bash",
    "-c",
    "echo hi",
  ]);
  assert.deepEqual(remoteArgv(["landlock-run", "cmd", "arg"]), [
    "landlock-run",
    "cmd",
    "arg",
  ]);
  assert.deepEqual(remoteArgv([]), []);
});

test("outputReader is undefined without a bounded mode", () => {
  assert.equal(outputReader(undefined), undefined);
  assert.equal(outputReader(null), undefined);
  assert.equal(outputReader("pipe"), undefined);
  assert.equal(outputReader({ maxBytes: -1 }), undefined);
  assert.equal(outputReader({ maxBytes: Number.NaN }), undefined);
});

test("outputReader reads appended output", () => {
  const reader = outputReader({ maxBytes: 16 })!;
  reader.append(Buffer.from("hello "));
  reader.append(Buffer.from("world"));
  const first = reader.readFrom(0);
  assert.equal(first.text, "hello world");
  assert.equal(first.nextOffset, 11);
  assert.equal(first.lossy, false);
});

test("outputReader advertises a valid spill only for a lossy read", () => {
  const spill = { path: "/tmp/dsh-podman/x.stdout", maxBytes: 64 };
  const reader = outputReader({ maxBytes: 4 }, spill)!;
  reader.append(Buffer.from("abcdefgh"));
  assert.equal(reader.spillNeeded, true);
  const lossy = reader.readFrom(0);
  assert.equal(lossy.lossy, true);
  assert.equal(lossy.spillPath, spill.path);

  reader.setSpillValid(false);
  assert.equal(reader.readFrom(0).spillPath, undefined);

  const small = outputReader({ maxBytes: 64 }, spill)!;
  small.append(Buffer.from("hi"));
  assert.equal(small.spillNeeded, false);
  assert.equal(small.readFrom(0).spillPath, undefined);
});

test("outputReader drops bytes beyond the retention window", () => {
  const reader = outputReader({ maxBytes: 5 })!;
  reader.append(Buffer.from("hello"));
  reader.append(Buffer.from("world"));
  const read = reader.readFrom(0);
  assert.equal(read.text, "world");
  assert.equal(read.nextOffset, 10);
  assert.equal(read.lossy, true);
});

test("outputReader with a zero cap retains nothing", () => {
  const spill = { path: "/tmp/dsh-podman/x.stdout", maxBytes: 64 };
  const reader = outputReader({ maxBytes: 0 }, spill)!;
  reader.append(Buffer.from("abcdef"));
  // `subarray(-0)` is the whole buffer, so a zero cap must be special-cased.
  assert.equal(reader.readFrom(0).text, "");
  assert.equal(reader.readFrom(0).lossy, true);
  assert.equal(reader.spillNeeded, true);
  assert.equal(reader.readFrom(0).spillPath, spill.path);
});

test("outputReader keeps the exact tail across many small chunks", () => {
  const reader = outputReader({ maxBytes: 4 })!;
  for (const character of "0123456789") {
    reader.append(Buffer.from(character));
  }
  const read = reader.readFrom(0);
  assert.equal(read.text, "6789");
  assert.equal(read.nextOffset, 10);
  assert.equal(read.lossy, true);
});

test("outputReader honors in-window offsets", () => {
  const reader = outputReader({ maxBytes: 5 })!;
  reader.append(Buffer.from("abcdefghij"));
  const atStart = reader.readFrom(5);
  assert.equal(atStart.text, "fghij");
  assert.equal(atStart.lossy, false);
  const pastEnd = reader.readFrom(10);
  assert.equal(pastEnd.text, "");
  assert.equal(pastEnd.lossy, false);
});

test("resolveExecutable rejects every request without a workspace context", async () => {
  const provider = createSubprocessProvider({} as any);
  await assert.rejects(() => provider.resolveExecutable(""));
  await assert.rejects(() => provider.resolveExecutable("bin/tool"));
  await assert.rejects(() => provider.resolveExecutable("ls"));
  await assert.rejects(() => provider.resolveExecutable("/usr/bin/ls"));
});

test("spawnTerminal drives the guest terminal stream", async () => {
  const fake = new FakeTerminalCall();
  const provider = createSubprocessProvider(fakeTerminalResolver(fake));
  const handle = await provider.spawnTerminal({
    argv: ["bash"],
    cwd: "/projects/team",
    rows: 24,
    cols: 80,
    graceMs: 1000,
  });
  assert.equal(handle.pid, 42);

  const chunks: Buffer[] = [];
  handle.output.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  const outputEnded = new Promise<void>((resolve) => handle.output.on("end", resolve));

  fake.emitStdout(Buffer.from("hello"));
  await handle.write("ls\n");
  assert.deepEqual(
    fake.stdinChunks.map((chunk) => chunk.toString("utf8")),
    ["ls\n"],
  );

  assert.deepEqual(await handle.inspectForeground(), {
    processGroupId: 7,
    inputWaiting: true,
  });
  assert.equal(await handle.signalForeground("SIGINT"), 7);

  fake.emitExit(0, false);
  assert.deepEqual(await handle.done, { exitCode: 0, signal: null });
  await outputEnded;
  assert.equal(Buffer.concat(chunks).toString("utf8"), "hello");

  await handle.terminate();
});

test("spawnTerminal rejects an empty argv", async () => {
  const provider = createSubprocessProvider(fakeTerminalResolver(new FakeTerminalCall()));
  await assert.rejects(
    () => provider.spawnTerminal({ argv: [], cwd: "/projects/team", rows: 24, cols: 80 }),
    /argv must contain a program/,
  );
});

test("subprocess provider terminates live processes on dispose", async () => {
  const { signals, resolver } = spawnGuest({ emitExit: false });
  const provider = createSubprocessProvider(resolver as any);
  provider.spawn(spawnSpec());
  await new Promise((resolve) => setTimeout(resolve, 0));
  provider.dispose();
  assert.ok(signals.some((signal) => signal.signal === "SIGTERM"));
});

test("subprocess provider terminates on the spec abort signal", async () => {
  const { signals, resolver } = spawnGuest({ emitExit: false });
  const provider = createSubprocessProvider(resolver as any);
  const controller = new AbortController();
  provider.spawn(spawnSpec({ signal: controller.signal }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  controller.abort();
  assert.ok(signals.some((signal) => signal.signal === "SIGTERM"));
});

test("subprocess provider rejects a pre-aborted spawn synchronously", () => {
  const { resolver } = spawnGuest();
  const provider = createSubprocessProvider(resolver as any);
  const controller = new AbortController();
  controller.abort(new Error("stop"));
  assert.throws(
    () => provider.spawn(spawnSpec({ signal: controller.signal })),
    /aborted before spawn: Error: stop/,
  );
});

test("subprocess provider waitForExit honors an abort signal", async () => {
  const live = spawnGuest({ emitExit: false });
  const liveProvider = createSubprocessProvider(live.resolver as any);
  const handle = liveProvider.spawn(spawnSpec());
  await new Promise((resolve) => setTimeout(resolve, 0));
  const controller = new AbortController();
  const pending = handle.waitForExit(controller.signal);
  controller.abort();
  assert.equal(await pending, false);
  liveProvider.dispose();

  const exited = spawnGuest();
  const exitedProvider = createSubprocessProvider(exited.resolver as any);
  const exitedHandle = exitedProvider.spawn(spawnSpec());
  assert.equal(await exitedHandle.waitForExit(), true);
});

test("subprocess provider forwards env tombstones and spills", async () => {
  const fake = spawnGuest({ exit: { stdoutSpillValid: true } });
  const provider = createSubprocessProvider(fake.resolver as any);
  const handle = provider.spawn(
    spawnSpec({
      env: { KEEP: "1", DROP: undefined },
      stdio: {
        stdin: "ignore",
        stdout: { maxBytes: 4, spill: { maxBytes: 64 } },
        stderr: { maxBytes: 4 },
      },
    }),
  );
  await handle.done;
  const start = fake.starts[0].start;
  assert.deepEqual(start.env, { KEEP: "1" });
  assert.deepEqual(start.unsetEnv, ["DROP"]);
  assert.equal(start.spillStdout.maxBytes, 64);
  assert.match(start.spillStdout.path, /^\/tmp\/dsh-podman\/.+\.stdout$/);
  assert.equal(start.spillStderr, undefined);
  // No output was emitted, so the in-memory tail covered everything and the
  // unneeded spill is discarded.
  assert.equal(fake.deletes.length, 1);
  assert.equal(fake.deletes[0].path, start.spillStdout.path);
});

test("subprocess provider keeps a spill that holds dropped output", async () => {
  const fake = spawnGuest({
    exit: { stdoutSpillValid: true },
    stdout: "0123456789",
  });
  const provider = createSubprocessProvider(fake.resolver as any);
  const handle = provider.spawn(
    spawnSpec({
      stdio: {
        stdin: "ignore",
        stdout: { maxBytes: 4, spill: { maxBytes: 64 } },
        stderr: { maxBytes: 4 },
      },
    }),
  );
  await handle.done;
  assert.equal(fake.deletes.length, 0);
  const read = handle.collected.stdout!.readFrom(0);
  assert.equal(read.lossy, true);
  assert.equal(read.spillPath, fake.starts[0].start.spillStdout.path);
});

test("subprocess provider tears down a failed exec stream", async () => {
  const fake = spawnGuest({ emitExit: false });
  const provider = createSubprocessProvider(fake.resolver as any);
  const handle = provider.spawn(
    spawnSpec({
      stdio: {
        stdin: "ignore",
        stdout: "pipe",
        stderr: { maxBytes: 4, spill: { maxBytes: 64 } },
      },
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  const failed = assert.rejects(handle.done, /guest vanished/);
  // A paused PassThrough only emits "end" once a consumer reads it to EOF.
  handle.stdout.resume();
  const outputEnded = new Promise<void>((resolve) => handle.stdout.on("end", () => resolve()));
  fake.streams[0].emit("error", new Error("guest vanished"));
  await outputEnded;
  await failed;
  assert.ok(
    fake.signals.some((signal) => signal.signal === "SIGTERM"),
    "the process is asked to stop when its stream fails",
  );
  const spill = fake.starts[0].start.spillStderr.path;
  assert.ok(
    fake.deletes.some((request) => request.path === spill),
    "the spill is deleted on the failure path",
  );
});

test("subprocess provider rejects a stream that ends without an exit", async () => {
  const fake = spawnGuest({ emitExit: false });
  const provider = createSubprocessProvider(fake.resolver as any);
  const handle = provider.spawn(spawnSpec());
  await new Promise((resolve) => setImmediate(resolve));
  const failed = assert.rejects(handle.done, /ended before the process exited/);
  fake.streams[0].emit("end");
  await failed;
  assert.ok(
    fake.signals.some((signal) => signal.signal === "SIGTERM"),
    "a lost stream still asks the process to stop",
  );
});

test("subprocess provider pauses a piped stream while the consumer is behind", async () => {
  const chunk = "x".repeat(64 * 1024);
  const fake = spawnGuest({ emitExit: false, stdout: chunk });
  const provider = createSubprocessProvider(fake.resolver as any);
  const handle = provider.spawn(
    spawnSpec({ stdio: { stdin: "ignore", stdout: "pipe", stderr: "pipe" } }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  const stream = fake.streams[0];
  assert.ok(stream.paused > 0, "a full PassThrough pauses the guest stream");
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve) =>
    handle.stdout.on("data", (data: Buffer) => {
      chunks.push(Buffer.from(data));
      if (Buffer.concat(chunks).length >= chunk.length) resolve();
    })
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(stream.resumed > 0, "draining the consumer resumes the stream");
  const exited = handle.done;
  stream.emitData({ exit: { exitCode: 0, signaled: false } });
  assert.deepEqual(await exited, { exitCode: 0, signal: null });
});

test("subprocess provider disposes a live terminal", async () => {
  const fake = new FakeTerminalCall();
  const provider = createSubprocessProvider(fakeTerminalResolver(fake));
  const handle = await provider.spawnTerminal({
    argv: ["bash"],
    cwd: "/projects/team",
    rows: 24,
    cols: 80,
    graceMs: 1000,
  });
  assert.equal(handle.pid, 42);
  provider.dispose();
  assert.equal(fake.closed, true, "disposal closes the terminal");
  assert.equal(fake.ended, true, "disposal ends the terminal stream");
});
