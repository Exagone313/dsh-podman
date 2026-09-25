// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// Live tab titles for the Podman terminal, the browser-side peer of the built-in
// terminal's live name: the host names the running shell in the open stream's
// `ready` (and `title`) frames, the tab body publishes it here, and the tab chip
// renders it. The store is module-level and DOM-free so it can be unit-tested
// from the host program.

const titles = new Map<string, string>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/**
 * Publish the name the host reported for one terminal.
 * @param key - `${sessionId}:${tabId}`, the same composite the host retains by.
 * @param title - the running shell's name.
 */
export function publishTerminalTitle(key: string, title: string): void {
  if (title === "" || titles.get(key) === title) return;
  titles.set(key, title);
  emit();
}

/**
 * Drop one terminal's title when its body goes away.
 * @param key - the same composite {@link publishTerminalTitle} used.
 */
export function forgetTerminalTitle(key: string): void {
  if (titles.delete(key)) emit();
}

/**
 * Read the published title.
 * @param key - the same composite {@link publishTerminalTitle} used.
 * @returns the name, or `undefined` while nothing has been published.
 */
export function terminalTitle(key: string): string | undefined {
  return titles.get(key);
}

/**
 * Subscribe to title changes.
 * @param listener - called after every publish or forget.
 * @returns the unsubscriber.
 */
export function subscribeTerminalTitles(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
