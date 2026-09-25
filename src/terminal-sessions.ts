// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// Live and retained Podman terminals. One guest pty per (session, tab), kept
// alive while the browser is away and replayed from a headless emulator screen
// on reattach, so reloading the page does not lose the shell or its scrollback.

import { type GuestTerminal, openGuestTerminal } from "./guest-terminal.js";
import { requireShell } from "./terminal-shells.js";
import {
  type TerminalControl,
  type TerminalFrame,
  type TerminalRetainedView,
} from "./client/terminal-protocol.js";
import { type WorkspaceResolver } from "./workspace-binding.js";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { type Terminal as HeadlessTerminal } from "@xterm/headless";
import { type SerializeAddon as Serializer } from "@xterm/addon-serialize";

// Both xterm packages are CommonJS: a default ESM import of their named exports
// fails under Node's interop rules, so they are required with their own types.
const require = createRequire(import.meta.url);
const { Terminal } = require("@xterm/headless") as typeof import("@xterm/headless");
const { SerializeAddon } = require(
  "@xterm/addon-serialize",
) as typeof import("@xterm/addon-serialize");

// The harness's own browser terminals keep an idle shell for this long.
export const TERMINAL_RETENTION_MS = 7_200_000;
const DEFAULT_SCROLLBACK = 1000;
const REAP_INTERVAL_MS = 60_000;

export interface TerminalOpenOptions {
  sessionId: string;
  tabId: string;
  workspace: string;
  cwd: string;
  container: string;
  shell: string;
  cols: number;
  rows: number;
  // Drop whatever was retained for this tab and start a fresh shell.
  reopen?: boolean;
  signal?: AbortSignal;
}

export interface TerminalPrepared {
  terminalId: string;
  workspace: string;
  container: string;
  shell: string;
  title: string;
  attached: boolean;
  snapshot?: string;
}

interface TerminalEntry {
  readonly key: string;
  readonly terminalId: string;
  readonly sessionId: string;
  readonly tabId: string;
  readonly workspace: string;
  readonly container: string;
  readonly shell: string;
  title: string;
  readonly terminal: GuestTerminal;
  readonly screen: HeadlessTerminal;
  readonly serializer: Serializer;
  lastUsed: number;
  listener: ((frame: TerminalFrame) => void) | undefined;
  exit?: { exitCode: number | null; signal: string | null };
  failure?: string;
}

export interface TerminalSessionsOptions {
  resolver: WorkspaceResolver;
  scrollback?: number;
  retentionMs?: number;
}

export class TerminalSessions {
  private readonly entries = new Map<string, TerminalEntry>();
  private readonly byId = new Map<string, TerminalEntry>();
  private readonly scrollback: number;
  private readonly retentionMs: number;
  private readonly sweep: ReturnType<typeof setInterval>;

  constructor(private readonly options: TerminalSessionsOptions) {
    this.scrollback = options.scrollback ?? DEFAULT_SCROLLBACK;
    this.retentionMs = options.retentionMs ?? TERMINAL_RETENTION_MS;
    this.sweep = setInterval(() => this.reap(), REAP_INTERVAL_MS);
    this.sweep.unref?.();
  }

