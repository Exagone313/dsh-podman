// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// One interactive guest-terminal stream. The harness's subprocess provider and
// the browser terminal routes both build on this: the guest owns the pty and
// reports started/stdout/exit plus foreground queries, so the terminal protocol
// is spoken in exactly one place.

import { remoteArgv } from "./guest-rpc.js";
import { metadata, type WorkspaceBinding } from "./workspace-binding.js";
import { randomUUID } from "node:crypto";

export interface GuestTerminalOptions {
  argv: readonly string[];
  cwd: string;
  env?: Readonly<Record<string, string>>;
  cols: number;
  rows: number;
  // Terminal emulation the child should see; becomes TERM unless env sets one.
  terminalType?: string;
}

export interface GuestTerminalExit {
  exitCode: number | null;
  signal: string | null;
}

export interface GuestTerminal {
  // The guest pid once `started` resolves; -1 before that.
  readonly pid: number;
  readonly started: Promise<number>;
  readonly done: Promise<GuestTerminalExit>;
  exited(): boolean;
  // Observed input/output/resize/foreground activity, for retention policies.
  activityRevision(): number;
  onOutput(listener: (chunk: Buffer) => void): () => void;
  write(data: Buffer | string): void;
  resize(cols: number, rows: number): void;
  inspectForeground(): Promise<
    { processGroupId: number; inputWaiting: boolean } | undefined
  >;
  signalForeground(signal: string): Promise<number>;
  // Close the guest terminal; idempotent and never rejects.
  terminate(): Promise<void>;
}

export function openGuestTerminal(
  binding: WorkspaceBinding,
  options: GuestTerminalOptions,
): GuestTerminal {
  const call = (binding.guest as any).terminal(metadata(binding.token));
  const listeners = new Set<(chunk: Buffer) => void>();
  const pending = new Map<
    string,
    { resolve: (message: any) => void; reject: (error: unknown) => void }
  >();
  let pid = -1;
  let exited = false;
  let terminated = false;
  let activity = 0;

  let resolveStarted!: (pid: number) => void;
  let rejectStarted!: (error: unknown) => void;
  const started = new Promise<number>((resolveStartedPromise, rejectStartedPromise) => {
    resolveStarted = resolveStartedPromise;
    rejectStarted = rejectStartedPromise;
  });
  // A caller that never awaits startup must not crash on an unhandled rejection.
  started.catch(() => {});

  let resolveExit!: (outcome: GuestTerminalExit) => void;
  let rejectExit!: (error: unknown) => void;
  const done = new Promise<GuestTerminalExit>((resolveExitPromise, rejectExitPromise) => {
    resolveExit = resolveExitPromise;
    rejectExit = rejectExitPromise;
  });
  done.catch(() => {});

  const failPending = (error: unknown): void => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };

  // Settle the stream exactly once, however it ends: an exit message, a stream
  // error, or a stream that ends without one. Every path also releases pending
  // foreground queries so a caller cannot hang on them.
  const settle = (error: Error | undefined, outcome?: GuestTerminalExit): void => {
    if (exited) return;
    exited = true;
    if (error !== undefined) {
      rejectStarted(error);
      rejectExit(error);
      failPending(error);
      return;
    }
    if (outcome !== undefined) resolveExit(outcome);
    failPending(new Error("terminal has exited"));
  };

  call.on("data", (message: any) => {
    if (message.started) {
      pid = Number(message.started.pid);
      resolveStarted(pid);
      return;
    }
    if (message.stdoutChunk) {
      activity++;
      const chunk = Buffer.from(message.stdoutChunk);
      for (const listener of listeners) listener(chunk);
      return;
    }
    if (message.exit) {
      settle(undefined, {
        exitCode: message.exit.exitCode,
        signal: message.exit.signaled ? message.exit.signal : null,
      });
      return;
    }
    if (message.foreground) {
      activity++;
      const waiter = pending.get(message.foreground.requestId);
      if (waiter !== undefined) {
        pending.delete(message.foreground.requestId);
        waiter.resolve(message.foreground);
      }
      return;
    }
    if (message.signalled) {
      const waiter = pending.get(message.signalled.requestId);
      if (waiter !== undefined) {
        pending.delete(message.signalled.requestId);
        waiter.resolve(message.signalled);
      }
    }
  });
  call.on("error", (error: unknown) => {
    settle(error instanceof Error ? error : new Error(String(error)));
  });
  call.on("end", () => {
    settle(new Error("terminal stream ended before the process exited"));
  });

  const env: Record<string, string> = { ...(options.env ?? {}) };
  if (
    options.terminalType !== undefined &&
    options.terminalType !== "" &&
    env.TERM === undefined
  ) {
    env.TERM = options.terminalType;
  }
  call.write({
    start: {
      argv: remoteArgv(options.argv),
      cwd: options.cwd,
      env,
      rows: options.rows,
      cols: options.cols,
    },
  });

  const request = (message: (requestId: string) => any): Promise<any> => {
    const requestId = randomUUID();
    return new Promise<any>((resolveWaiter, rejectWaiter) => {
      pending.set(requestId, { resolve: resolveWaiter, reject: rejectWaiter });
      try {
        call.write(message(requestId));
      } catch (error) {
        pending.delete(requestId);
        rejectWaiter(error);
      }
    });
  };

  return {
    get pid() {
      return pid;
    },
    started,
    done,
    exited: () => exited,
    activityRevision: () => activity,
    onOutput: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    write: (data) => {
      if (exited) throw new Error("terminal has exited");
      activity++;
      call.write({ stdinChunk: Buffer.from(data) });
    },
    resize: (cols, rows) => {
      if (exited) throw new Error("terminal has exited");
      activity++;
      call.write({ resize: { rows, cols } });
    },
    inspectForeground: async () => {
      if (exited) return undefined;
      const response = await request((requestId) => ({ inspectRequestId: requestId }));
      return response.found
        ? { processGroupId: response.processGroupId, inputWaiting: response.inputWaiting }
        : undefined;
    },
    signalForeground: async (signal) => {
      if (exited) throw new Error("terminal has exited");
      const response = await request((requestId) => ({ signal: { signal, requestId } }));
      if (!response.found) {
        throw new Error(`no foreground process group to signal ${signal}`);
      }
      return response.processGroupId;
    },
    terminate: async () => {
      if (terminated) return;
      terminated = true;
      try {
        call.write({ close: true });
        call.end();
      } catch {
        // A finished call cannot be closed again; nothing to do.
      }
      try {
        await done;
      } catch {
        // Termination is idempotent and never rejects.
      }
    },
  };
}
