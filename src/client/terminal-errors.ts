// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// The typed refusals of the terminal transport. They live apart from the
// transport so the retry policy can recognize a pending workspace without
// importing a module that touches browser `fetch` and `location`.

import { WORKSPACE_PENDING_CODE } from "./terminal-protocol.js";

/** The session's workspace is not registered yet; asking again can succeed. */
export class WorkspacePendingError extends Error {
  readonly code = WORKSPACE_PENDING_CODE;

  constructor(message?: string) {
    super(message);
    this.name = "WorkspacePendingError";
  }
}

/**
 * Whether one failure is the target route's retryable pending answer.
 * @param error - anything a target request rejected with.
 * @returns true for `WorkspacePendingError` or an error carrying its code.
 */
export function isWorkspacePendingError(
  error: unknown,
): error is WorkspacePendingError {
  if (error instanceof WorkspacePendingError) return true;
  return typeof error === "object" && error !== null &&
    (error as { code?: unknown }).code === WORKSPACE_PENDING_CODE;
}
