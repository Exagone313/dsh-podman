// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import {
  isWorkspacePendingError,
  WorkspacePendingError,
} from "./client/terminal-errors.js";
import { WORKSPACE_PENDING_CODE } from "./client/terminal-protocol.js";
import {
  fetchTerminalTarget,
  TERMINAL_TARGET_READY_WAIT_MS,
} from "./client/terminal-transport.js";

// The transport reads `location` and `fetch` from the global scope; these
// tests give it just those faces and restore the real ones afterwards.
async function stubFetch<T>(
  handler: (url: URL) => Response,
  run: (seen: URL[]) => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  const originalLocation = (globalThis as { location?: unknown }).location;
  const seen: URL[] = [];
  (globalThis as { location?: unknown }).location = {
    origin: "http://dsh.internal",
  };
  globalThis.fetch = (async (input: any) => {
    const url = input instanceof URL ? input : new URL(String(input));
    seen.push(url);
    return handler(url);
  }) as typeof globalThis.fetch;
  try {
    return await run(seen);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalLocation === undefined) {
      delete (globalThis as { location?: unknown }).location;
    } else {
      (globalThis as { location?: unknown }).location = originalLocation;
    }
  }
}

test("the target read forwards its wait and parses the workspace", async () => {
  await stubFetch(
    () =>
      new Response(
        JSON.stringify({ workspace: "team", workspaceSlug: "slug-1" }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    async (seen) => {
      const target = await fetchTerminalTarget("s1", undefined, {
        waitMs: 1500,
      });
      assert.deepEqual(target, { workspace: "team", workspaceSlug: "slug-1" });
      assert.equal(seen.length, 1);
      assert.equal(seen[0]?.searchParams.get("sessionId"), "s1");
      assert.equal(seen[0]?.searchParams.get("wait"), "1500");
    },
  );
  // The terminal panes' short wait is the transport's own default input; an
  // omitted (or non-positive) wait must not add the parameter.
  await stubFetch(
    () => new Response(JSON.stringify({ workspace: "team" }), { status: 200 }),
    async (seen) => {
      assert.equal(TERMINAL_TARGET_READY_WAIT_MS, 1_000);
      await fetchTerminalTarget("s1");
      await fetchTerminalTarget("s1", undefined, { waitMs: 0 });
      assert.equal(seen[0]?.searchParams.has("wait"), false);
      assert.equal(seen[1]?.searchParams.has("wait"), false);
    },
  );
});

test("a pending workspace maps to the typed retryable error", async () => {
  await stubFetch(
    () =>
      new Response(
        JSON.stringify({
          error: "Cannot determine this session's workspace",
          code: WORKSPACE_PENDING_CODE,
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      ),
    async () => {
      await assert.rejects(
        () => fetchTerminalTarget("s1", undefined, { waitMs: 1000 }),
        (error: unknown) => {
          assert.ok(error instanceof WorkspacePendingError);
          assert.ok(isWorkspacePendingError(error));
          assert.equal(error.code, WORKSPACE_PENDING_CODE);
          return true;
        },
      );
    },
  );
});

test("other target failures stay generic", async () => {
  await stubFetch(
    () =>
      new Response(JSON.stringify({ error: "boom" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    async () => {
      await assert.rejects(
        () => fetchTerminalTarget("s1", undefined, { waitMs: 1000 }),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.ok(!(error instanceof WorkspacePendingError));
          assert.ok(!isWorkspacePendingError(error));
          assert.equal(error.message, "boom");
          return true;
        },
      );
    },
  );
});
