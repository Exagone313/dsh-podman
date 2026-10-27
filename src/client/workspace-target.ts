// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// The Containers tab's wait for the Session workspace. A page load, a restored
// tab and a newly created Session can all ask the host before its workspace has
// registered; the route then answers `workspace-pending` instead of refusing.
// This module owns the retry policy: a short wait per request, then a capped
// exponential backoff inside one total budget, after which the pane offers a
// manual retry rather than showing a hard error.
//
// Everything here is environment-free: timers and the clock are injectable so
// the loop can be driven by the host test program.

import { isWorkspacePendingError } from "./terminal-errors.js";
import type { TerminalTargetView } from "./terminal-protocol.js";

/** How long each target request waits on the host before reporting pending. */
export const WORKSPACE_TARGET_WAIT_MS = 1_000;

/** First backoff delay between target requests. */
export const WORKSPACE_RETRY_INITIAL_DELAY_MS = 250;

/** Longest backoff delay between target requests. */
export const WORKSPACE_RETRY_MAX_DELAY_MS = 2_000;

/** Total time the pane keeps retrying a pending workspace before asking. */
export const WORKSPACE_RETRY_BUDGET_MS = 15_000;

/**
 * The delay before one retry, or undefined once the budget is spent.
 *
 * The first retry waits 250 ms, then each doubles up to 2 s. A delay never
 * runs past the remaining budget, so the pane stops close to 15 s.
 * @param attempt - zero-based retry number.
 * @param elapsedMs - time spent since the first request.
 * @returns the delay in milliseconds, or undefined to stop retrying.
 */
export function workspaceRetryDelay(
  attempt: number,
  elapsedMs: number,
): number | undefined {
  if (elapsedMs >= WORKSPACE_RETRY_BUDGET_MS) return undefined;
  const nominal = Math.min(
    WORKSPACE_RETRY_INITIAL_DELAY_MS * 2 ** attempt,
    WORKSPACE_RETRY_MAX_DELAY_MS,
  );
  return Math.min(nominal, WORKSPACE_RETRY_BUDGET_MS - elapsedMs);
}

/** What waiting for the Session workspace settled on. */
export type WorkspaceTargetResult =
  | { readonly status: "ready"; readonly target: TerminalTargetView }
  | { readonly status: "pending" }
  | { readonly status: "failed"; readonly error: unknown }
  | { readonly status: "aborted" };

/** Inputs of {@link waitForWorkspaceTarget}. */
export interface WorkspaceTargetOptions {
  /** One target read; rejects with a pending error while the workspace starts. */
  readonly fetchTarget: (signal: AbortSignal) => Promise<TerminalTargetView>;
  /** Cancels the loop, its sleep and any state update the caller makes. */
  readonly signal: AbortSignal;
  /** Test seam: the delay implementation. Defaults to an abortable timer. */
  readonly sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  /** Test seam: the clock. Defaults to `Date.now`. */
  readonly now?: () => number;
}

function abortableSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || delayMs <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, delayMs);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Read the Session workspace, retrying the host's pending answer.
 *
 * The first request carries a short wait. A pending answer is retried with a
 * capped exponential backoff for about 15 s; any other failure stops at once.
 * Aborting resolves `aborted`, and the sleep is cut short so no timer outlives
 * the pane.
 * @param options - the request, its lifetime and the test seams.
 * @returns the resolved target, the exhausted pending wait, the real failure or
 * the abort.
 */
export async function waitForWorkspaceTarget(
  options: WorkspaceTargetOptions,
): Promise<WorkspaceTargetResult> {
  const { fetchTarget, signal } = options;
  const sleep = options.sleep ?? abortableSleep;
  const now = options.now ?? Date.now;
  const startedAt = now();
  for (let attempt = 0;; attempt++) {
    if (signal.aborted) return { status: "aborted" };
    try {
      return { status: "ready", target: await fetchTarget(signal) };
    } catch (error) {
      if (signal.aborted) return { status: "aborted" };
      if (!isWorkspacePendingError(error)) {
        return { status: "failed", error };
      }
    }
    const delay = workspaceRetryDelay(attempt, now() - startedAt);
    if (delay === undefined) return { status: "pending" };
    await sleep(delay, signal);
    if (signal.aborted) return { status: "aborted" };
  }
}
