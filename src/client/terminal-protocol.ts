// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// Wire contract between the Podman terminal tab (client half) and the host
// routes that bridge it to a guest terminal. Paths are exact: the connection
// service dispatches one route per path.

/** Open or attach one browser terminal. */
export const TERMINAL_PATH = "/api/podman/terminal";

/** The shells a container really provides, discovered on its PATH. */
export const TERMINAL_SHELLS_PATH = "/api/podman/terminal/shells";

/** The terminals a session still has retained on the host. */
export const TERMINAL_RETAINED_PATH = "/api/podman/terminal/retained";

/** One shell verified inside a container. */
export interface TerminalShellView {
  readonly name: string;
  readonly path: string;
}

/** What the host knows about a retained terminal. */
export interface TerminalRetainedView {
  readonly tabId: string;
  readonly terminalId: string;
  readonly title: string;
  readonly workspace: string;
  readonly container: string;
  readonly shell: string;
}

/** Query parameters of the open/attach stream. */
export interface TerminalOpenQuery {
  readonly sessionId: string;
  readonly tabId: string;
  readonly workspace: string;
  readonly container: string;
  readonly shell: string;
  readonly cols: number;
  readonly rows: number;
}

/** Frames the host writes into the open/attach stream, one JSON object per line. */
export type TerminalFrame =
  | {
    readonly type: "ready";
    readonly terminalId: string;
    readonly workspace: string;
    readonly container: string;
    readonly shell: string;
    readonly title: string;
    readonly attached: boolean;
  }
  | { readonly type: "snapshot"; readonly screen: string }
  | { readonly type: "data"; readonly data: string }
  | { readonly type: "title"; readonly title: string }
  | { readonly type: "exit"; readonly exitCode: number | null; readonly signal: string | null }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "detached" };

/** One control request against an open terminal. */
export type TerminalControl =
  | { readonly terminalId: string; readonly kind: "input"; readonly data: string }
  | {
    readonly terminalId: string;
    readonly kind: "resize";
    readonly cols: number;
    readonly rows: number;
  }
  | { readonly terminalId: string; readonly kind: "close" }
  | { readonly terminalId: string; readonly kind: "rename"; readonly title: string };