  /**
   * Validate a request and make sure its terminal exists.
   * @param options - session/tab identity, target container and shell, dimensions.
   * @returns the terminal identity and, when reattaching, its serialized screen.
   */
  async prepare(options: TerminalOpenOptions): Promise<TerminalPrepared> {
    const key = `${options.sessionId}\n${options.tabId}`;
    if (options.reopen === true) this.drop(key);
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      existing.lastUsed = Date.now();
      return {
        terminalId: existing.terminalId,
        workspace: existing.workspace,
        container: existing.container,
        shell: existing.shell,
        title: existing.title,
        attached: true,
        snapshot: existing.serializer.serialize(),
      };
    }
    const binding = options.container === "" || options.container === "default"
      ? await this.options.resolver.resolveForPath(options.cwd, options.cwd, options.signal)
      : await this.options.resolver.containerBinding(
        options.cwd,
        options.container,
        options.signal,
      );
    const shell = await requireShell(binding, options.cwd, options.shell, options.signal);
    const terminal = openGuestTerminal(binding, {
      argv: [shell.path, "-i"],
      cwd: options.cwd,
      cols: options.cols,
      rows: options.rows,
      terminalType: "xterm-256color",
    });
    const screen = new Terminal({
      cols: options.cols,
      rows: options.rows,
      scrollback: this.scrollback,
      allowProposedApi: true,
    });
    const serializer = new SerializeAddon();
    screen.loadAddon(serializer);
    const entry: TerminalEntry = {
      key,
      terminalId: randomUUID(),
      sessionId: options.sessionId,
      tabId: options.tabId,
      workspace: options.workspace,
      container: options.container,
      shell: shell.path,
      title: shell.name,
      terminal,
      screen,
      serializer,
      lastUsed: Date.now(),
      listener: undefined,
    };
    terminal.onOutput((chunk) => {
      entry.screen.write(chunk);
      entry.listener?.({ type: "data", data: Buffer.from(chunk).toString("base64") });
    });
    void terminal.done.then(
      (outcome) => {
        entry.exit = outcome;
        entry.listener?.({ type: "exit", exitCode: outcome.exitCode, signal: outcome.signal });
      },
      (error) => {
        entry.failure = error instanceof Error ? error.message : String(error);
        entry.listener?.({ type: "error", message: entry.failure });
      },
    );
    try {
      // Surface a startup failure before publishing the entry.
      await terminal.started;
    } catch (error) {
      void terminal.terminate();
      throw error;
    }
    this.entries.set(key, entry);
    this.byId.set(entry.terminalId, entry);
    return {
      terminalId: entry.terminalId,
      workspace: entry.workspace,
      container: entry.container,
      shell: entry.shell,
      title: entry.title,
      attached: false,
    };
  }

  /**
   * Attach one browser stream as the terminal's input owner.
   * @param terminalId - a prepared terminal.
   * @param write - frame sink for this attachment.
   * @param signal - the request lifetime; aborting detaches without closing.
   * @param snapshot - serialized screen to replay before live output.
   * @returns a detach function, idempotent and safe after the entry is gone.
   */
  listen(
    terminalId: string,
    write: (frame: TerminalFrame) => void,
    signal: AbortSignal,
    snapshot?: string,
  ): () => void {
    const entry = this.byId.get(terminalId);
    if (entry === undefined) return () => {};
    // A newer attachment takes over: the previous one is told it is detached.
    entry.listener?.({ type: "detached" });
    entry.listener = write;
    entry.lastUsed = Date.now();
    write({
      type: "ready",
      terminalId,
      workspace: entry.workspace,
      container: entry.container,
      shell: entry.shell,
      title: entry.title,
      attached: snapshot !== undefined,
    });
    if (snapshot !== undefined) write({ type: "snapshot", screen: snapshot });
    if (entry.exit !== undefined) {
      write({ type: "exit", exitCode: entry.exit.exitCode, signal: entry.exit.signal });
    } else if (entry.failure !== undefined) {
      write({ type: "error", message: entry.failure });
    }
    const detach = (): void => {
      if (entry.listener === write) entry.listener = undefined;
    };
    signal.addEventListener("abort", detach, { once: true });
    return detach;
  }

  /**
   * Apply one control request.
   * @param control - input, resize, rename, or close.
   * @returns whether the terminal was found.
   */
  control(control: TerminalControl): boolean {
    const entry = this.byId.get(control.terminalId);
    if (entry === undefined) return false;
    entry.lastUsed = Date.now();
    switch (control.kind) {
      case "input": {
        if (!entry.terminal.exited()) {
          entry.terminal.write(Buffer.from(control.data, "base64"));
        }
        return true;
      }
      case "resize": {
        if (!entry.terminal.exited()) {
          entry.terminal.resize(control.cols, control.rows);
          entry.screen.resize(control.cols, control.rows);
        }
        return true;
      }
      case "rename": {
        entry.title = control.title;
        entry.listener?.({ type: "title", title: control.title });
        return true;
      }
      case "close": {
        this.drop(entry.key);
        void entry.terminal.terminate();
        return true;
      }
    }
  }

  /**
   * List the terminals one session still holds.
   * @param sessionId - the owning session.
   * @returns retained terminal metadata, oldest first.
   */
  retained(sessionId: string): TerminalRetainedView[] {
    return [...this.entries.values()]
      .filter((entry) => entry.sessionId === sessionId)
      .map((entry) => ({
        tabId: entry.tabId,
        terminalId: entry.terminalId,
        title: entry.title,
        workspace: entry.workspace,
        container: entry.container,
        shell: entry.shell,
      }));
  }

  /** Close every terminal and stop the retention sweep. */
  dispose(): void {
    clearInterval(this.sweep);
    for (const entry of [...this.entries.values()]) {
      this.entries.delete(entry.key);
      this.byId.delete(entry.terminalId);
      void entry.terminal.terminate();
    }
  }

  // drop removes one entry from both indexes without terminating it; the caller
  // owns termination so a replace never races the old shell's teardown.
  private drop(key: string): void {
    const entry = this.entries.get(key);
    if (entry === undefined) return;
    this.entries.delete(key);
    this.byId.delete(entry.terminalId);
  }

  // reap closes terminals no browser has attached for the retention window.
  private reap(): void {
    const cutoff = Date.now() - this.retentionMs;
    for (const entry of [...this.entries.values()]) {
      if (entry.listener === undefined && entry.lastUsed < cutoff) {
        this.drop(entry.key);
        void entry.terminal.terminate();
      }
    }
  }
}
