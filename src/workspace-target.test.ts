// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import type { ContainerView } from "./client/card-protocol.js";
import { containersInWorkspace } from "./client/container-panel-scope.js";
import { WorkspacePendingError } from "./client/terminal-errors.js";
import {
  waitForWorkspaceTarget,
  WORKSPACE_RETRY_BUDGET_MS,
  WORKSPACE_RETRY_INITIAL_DELAY_MS,
  WORKSPACE_RETRY_MAX_DELAY_MS,
  workspaceRetryDelay,
} from "./client/workspace-target.js";

function row(containerName: string, workspaceSlug: string): ContainerView {
  return { containerName, workspaceSlug, status: "running" } as ContainerView;
}

test("the retry backoff doubles from 250 ms and caps at 2 s", () => {
  const delays = [0, 1, 2, 3, 4, 5].map((attempt) =>
    workspaceRetryDelay(attempt, 0)
  );
  assert.deepEqual(delays, [250, 500, 1_000, 2_000, 2_000, 2_000]);
  assert.equal(WORKSPACE_RETRY_INITIAL_DELAY_MS, 250);
  assert.equal(WORKSPACE_RETRY_MAX_DELAY_MS, 2_000);
  // No retry once the budget is spent, and the last one stays inside it.
  assert.equal(workspaceRetryDelay(0, WORKSPACE_RETRY_BUDGET_MS), undefined);
  assert.equal(workspaceRetryDelay(0, WORKSPACE_RETRY_BUDGET_MS - 100), 100);
});

test("a pending workspace is retried until the target resolves", async () => {
  const target = { workspace: "alpha", workspaceSlug: "alpha" };
  const delays: number[] = [];
  let calls = 0;
  const result = await waitForWorkspaceTarget({
    signal: new AbortController().signal,
    now: () => 0,
    sleep: async (delay) => {
      delays.push(delay);
    },
    fetchTarget: async () => {
      calls++;
      if (calls < 3) throw new WorkspacePendingError("still starting");
      return target;
    },
  });
  assert.equal(result.status, "ready");
  assert.equal(calls, 3);
  assert.deepEqual(delays, [250, 500]);
  if (result.status !== "ready") return;
  // Reaching ready is what lets the pane list exactly that workspace's rows.
  const containers = [row("default", "alpha"), row("db", "beta")];
  assert.deepEqual(
    containersInWorkspace(containers, result.target).map((container) =>
      container.containerName
    ),
    ["default"],
  );
});

test("a real target failure stops at once", async () => {
  let calls = 0;
  const result = await waitForWorkspaceTarget({
    signal: new AbortController().signal,
    now: () => 0,
    sleep: async () => {},
    fetchTarget: async () => {
      calls++;
      throw new Error("network down");
    },
  });
  assert.equal(result.status, "failed");
  assert.equal(calls, 1);
  if (result.status !== "failed") return;
  assert.equal((result.error as Error).message, "network down");
});

test("aborting during a retry stops further calls", async () => {
  const controller = new AbortController();
  let calls = 0;
  const delays: number[] = [];
  const result = await waitForWorkspaceTarget({
    signal: controller.signal,
    now: () => 0,
    sleep: async (delay) => {
      delays.push(delay);
      controller.abort();
    },
    fetchTarget: async () => {
      calls++;
      throw new WorkspacePendingError();
    },
  });
  assert.equal(result.status, "aborted");
  assert.equal(calls, 1);
  assert.deepEqual(delays, [250]);
});

test("the pending wait gives up once the budget is spent", async () => {
  const times = [0, 5_000, 10_000, 15_000];
  let clock = 0;
  let calls = 0;
  const delays: number[] = [];
  const result = await waitForWorkspaceTarget({
    signal: new AbortController().signal,
    now: () => times[Math.min(clock++, times.length - 1)] ?? 0,
    sleep: async (delay) => {
      delays.push(delay);
    },
    fetchTarget: async () => {
      calls++;
      throw new WorkspacePendingError();
    },
  });
  assert.equal(result.status, "pending");
  assert.equal(calls, 3);
  assert.deepEqual(delays, [250, 500]);
});
