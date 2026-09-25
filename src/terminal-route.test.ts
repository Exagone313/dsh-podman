// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import { FakeExecStream, FakeTerminalCall, WORKSPACE_ID } from "./test-support.js";
import {
  TERMINAL_PATH,
  TERMINAL_RETAINED_PATH,
  TERMINAL_SHELLS_PATH,
  type TerminalFrame,
  type TerminalShellView,
} from "./client/terminal-protocol.js";
import { discoverShells, requireShell } from "./terminal-shells.js";
import { TerminalSessions } from "./terminal-sessions.js";
import { registerTerminalRoutes } from "./terminal-route.js";

const ROOT = "/projects/team";

function fakeGuest(options: { stdout?: string } = {}) {
  const terminal = new FakeTerminalCall();
  const starts: Array<Record<string, any>> = [];
  return {
    terminal,
    starts,
    binding: {
      guest: {
        exec: () => new FakeExecStream(starts, { stdout: options.stdout ?? "" }),
        terminal: () => terminal,
      },
      token: "t",
    },
  };
}

function fakeResolver(binding: any) {
  const calls: string[] = [];
  return {
    calls,
    resolveForPath: async () => {
      calls.push("default");
      return binding;
    },
    containerBinding: async (_cwd: unknown, container: string) => {
      calls.push(container);
      return binding;
    },
    getConfig: () => ({ projectsRoot: "/projects" }),
  } as any;
}

function fakeRegistry() {
  return { list: () => [{ id: WORKSPACE_ID, path: ROOT }] };
}

function routeHarness(sessions: TerminalSessions, resolver: any) {
  const routes = new Map<string, any>();
  const ctx = {
    inject: (_names: string[], fn: (child: any) => void) => {
      fn({
        connection: {
          fetch: {
            register: (route: any) => {
              routes.set(route.path, route);
              return async () => {};
            },
          },
        },
      });
    },
    get: () => undefined,
  };
  registerTerminalRoutes(ctx, resolver, sessions, fakeRegistry());
  return routes;
}

test("shell discovery parses the probe, dedups and prefers the most capable shell", async () => {
  const { binding } = fakeGuest({
    stdout:
      "sh\t/usr/bin/sh\nbash\t/usr/bin/bash\nzsh\t/opt/tools/bin/zsh\nnot a path\nbash\t/bin/bash\ndash\t/usr/bin/dash\nfish\t/usr/bin/fish\n",
  });
  const shells = await discoverShells(binding as any, ROOT);
  assert.deepEqual(
    shells.map((shell) => `${shell.name}=${shell.path}`),
    [
      "zsh=/opt/tools/bin/zsh",
      "bash=/usr/bin/bash",
      "fish=/usr/bin/fish",
      "dash=/usr/bin/dash",
      "sh=/usr/bin/sh",
    ],
  );
});

test("shell discovery ignores names outside the candidate list", async () => {
  const { binding } = fakeGuest({
    stdout: "rbash\t/usr/bin/rbash\ngit-shell\t/usr/bin/git-shell\n",
  });
  assert.deepEqual(await discoverShells(binding as any, ROOT), []);
});

test("a shell missing from the probe is refused", async () => {
  const { binding } = fakeGuest({ stdout: "bash\t/usr/bin/bash\n" });
  await assert.rejects(
    () => requireShell(binding as any, ROOT, "/bin/zsh"),
    /not available in this container/,
  );
});

