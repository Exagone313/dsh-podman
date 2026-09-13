// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { discardUnneededSpill, outputReader, spillTargetFor, splitEnv } from "./output-reader.js";
import { remoteArgv, unaryGuest } from "./guest-rpc.js";
import { type WorkspaceResolver, metadata } from "./workspace-binding.js";
import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";

export interface SubprocessProvider {
  resolveExecutable(command: string): Promise<string>;
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
    // so there is no context in which an executable can be verified or looked
    // up. Report every request as unresolvable instead of returning an
    // unverified path.
    resolveExecutable: async (command: string): Promise<string> => {
      throw new Error(
        `cannot resolve executable ${JSON.stringify(command)}: no workspace context is available`,
      );
    },
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
      )
        throw new Error("argv must contain a program");
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
          const grace =
            typeof spec.graceMs === "number" && spec.graceMs > 0
              ? spec.graceMs
              : 5000;
          killTimer = setTimeout(() => {
            if (!exited) signalProcess("SIGKILL");
          }, grace);
          killTimer.unref?.();
        }
      };
      const done = resolver.resolve(spec.cwd).then(
        (binding) =>
          new Promise<any>((resolveDone, reject) => {
            processBinding = binding;
            const stream = (binding.guest as any).exec(metadata(binding.token));
            stream.on("data", (output: any) => {
              if (output.stdoutChunk) {
                const data = Buffer.from(output.stdoutChunk);
                stdoutReader?.append(data);
                state.stdout?.write(data);
                if (spec.stdio?.stdout === "inherit") process.stdout.write(data);
              }
              if (output.processId) {
                state.pid = Number(output.processId);
                if (terminated) terminate();
              }
              if (output.stderrChunk) {
                const data = Buffer.from(output.stderrChunk);
                stderrReader?.append(data);
                state.stderr?.write(data);
                if (spec.stdio?.stderr === "inherit") process.stderr.write(data);
              }
              if (output.exit) {
                exited = true;
                if (killTimer !== undefined) clearTimeout(killTimer);
                stdoutReader?.setSpillValid(
                  Boolean(output.exit.stdoutSpillValid),
                );
                stderrReader?.setSpillValid(
                  Boolean(output.exit.stderrSpillValid),
                );
                state.stdout?.end();
                state.stderr?.end();
                discardUnneededSpill(binding, stdoutReader);
                discardUnneededSpill(binding, stderrReader);
                resolveDone({
                  exitCode: output.exit.exitCode,
                  signal: output.exit.signaled ? output.exit.signal : null,
                });
              }
            });
            stream.on("error", reject);
            const env = splitEnv(spec.env);
            stream.write({
              start: {
                argv: remoteArgv(spec.argv),
                cwd: spec.cwd,
                env: env.env,
                unsetEnv: env.unsetEnv,
                ...(stdoutSpill.target !== undefined
                  ? { spillStdout: stdoutSpill.target }
                  : {}),
                ...(stderrSpill.target !== undefined
                  ? { spillStderr: stderrSpill.target }
                  : {}),
              },
            });
            if (spec.stdio?.stdin !== "pipe") stream.end();
            else {
              state.stdin = new PassThrough();
              state.stdin.on("data", (data: Buffer) =>
                stream.write({ stdinChunk: data }),
              );
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
      )
        throw new Error("argv must contain a program");
      spec.signal?.throwIfAborted();
      const binding = await resolver.resolveForPath(spec.cwd, spec.cwd);
      const call = (binding.guest as any).terminal(metadata(binding.token));

      const output = new PassThrough();
      let exited = false;
      let terminated = false;
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

      call.write({
        start: {
          argv: remoteArgv(spec.argv),
          cwd: spec.cwd,
          env: spec.env ?? {},
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
          call.write({ stdinChunk: Buffer.from(data) });
        },
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
          if (!response.found)
            throw new Error(`no foreground process group to signal ${signal}`);
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

      return handle;
    },
  };
}

export { OutputReader, outputReader } from "./output-reader.js";
