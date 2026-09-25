// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  runExec,
  sessionWorkspaceSlug,
  sliceLines,
  streamLines,
  withGuestAuth,
} from "./guest-rpc.js";
import { grpc } from "./grpc/runtime-client.js";

// pingOnce is a stand-in for a real guest call: it invokes the guest client and
// settles from its callback.
function pingOnce(guest: any, _token: string): Promise<any> {
  return new Promise((resolve, reject) => {
    guest.ping({}, undefined, (error: any, value: any) => error ? reject(error) : resolve(value));
  });
}

function rejectingGuest() {
  return {
    guest: {
      ping: (_request: any, _metadata: any, callback: any) =>
        callback(
          Object.assign(new Error("invalid agent token"), {
            code: grpc.status.UNAUTHENTICATED,
          }),
        ),
    },
    token: "old",
  };
}

test("withGuestAuth retries once with a refreshed binding", async () => {
  const seen: string[] = [];
  const fresh = {
    guest: {
      ping: (_request: any, _metadata: any, callback: any) => callback(null, { version: "v" }),
    },
    token: "new",
  };
  const binding: any = { ...rejectingGuest(), refresh: async () => fresh };
  const result = await withGuestAuth(binding, (guest, token) => {
    seen.push(token);
    return pingOnce(guest, token);
  });
  assert.deepEqual(seen, ["old", "new"]);
  assert.deepEqual(result, { version: "v" });
});

test("withGuestAuth surfaces a second rejection", async () => {
  const rejecting = rejectingGuest();
  const binding: any = { ...rejecting, refresh: async () => rejecting };
  await assert.rejects(() => withGuestAuth(binding, pingOnce), /invalid agent token/);
});

test("withGuestAuth does not refresh on a non-auth error", async () => {
  let refreshed = false;
  const binding: any = {
    guest: {
      ping: (_request: any, _metadata: any, callback: any) =>
        callback(
          Object.assign(new Error("boom"), { code: grpc.status.INTERNAL }),
        ),
    },
    token: "t",
    refresh: async () => {
      refreshed = true;
      return binding;
    },
  };
  await assert.rejects(() => withGuestAuth(binding, pingOnce), /boom/);
  assert.equal(refreshed, false);
});

test("withGuestAuth surfaces the error when the binding cannot refresh", async () => {
  const binding: any = rejectingGuest();
  await assert.rejects(() => withGuestAuth(binding, pingOnce), /invalid agent token/);
});

// FakeExecStream is the guest Exec bidi stream a real channel would give us.
class FakeExecStream extends EventEmitter {
  readonly written: any[] = [];
  ended = false;
  cancelled = false;
  write(message: any): boolean {
    this.written.push(message);
    return true;
  }
  end(): void {
    this.ended = true;
  }
  cancel(): void {
    this.cancelled = true;
  }
}

// execGuest returns a guest double driving one FakeExecStream. `signal` and
// `delete` are the calls runExec makes for cancellation and spill cleanup.
function execGuest(stream: FakeExecStream) {
  const signals: string[] = [];
  return {
    stream,
    signals,
    guest: {
      exec: () => stream,
      signal: (request: any, _metadata: any, callback: any) => {
        signals.push(request.signal);
        callback(null, {});
      },
      delete: (_request: any, _metadata: any, callback: any) => callback(null, {}),
    },
  };
}

const EXIT_OK = {
  exitCode: 0,
  signaled: false,
  stdoutSpillValid: true,
  stderrSpillValid: true,
};

test("runExec resolves on exit and asks the guest for a spill copy", async () => {
  const harness = execGuest(new FakeExecStream());
  const binding: any = { guest: harness.guest, token: "t" };
  const promise = runExec(binding, ["echo", "hi"]);
  harness.stream.emit("data", { processId: "1" });
  harness.stream.emit("data", { stdoutChunk: Buffer.from("hi\n") });
  harness.stream.emit("data", { exit: EXIT_OK });
  const result = await promise;
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "hi\n");
  const start = harness.stream.written[0].start;
  assert.match(start.spillStdout.path, /^\/tmp\/dsh-podman\/[0-9a-f-]+\.stdout$/);
  assert.equal(start.spillStderr.path.endsWith(".stderr"), true);
  // The output fit in memory, so the spill file is deleted again.
  assert.equal(result.stdoutSpillPath, undefined);
});

test("runExec rejects when the stream ends without an exit message", async () => {
  const harness = execGuest(new FakeExecStream());
  const binding: any = { guest: harness.guest, token: "t" };
  const promise = runExec(binding, ["hang"]);
  harness.stream.emit("end");
  await assert.rejects(promise, /ended before the process exited/);
});

