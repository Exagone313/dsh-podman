// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// The terminal tab's browser half of the host routes. Everything travels over
// same-origin `fetch` on the harness API channel, which carries the browser
// session the harness issued for it; no service is injected here so the module
// stays testable and usable from any component.

import {
  TERMINAL_PATH,
  TERMINAL_RETAINED_PATH,
  TERMINAL_SHELLS_PATH,
  TERMINAL_TARGET_PATH,
  type TerminalControl,
  type TerminalFrame,
  type TerminalOpenQuery,
  type TerminalRetainedView,
  type TerminalShellView,
  type TerminalTargetView,
} from "./terminal-protocol.js";

// `reopen` forces a fresh shell instead of reattaching the retained one.
export type TerminalStreamQuery = TerminalOpenQuery & { readonly reopen?: boolean };

async function failure(response: Response): Promise<Error> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error !== "") {
      return new Error(body.error);
    }
  } catch {
    // A non-JSON body falls through to the status text.
  }
  return new Error(`terminal request failed (${response.status})`);
}

function endpoint(path: string): URL {
  return new URL(path, globalThis.location.origin);
}

function trimmed(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Open or reattach one terminal and deliver every frame to `onFrame`.
 *
 * The route answers one JSON frame per line (`application/x-ndjson`), so the
 * body is decoded incrementally and split on newlines; a partial trailing line
 * is flushed once the stream ends. Aborting `signal` rejects the returned
 * promise with an `AbortError`, which callers treat as a closed stream rather
 * than a failure.
 * @param query - session, tab, target shell and initial geometry.
 * @param onFrame - per-frame callback, in arrival order.
 * @param signal - lifetime of this attachment.
 */
export async function openTerminalStream(
  query: TerminalStreamQuery,
  onFrame: (frame: TerminalFrame) => void,
  signal: AbortSignal,
): Promise<void> {
  const url = endpoint(TERMINAL_PATH);
  url.searchParams.set("sessionId", query.sessionId);
  url.searchParams.set("tabId", query.tabId);
  url.searchParams.set("workspace", query.workspace);
  url.searchParams.set("container", query.container);
  url.searchParams.set("shell", query.shell);
  url.searchParams.set("cols", String(query.cols));
  url.searchParams.set("rows", String(query.rows));
  if (query.reopen === true) url.searchParams.set("reopen", "1");
  const response = await fetch(url, {
    headers: { accept: "application/x-ndjson" },
    signal,
  });
  if (!response.ok) throw await failure(response);
  if (response.body === null) throw new Error("terminal stream has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  const emit = (line: string): void => {
    const text = line.trim();
    if (text === "") return;
    onFrame(JSON.parse(text) as TerminalFrame);
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += decoder.decode(value, { stream: true });
    let newline = buffered.indexOf("\n");
    while (newline !== -1) {
      emit(buffered.slice(0, newline));
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf("\n");
    }
  }
  // A multi-byte character split across the last chunk survives this flush.
  buffered += decoder.decode();
  if (buffered !== "") emit(buffered);
}

/**
 * Send one control request (input, resize, rename or close).
 * @param control - the control to apply.
 * @throws when the host refuses it: an unknown terminal, or a malformed body.
 */
export async function sendTerminalControl(control: TerminalControl): Promise<void> {
  const response = await fetch(endpoint(TERMINAL_PATH), {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify(control),
  });
  if (!response.ok) throw await failure(response);
}

/**
 * List the shells a container really provides, `sh`/`bash` first.
 * @param workspace - the workspace project name, or `""` for the session cwd.
 * @param container - `""`/`"default"` for the default container, or a named one.
 * @param sessionId - owning session, used by the host when `workspace` is empty.
 * @param signal - cancellation of the probe.
 * @returns the verified shells, in host order.
 */
export async function fetchTerminalShells(
  workspace: string,
  container: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<TerminalShellView[]> {
  const url = endpoint(TERMINAL_SHELLS_PATH);
  url.searchParams.set("workspace", workspace);
  url.searchParams.set("container", container);
  url.searchParams.set("sessionId", sessionId);
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal,
  });
  if (!response.ok) throw await failure(response);
  const body = (await response.json()) as { shells?: unknown };
  if (!Array.isArray(body.shells)) return [];
  return body.shells.map((shell) => ({
    name: trimmed((shell as { name?: unknown }).name),
    path: trimmed((shell as { path?: unknown }).path),
  }));
}

/**
 * The workspace the host resolved for one session.
 *
 * A Session belongs to exactly one workspace, whose side panes — and terminals —
 * are its own, so the browser never asks for a workspace: the host answers from
 * the session itself and reports when it cannot place it.
 * @param sessionId - owning session.
 * @param signal - cancellation of the read.
 * @returns the resolved workspace and its harness workspace slug.
 * @throws when the host cannot determine the session's workspace.
 */
export async function fetchTerminalTarget(
  sessionId: string,
  signal?: AbortSignal,
): Promise<TerminalTargetView> {
  const url = endpoint(TERMINAL_TARGET_PATH);
  url.searchParams.set("sessionId", sessionId);
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal,
  });
  if (!response.ok) throw await failure(response);
  const body = (await response.json()) as {
    workspace?: unknown;
    workspaceSlug?: unknown;
  };
  return {
    workspace: trimmed(body.workspace),
    workspaceSlug: trimmed(body.workspaceSlug),
  };
}

/**
 * List the terminals this session still has retained on the host.
 * @param sessionId - owning session.
 * @returns the retained terminals, oldest first.
 */
export async function fetchRetainedTerminals(
  sessionId: string,
): Promise<TerminalRetainedView[]> {
  const url = endpoint(TERMINAL_RETAINED_PATH);
  url.searchParams.set("sessionId", sessionId);
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw await failure(response);
  const body = (await response.json()) as { terminals?: unknown };
  if (!Array.isArray(body.terminals)) return [];
  return body.terminals.map((terminal) => {
    const view = terminal as Record<string, unknown>;
    return {
      tabId: trimmed(view.tabId),
      terminalId: trimmed(view.terminalId),
      title: trimmed(view.title),
      workspace: trimmed(view.workspace),
      container: trimmed(view.container),
      shell: trimmed(view.shell),
    };
  });
}

/**
 * Encode bytes for the wire. Control frames carry binary keyboard input, so the
 * conversion is byte-exact and never goes through a UTF-8 string round trip.
 * @param bytes - raw bytes.
 * @returns standard base64.
 */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index++) {
    binary += String.fromCharCode(bytes[index]);
  }
  return btoa(binary);
}

/**
 * Decode wire bytes into a `Uint8Array` xterm can write unchanged.
 * @param data - standard base64.
 * @returns the decoded bytes.
 */
export function base64ToBytes(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
