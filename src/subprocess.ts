// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { discardUnneededSpill, outputReader, spillTargetFor, splitEnv } from "./output-reader.js";
import { globCwd, remoteArgv, unaryGuest } from "./guest-rpc.js";
import { metadata, type WorkspaceResolver } from "./workspace-binding.js";
import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";

export interface SubprocessProvider {
  resolveExecutable(command: string): Promise<string>;
  terminalEnvironment(signal?: AbortSignal): Promise<{
    platform: "posix";
    defaultShell: string;
  }>;
  spawn(spec: any): any;
  spawnTerminal(spec: any): Promise<any>;
  dispose(): void;
}

export function createSubprocessProvider(resolver: WorkspaceResolver): SubprocessProvider {
  // Live termination handles, so service disposal can stop every process this
  // provider started (the harness's disposal contract).
  const live = new Set<() => void>();
  return {
    dispose: () => {
      for (const terminate of [...live]) terminate();
    },
    // The harness's resolveExecutable carries no cwd, and this provider's
    // execution world is per-workspace (each workspace is its own container),
    // so a bare command name cannot be looked up here. An absolute path is
    // returned unchanged: the guest resolves and spawns it inside the target
    // container, which is the only place it can be checked. Shell selection
    // (see terminalEnvironment) depends on this for an environment-default
    // shell.
    resolveExecutable: async (command: string): Promise<string> => {
      if (typeof command === "string" && command.startsWith("/")) return command;
      throw new Error(
        `cannot resolve executable ${JSON.stringify(command)}: no workspace context is available`,
      );
    },
    // Shell selection happens before a workspace is chosen, so the provider
    // reports the family every container it starts belongs to. `/bin/sh` is the
    // portable default; a configured shell overrides it.
    terminalEnvironment: async (_signal?: AbortSignal) => ({
      platform: "posix" as const,
      defaultShell: "/bin/sh",
    }),
    spawn: (spec: any) => {
      // A pre-aborted spawn is rejected synchronously with a stable Error,
      // mirroring the local backend, rather than starting a process that would
      // be terminated immediately.
      if (spec.signal?.aborted) {
        let reason = "aborted";
        try {
          reason = String(spec.signal.reason ?? reason);
        } catch {
          // Arbitrary caller-owned reasons cannot escape the stable boundary.
        }
        throw new Error(`aborted before spawn: ${reason}`);
      }
      if (
        !Array.isArray(spec.argv) ||
        spec.argv.length === 0 ||
        typeof spec.argv[0] !== "string" ||
        spec.argv[0] === ""
      ) {
        throw new Error("argv must contain a program");
      }
      const stdoutSpill = spillTargetFor(spec.stdio?.stdout, "stdout");
      const stderrSpill = spillTargetFor(spec.stdio?.stderr, "stderr");
      const stdoutReader = outputReader(spec.stdio?.stdout, stdoutSpill.spec);
      const stderrReader = outputReader(spec.stdio?.stderr, stderrSpill.spec);
      const state = {
        pid: -1,
        stdin: undefined as any,
        stdout: spec.stdio?.stdout === "pipe" ? new PassThrough() : undefined,
        stderr: spec.stdio?.stderr === "pipe" ? new PassThrough() : undefined,
      };
      let processBinding: any;
      let terminated = false;
      let exited = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const signalProcess = (signal: string): void => {
        if (processBinding !== undefined && state.pid > 0) {
          void unaryGuest({ binding: processBinding }, "signal", {
            processId: String(state.pid),
            signal,
          }).catch(() => {});
        }
      };
      // The harness's termination procedure: SIGTERM, then SIGKILL once the
      // spec's grace period elapses without an exit.
      const terminate = (): void => {
        terminated = true;
        signalProcess("SIGTERM");
        if (killTimer === undefined) {
          const grace = typeof spec.graceMs === "number" && spec.graceMs > 0 ? spec.graceMs : 5000;
          killTimer = setTimeout(() => {
            if (!exited) signalProcess("SIGKILL");
          }, grace);
          killTimer.unref?.();
        }
      };
      let settled = false;
      // A piped consumer that falls behind applies backpressure: the guest
      // stream is paused until every outstanding drain (or close) has fired, so
      // a fast producer cannot grow a PassThrough without bound.
      let pendingDrains = 0;
      const applyBackpressure = (stream: any, target: PassThrough): void => {
        pendingDrains++;
        stream.pause?.();
        let released = false;
        const release = (): void => {
          if (released) return;
          released = true;
          target.removeListener("drain", release);
          target.removeListener("close", release);
          pendingDrains--;
          if (pendingDrains === 0) stream.resume?.();
        };
        target.once("drain", release);
        // A destroyed target never drains; its close must release the pause or
        // the exit message would stay stuck behind it.
        target.once("close", release);
      };
      const writeChunk = (
        stream: any,
        target: PassThrough | undefined,
        data: Buffer,
      ): void => {
        if (target === undefined) return;
        if (!target.write(data)) applyBackpressure(stream, target);
      };
      // A ripgrep discovery listing runs from its search root, so a pattern
      // containing "/" anchors to the path the harness passed; the workspace
      // binding still resolves from the caller's cwd.
      const runCwd = globCwd(spec.argv, spec.cwd) ?? spec.cwd;
      const done = resolver.resolve(spec.cwd).then(
        (binding) =>
          new Promise<any>((resolveDone, reject) => {
            processBinding = binding;
            const stream = (binding.guest as any).exec(metadata(binding.token));
            // finish settles the handle exactly once and tears it down however
            // the process ends: an exit message, a stream error, or a stream
            // that ends without one. The output pipes and spill files are
            // resolved on every path, so a failed exec leaves no half-open
            // handle, no hung reader, and no orphaned spill.
            const finish = (
              error: Error | undefined,
              exit?: { exitCode: number; signal: string | null },
            ): void => {
              if (settled) return;
              settled = true;
              exited = true;
              if (killTimer !== undefined) {
                clearTimeout(killTimer);
                killTimer = undefined;
              }
              // A pause applied for backpressure must not outlive the process,
              // or the exit/error message could stay stuck behind it.
              if (pendingDrains > 0) {
                pendingDrains = 0;
                stream.resume?.();
              }
              state.stdout?.end();
              state.stderr?.end();
              discardUnneededSpill(binding, stdoutReader);
              discardUnneededSpill(binding, stderrReader);
              if (error === undefined) resolveDone(exit);
              else reject(error);
            };
            stream.on("data", (output: any) => {
              if (output.stdoutChunk) {
                const data = Buffer.from(output.stdoutChunk);
                stdoutReader?.append(data);
                writeChunk(stream, state.stdout, data);
                if (spec.stdio?.stdout === "inherit") process.stdout.write(data);
              }
              if (output.processId) {
                state.pid = Number(output.processId);
                if (terminated) terminate();
              }
              if (output.stderrChunk) {
                const data = Buffer.from(output.stderrChunk);
                stderrReader?.append(data);
                writeChunk(stream, state.stderr, data);
                if (spec.stdio?.stderr === "inherit") process.stderr.write(data);
              }
              if (output.exit) {
                stdoutReader?.setSpillValid(
                  Boolean(output.exit.stdoutSpillValid),
                );
                stderrReader?.setSpillValid(
                  Boolean(output.exit.stderrSpillValid),
                );
                finish(undefined, {
                  exitCode: output.exit.exitCode,
                  signal: output.exit.signaled ? output.exit.signal : null,
                });
              }
            });
            stream.on("error", (error: unknown) => {
              // The guest connection failed: stop the process if it is still
              // reachable, then release the caller instead of leaving it
              // pending on a stream that will never carry an exit message.
              terminate();
              finish(error instanceof Error ? error : new Error(String(error)));
            });
            stream.on("end", () => {
              // A stream that ends without an exit message (guest restart,
              // dropped socket) must not leave the caller pending forever.
              if (settled) return;
              terminate();
              finish(new Error("exec stream ended before the process exited"));
            });
            const env = splitEnv(spec.env);
            stream.write({
              start: {
                argv: remoteArgv(spec.argv),
                cwd: runCwd,
                env: env.env,
                unsetEnv: env.unsetEnv,
                // A caller that will not send stdin leaves the child on
                // /dev/null: a pipe would be a non-TTY stdin, and tools like
                // ripgrep then read stdin instead of the working directory.
                stdinPipe: spec.stdio?.stdin === "pipe",
                ...(stdoutSpill.target !== undefined ? { spillStdout: stdoutSpill.target } : {}),
                ...(stderrSpill.target !== undefined ? { spillStderr: stderrSpill.target } : {}),
              },
            });
            if (spec.stdio?.stdin !== "pipe") stream.end();
            else {
              state.stdin = new PassThrough();
              state.stdin.on("data", (data: Buffer) => stream.write({ stdinChunk: data }));
              state.stdin.on("end", () => stream.end());
            }
          }),
      );
      if (spec.signal !== undefined) {
        if (spec.signal.aborted) terminate();
        else spec.signal.addEventListener("abort", terminate, { once: true });
      }
      live.add(terminate);
      void done.finally(() => live.delete(terminate)).catch(() => {});
      return {
        ...state,
        // The harness's SubprocessHandle declares a control channel; this
        // provider runs every process over gRPC, so none exists.
        control: undefined,
        collected: {
          ...(stdoutReader === undefined ? {} : { stdout: stdoutReader }),
          ...(stderrReader === undefined ? {} : { stderr: stderrReader }),
        },
        done,
        terminate,
        // Mirror the local backend's `waitWithAbort`: a pre-aborted or
        // aborting signal returns false instead of waiting for the managed
        // range, while a provider failure still propagates.
        waitForExit: (signal?: AbortSignal) => {
          if (signal?.aborted) {
            void done.catch(() => {});
            return Promise.resolve(false);
          }
          if (signal === undefined) return done.then(() => true);
          return new Promise<boolean>((resolve, reject) => {
            const onAbort = (): void => resolve(false);
            signal.addEventListener("abort", onAbort, { once: true });
            done.then(
              () => {
                signal.removeEventListener("abort", onAbort);
                resolve(true);
              },
              (error) => {
                signal.removeEventListener("abort", onAbort);
                reject(error);
              },
            );
          });
        },
      };
    },

    spawnTerminal: async (spec: any) => {
      if (
        !Array.isArray(spec.argv) ||
        spec.argv.length === 0 ||
        typeof spec.argv[0] !== "string" ||
        spec.argv[0] === ""
      ) {
        throw new Error("argv must contain a program");
      }
      spec.signal?.throwIfAborted();
      const binding = await resolver.resolveForPath(spec.cwd, spec.cwd);
      const call = (binding.guest as any).terminal(metadata(binding.token));

      const output = new PassThrough();
      let exited = false;
      let terminated = false;
      // Bumped whenever this handle observes input, output, a size change or a
      // foreground observation, so a retention policy can tell an actively used
      // terminal from a quiet one. Shell idleness itself stays unknown: the
      // guest cannot prove a prompt is waiting for input.
      let activityRevision = 0;
      let resolveExit!: (outcome: {
        exitCode: number | null;
        signal: string | null;
      }) => void;
      let rejectExit!: (error: unknown) => void;
      const done = new Promise<{
        exitCode: number | null;
        signal: string | null;
      }>((resolveDone, rejectDone) => {
        resolveExit = resolveDone;
        rejectExit = rejectDone;
      });
      // A caller that never receives the handle (startup failure) must not
      // leave `done` as an unhandled rejection.
      done.catch(() => {});

      let resolveStarted!: (pid: number) => void;
      let rejectStarted!: (error: unknown) => void;
      const started = new Promise<number>((resolvePid, rejectPid) => {
        resolveStarted = resolvePid;
        rejectStarted = rejectPid;
      });

      const pending = new Map<
        string,
        { resolve: (message: any) => void; reject: (error: unknown) => void }
      >();
      const failPending = (error: unknown): void => {
        for (const waiter of pending.values()) waiter.reject(error);
        pending.clear();
      };

      call.on("data", (message: any) => {
        if (message.started) {
          resolveStarted(Number(message.started.pid));
          return;
        }
        if (message.stdoutChunk) {
          activityRevision++;
          output.write(Buffer.from(message.stdoutChunk));
          return;
        }
        if (message.exit) {
          exited = true;
          output.end();
          resolveExit({
            exitCode: message.exit.exitCode,
            signal: message.exit.signaled ? message.exit.signal : null,
          });
          return;
        }
        if (message.foreground) {
          activityRevision++;
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
        rejectStarted(error);
        if (!exited) {
          exited = true;
          output.end();
          rejectExit(error);
        }
        failPending(error);
      });
      call.on("end", () => {
        if (exited) return;
        const error = new Error("terminal stream ended before the process exited");
        rejectStarted(error);
        exited = true;
        output.end();
        rejectExit(error);
        failPending(error);
      });

      // The spawn spec advertises the terminal emulation the child should see;
      // it becomes TERM unless the caller already set one.
      const terminalEnv = { ...(spec.env ?? {}) };
      if (
        typeof spec.terminalType === "string" && spec.terminalType !== "" &&
        terminalEnv.TERM === undefined
      ) {
        terminalEnv.TERM = spec.terminalType;
      }
      call.write({
        start: {
          argv: remoteArgv(spec.argv),
          cwd: spec.cwd,
          env: terminalEnv,
          rows: spec.rows,
          cols: spec.cols,
        },
      });
      const pid = await started;

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

      const handle = {
        pid,
        output,
        done,
        write: async (data: string) => {
          if (exited) throw new Error("terminal has exited");
          activityRevision++;
          call.write({ stdinChunk: Buffer.from(data) });
        },
        resize: async (cols: number, rows: number) => {
          if (exited) throw new Error("terminal has exited");
          activityRevision++;
          call.write({ resize: { rows, cols } });
        },
        inspectActivity: async () => ({
          state: "unknown" as const,
          revision: activityRevision,
        }),
        inspectForeground: async () => {
          if (exited) return undefined;
          const response = await request((requestId) => ({
            inspectRequestId: requestId,
          }));
          return response.found
            ? {
              processGroupId: response.processGroupId,
              inputWaiting: response.inputWaiting,
            }
            : undefined;
        },
        signalForeground: async (signal: string) => {
          if (exited) throw new Error("terminal has exited");
          const response = await request((requestId) => ({
            signal: { signal, requestId },
          }));
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
          if (!output.writableEnded) output.end();
        },
      };

      const onAbort = (): void => {
        void handle.terminate();
      };
      if (spec.signal !== undefined) {
        if (spec.signal.aborted) onAbort();
        else spec.signal.addEventListener("abort", onAbort, { once: true });
      }
      // Register the terminal with the provider's live handles, so disposing
      // the service stops a terminal the caller never closed. Termination is
      // idempotent and never rejects.
      const stop = (): void => {
        try {
          void handle.terminate();
        } catch {
          // Terminal teardown is best-effort.
        }
      };
      live.add(stop);
      void done.finally(() => live.delete(stop)).catch(() => {});

      return handle;
    },
  };
}

export { OutputReader, outputReader } from "./output-reader.js";
