// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// What a guarded mutation learns from comparing the version its caller
// observed with the version the target has now. Kept pure so the stale, missing
// and unchanged branches are unit-tested without a guest.
export type FsGuardDecision = "unchanged" | "stale" | "missing";

// guardDecision compares an observed version with the target's current one. An
// absent current version means the target is gone, which the edit guard reports
// as not found; an unobserved caller (no expected version) is unguarded and may
// proceed; otherwise the two versions must match exactly.
export function guardDecision(
  expectedVersion: string | undefined,
  currentVersion: string | undefined,
): FsGuardDecision {
  if (currentVersion === undefined) return "missing";
  if (expectedVersion === undefined) return "unchanged";
  return expectedVersion === currentVersion ? "unchanged" : "stale";
}