test("terminal sessions stream frames, retain the shell and control it", async () => {
  const { binding, terminal } = fakeGuest({ stdout: "bash\t/usr/bin/bash\n" });
  const resolver = fakeResolver(binding);
  const sessions = new TerminalSessions({ resolver, retentionMs: 60_000 });
  try {
    const prepared = await sessions.prepare({
      sessionId: "s1",
      tabId: "t1",
      workspace: "team",
      cwd: ROOT,
      container: "",
      shell: "/usr/bin/bash",
      cols: 80,
      rows: 24,
    });
    assert.equal(prepared.attached, false);
    assert.deepEqual(resolver.calls, ["default"]);

    const frames: TerminalFrame[] = [];
    const detach = sessions.listen(
      prepared.terminalId,
      (frame) => frames.push(frame),
      new AbortController().signal,
    );
    assert.equal(frames[0]?.type, "ready");
    terminal.emitStdout(Buffer.from("hi"));
    assert.deepEqual(frames.at(-1), {
      type: "data",
      data: Buffer.from("hi").toString("base64"),
    });

    assert.equal(
      sessions.control({
        terminalId: prepared.terminalId,
        kind: "input",
        data: Buffer.from("x").toString("base64"),
      }),
      true,
    );
    assert.deepEqual(terminal.stdinChunks, [Buffer.from("x")]);
    assert.equal(
      sessions.control({
        terminalId: prepared.terminalId,
        kind: "resize",
        cols: 100,
        rows: 30,
      }),
      true,
    );
    assert.deepEqual(terminal.resizes, [{ cols: 100, rows: 30 }]);
    assert.equal(
      sessions.control({ terminalId: prepared.terminalId, kind: "rename", title: "dev" }),
      true,
    );
    assert.deepEqual(frames.at(-1), { type: "title", title: "dev" });

    terminal.emitExit(0);
    // The exit frame is written from the guest's done promise.
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(frames.at(-1)?.type, "exit");

    // Reattaching replays the serialized screen and the exit state.
    const again = await sessions.prepare({
      sessionId: "s1",
      tabId: "t1",
      workspace: "team",
      cwd: ROOT,
      container: "",
      shell: "/usr/bin/bash",
      cols: 80,
      rows: 24,
    });
    assert.equal(again.attached, true);
    assert.equal(again.terminalId, prepared.terminalId);
    const reattached: TerminalFrame[] = [];
    sessions.listen(
      again.terminalId,
      (frame) => reattached.push(frame),
      new AbortController().signal,
      again.snapshot,
    );
    assert.equal(reattached[0]?.type, "ready");
    assert.equal(reattached[1]?.type, "snapshot");
    assert.equal(reattached.at(-1)?.type, "exit");

    // A named container resolves through containerBinding.
    const other = await sessions.prepare({
      sessionId: "s1",
      tabId: "t2",
      workspace: "team",
      cwd: ROOT,
      container: "dev",
      shell: "/usr/bin/bash",
      cols: 80,
      rows: 24,
    });
    assert.deepEqual(resolver.calls, ["default", "dev"]);
    assert.equal(sessions.retained("s1").length, 2);
    assert.equal(sessions.control({ terminalId: other.terminalId, kind: "close" }), true);
    assert.equal(sessions.retained("s1").length, 1);
    detach();
  } finally {
    sessions.dispose();
  }
});

test("terminal routes open, control, list and validate", async () => {
  const { binding, terminal } = fakeGuest({ stdout: "bash\t/usr/bin/bash\n" });
  const resolver = fakeResolver(binding);
  const sessions = new TerminalSessions({ resolver, retentionMs: 60_000 });
  try {
    const routes = routeHarness(sessions, resolver);
    const open = routes.get(TERMINAL_PATH);
    assert.ok(open);

    const missingShell = await open.fetch(
      new Request(
        `http://dsh.internal${TERMINAL_PATH}?sessionId=s1&tabId=t1&workspace=team&cols=80&rows=24`,
      ),
    );
    assert.equal(missingShell.status, 400);
    const unknownWorkspace = await open.fetch(
      new Request(
        `http://dsh.internal${TERMINAL_PATH}?sessionId=s1&tabId=t1&workspace=nope&shell=/usr/bin/bash&cols=80&rows=24`,
      ),
    );
    assert.equal(unknownWorkspace.status, 400);

    const response = await open.fetch(
      new Request(
        `http://dsh.internal${TERMINAL_PATH}?sessionId=s1&tabId=t1&workspace=team&shell=/usr/bin/bash&cols=80&rows=24`,
      ),
    );
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/x-ndjson");
    const reader = response.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    assert.match(first, /"type":"ready"/);
    const ready = JSON.parse(first.trim().split("\n")[0]) as { terminalId: string };

    const control = await open.fetch(
      new Request(`http://dsh.internal${TERMINAL_PATH}`, {
        method: "POST",
        body: JSON.stringify({ terminalId: ready.terminalId, kind: "resize", cols: 90, rows: 30 }),
      }),
    );
    assert.equal(control.status, 200);
    assert.deepEqual(terminal.resizes, [{ cols: 90, rows: 30 }]);
    const unknownTerminal = await open.fetch(
      new Request(`http://dsh.internal${TERMINAL_PATH}`, {
        method: "POST",
        body: JSON.stringify({ terminalId: "nope", kind: "close" }),
      }),
    );
    assert.equal(unknownTerminal.status, 404);

    const shellsResponse = await routes.get(TERMINAL_SHELLS_PATH).fetch(
      new Request(`http://dsh.internal${TERMINAL_SHELLS_PATH}?workspace=team&sessionId=s1`),
    );
    const shellsBody = (await shellsResponse.json()) as { shells: TerminalShellView[] };
    assert.deepEqual(shellsBody.shells.map((shell) => shell.path), ["/usr/bin/bash"]);

    const retainedResponse = await routes.get(TERMINAL_RETAINED_PATH).fetch(
      new Request(`http://dsh.internal${TERMINAL_RETAINED_PATH}?sessionId=s1`),
    );
    const retainedBody = (await retainedResponse.json()) as {
      terminals: Array<{ tabId: string }>;
    };
    assert.equal(retainedBody.terminals.length, 1);
    assert.equal(retainedBody.terminals[0]?.tabId, "t1");
    await reader.cancel();
  } finally {
    sessions.dispose();
  }
});
