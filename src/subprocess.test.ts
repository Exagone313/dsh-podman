// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import { FakeTerminalCall, fakeTerminalResolver, spawnGuest, spawnSpec } from "./test-support.js";
import { createSubprocessProvider, outputReader, remoteArgv } from "./index.js";

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
  const spill = { path: "/var/tmp/dsh-podman/x.stdout", maxBytes: 64 };
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
  const outputEnded = new Promise<void>((resolve) =>
    handle.output.on("end", resolve),
  );

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
    () =>
      provider.spawnTerminal({ argv: [], cwd: "/projects/team", rows: 24, cols: 80 }),
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
  assert.match(start.spillStdout.path, /^\/var\/tmp\/dsh-podman\/.+\.stdout$/);
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
