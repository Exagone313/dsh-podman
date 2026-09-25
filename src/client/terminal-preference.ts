// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// Browser-local memory of the target last started from the terminal card,
// mirroring the harness's own client preferences: an origin-local,
// `dsh.`-prefixed localStorage entry, read and written behind try/catch so
// private browsing or a quota failure can never break the card.

/** Origin-local key holding the target the card last started. */
export const TERMINAL_TARGET_KEY = "dsh.podman.terminal.v1";

/** What the card starts: a logical container name and a verified shell path. */
export interface TerminalTargetPreference {
  /** `""`/"default" for the workspace's default container, or a named one. */
  readonly container?: string;
  /** Absolute path of a shell the host offered. */
  readonly shell?: string;
}

/** The two storage operations the preference needs. */
export interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

// Accessed through globalThis so this module stays typecheckable without the
// DOM lib (the host test program imports it), and guarded because even reading
// the property can throw in a sandboxed frame.
function browserStorage(): PreferenceStorage | undefined {
  try {
    const candidate = (globalThis as { localStorage?: PreferenceStorage })
      .localStorage;
    return candidate === undefined ? undefined : candidate;
  } catch {
    return undefined;
  }
}

/**
 * Read the remembered target.
 * @param storage - storage override for tests; the browser's localStorage otherwise.
 * @returns the remembered target, or `undefined` when absent or unusable.
 */
export function readTerminalTarget(
  storage?: PreferenceStorage,
): TerminalTargetPreference | undefined {
  try {
    const raw = (storage ?? browserStorage())?.getItem(TERMINAL_TARGET_KEY);
    if (raw === undefined || raw === null || raw === "") return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }
    const record = parsed as Record<string, unknown>;
    const container = typeof record.container === "string" ? record.container : undefined;
    const shell = typeof record.shell === "string" ? record.shell : undefined;
    if (container === undefined && shell === undefined) return undefined;
    return {
      ...(container === undefined ? {} : { container }),
      ...(shell === undefined ? {} : { shell }),
    };
  } catch {
    // Malformed JSON, or storage that refuses to answer, leaves the card on its
    // own defaults.
    return undefined;
  }
}

/**
 * Remember the target, best effort.
 * @param target - the container and shell that were started.
 * @param storage - storage override for tests; the browser's localStorage otherwise.
 */
export function writeTerminalTarget(
  target: TerminalTargetPreference,
  storage?: PreferenceStorage,
): void {
  try {
    (storage ?? browserStorage())?.setItem(
      TERMINAL_TARGET_KEY,
      JSON.stringify(target),
    );
  } catch {
    // Private browsing or a quota failure leaves this launch usable.
  }
}