test("runExec aborts with the turn signal, then escalates to SIGKILL", async () => {
  const harness = execGuest(new FakeExecStream());
  const binding: any = { guest: harness.guest, token: "t" };
  const controller = new AbortController();
  const promise = runExec(binding, ["sleep", "99"], undefined, undefined, undefined, undefined, {
    signal: controller.signal,
    killGraceMs: 60,
  });
  harness.stream.emit("data", { processId: "7" });
  controller.abort();
  await assert.rejects(promise, /aborted/);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(harness.signals, ["SIGTERM"]);
  // The stream stays open for the grace period, so a command that ignores
  // SIGTERM can still be killed by its process group.
  assert.equal(harness.stream.cancelled, false);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(harness.signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(harness.stream.cancelled, true);
});

test("runExec leaves a command that exits within the grace period alone", async () => {
  const harness = execGuest(new FakeExecStream());
  const binding: any = { guest: harness.guest, token: "t" };
  const controller = new AbortController();
  const promise = runExec(binding, ["sleep", "99"], undefined, undefined, undefined, undefined, {
    signal: controller.signal,
    killGraceMs: 30,
  });
  harness.stream.emit("data", { processId: "7" });
  controller.abort();
  await assert.rejects(promise, /aborted/);
  harness.stream.emit("data", { exit: EXIT_OK });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(harness.signals, ["SIGTERM"]);
  assert.equal(harness.stream.cancelled, false);
});

test("runExec cancels an abort that arrives before the process id", async () => {
  const harness = execGuest(new FakeExecStream());
  const binding: any = { guest: harness.guest, token: "t" };
  const controller = new AbortController();
  const promise = runExec(binding, ["sleep", "99"], undefined, undefined, undefined, undefined, {
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(promise, /aborted/);
  assert.equal(harness.stream.cancelled, true);
  assert.deepEqual(harness.signals, []);
});

test("runExec rejects a pre-aborted call without starting it", async () => {
  const harness = execGuest(new FakeExecStream());
  const binding: any = { guest: harness.guest, token: "t" };
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () =>
      runExec(binding, ["x"], undefined, undefined, undefined, undefined, {
        signal: controller.signal,
      }),
    /aborted/,
  );
  assert.equal(harness.stream.written.length, 0);
});

test("runExec keeps a bounded tail and points at the spill on truncation", async () => {
  const harness = execGuest(new FakeExecStream());
  const binding: any = { guest: harness.guest, token: "t" };
  const promise = runExec(binding, ["big"], undefined, undefined, undefined, undefined, {
    maxBytes: 4,
    spillBytes: 1024,
  });
  harness.stream.emit("data", { stdoutChunk: Buffer.from("0123456789") });
  harness.stream.emit("data", { exit: EXIT_OK });
  const result = await promise;
  assert.equal(result.stdout, "6789", "only the bounded tail is retained");
  assert.match(result.stdoutSpillPath ?? "", /^\/tmp\/dsh-podman\/[0-9a-f-]+\.stdout$/);
});

test("sessionWorkspaceSlug fails instead of fabricating a default workspace", async () => {
  const resolver: any = { registry: { resolveByPath: async () => undefined } };
  await assert.rejects(
    () => sessionWorkspaceSlug(resolver, "/projects/gone"),
    /cannot resolve a DH workspace/,
  );
});

// chunks yields one character at a time, the worst case for a streaming line
// reader because every boundary can fall inside a line.
async function* characters(content: string): AsyncGenerator<string> {
  for (const character of content) yield character;
}

test("streamLines matches sliceLines for every window shape", async () => {
  const cases: Array<[string, number, number]> = [
    ["", 1, 5],
    ["a", 1, 5],
    ["a\n", 1, 5],
    ["a\nb\nc", 1, 2],
    ["a\nb\nc\n", 1, 2],
    ["a\nb\nc\n", 2, 2],
    ["a\nb\nc\n", 2, 10],
    ["a\nb", 2, 2],
    ["a\nb", 5, 2],
    ["x\ny\nz\n", 3, 10],
    ["1\n2\n3\n4\n5", 2, 3],
    ["\n\n\n", 2, 2],
  ];
  for (const [content, offset, limit] of cases) {
    const expected = sliceLines(content, offset, limit);
    const streamed = await streamLines(characters(content), offset, limit);
    assert.equal(
      streamed,
      expected,
      `content=${JSON.stringify(content)} offset=${offset} limit=${limit}`,
    );
  }
});

test("streamLines stops consuming once the window is filled", async () => {
  let consumed = 0;
  async function* source(): AsyncGenerator<string> {
    for (let index = 1; index <= 100; index++) {
      consumed++;
      yield `${index}\n`;
    }
  }
  const out = await streamLines(source(), 1, 2);
  assert.equal(out, "1\n2");
  assert.equal(consumed, 2);
});
