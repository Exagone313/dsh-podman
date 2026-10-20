// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import {
  discardUnneededSpill,
  outputReader,
  spillTargetFor,
  splitEnv,
} from "./output-reader.js";
import { openGuestTerminal } from "./guest-terminal.js";
import { globCwd, remoteArgv, unaryGuest } from "./guest-rpc.js";
import {
  metadata,
  PTC_CONTAINER,
  type WorkspaceResolver,
} from "./workspace-binding.js";
import { Duplex, PassThrough } from "node:stream";
import { SubprocessExecutableNotFoundError } from "@deepseek-ai/dsh-subprocess";

// The scratch directory a PTC child runs from. The PTC container has no
// project mount, so the harness's cwd (a workspace path) does not exist there;
// its /tmp is the one writable place it can start in.
const PTC_SCRATCH_CWD = "/tmp";

// The bounded range of numeric uids a PTC child may run as. Each concurrent
// control spawn gets its own id because the guest creates a per-uid home under
// /tmp/dsh-podman-home/<uid>; the ids stay outside the container's usual
// service and dynamic ranges.
const PTC_UID_MIN = 1001;
const PTC_UID_MAX = 10000;

// PtcUidPool hands out one numeric identity per running control spawn. It is
// bounded on purpose: running out is an explicit failure, never a fallback to a
// shared or privileged identity.
class PtcUidPool {
  private readonly inUse = new Set<number>();
  // allocate returns the lowest free id, so a released one is reused before a
  // fresh one, which keeps the pool compact under normal churn.
  allocate(): number {
    for (let id = PTC_UID_MIN; id <= PTC_UID_MAX; id++) {
      if (this.inUse.has(id)) continue;
      this.inUse.add(id);
      return id;
    }
    throw new Error(
      `cannot start a PTC child: no free uid in ${PTC_UID_MIN}-${PTC_UID_MAX}`,
    );
  }
  release(id: number): void {
    this.inUse.delete(id);
  }
}

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

export function createSubprocessProvider(
  resolver: WorkspaceResolver,
): SubprocessProvider {
  // Live termination handles, so service disposal can stop every process this
  // provider started (the harness's disposal contract).
  const live = new Set<() => void>();
  // The numeric identities the running control spawns hold, one per child.
  const ptcUids = new PtcUidPool();
  // Whether a guest agent implements the ExecControl transport, probed once
  // per agent. An older agent answers UNIMPLEMENTED (or has no such method),
  // and the probe then reports no support so spawn falls back to the previous
  // behaviour.
  const controlSupport = new Map<string, Promise<boolean>>();
  const supportsControl = (binding: any): Promise<boolean> => {
    const key = String(binding.socket ?? binding.token ?? "");
    let probe = controlSupport.get(key);
    if (probe === undefined) {
      probe = unaryGuest({ binding }, "getCapabilities", {}).then(
        (result: any) => result?.execControl === true,
        () => {
          // An older agent does not implement the probe. Do not cache the
          // failure: a recreated agent may answer next time.
          controlSupport.delete(key);
          return false;
        },
      );
      controlSupport.set(key, probe);
    }
    return probe;
  };
  return {
    dispose: () => {
      for (const terminate of Array.from(live)) terminate();
      controlSupport.clear();
    },
    // The harness's resolveExecutable carries no cwd, and this provider's
    // execution world is per-workspace (each workspace is its own container),
    // so a bare command name cannot be looked up here. An absolute path is
    // returned unchanged: the guest resolves and spawns it inside the target
    // container, which is the only place it can be checked. A bare name is
    // reported in the harness's "not found" form, so shell discovery skips a
    // candidate the images do not carry instead of failing the whole list.
    resolveExecutable: async (command: string): Promise<string> => {
      if (typeof command === "string" && command.startsWith("/")) {
        return command;
      }
      throw new SubprocessExecutableNotFoundError(
        `cannot resolve executable ${
          JSON.stringify(command)
        }: no workspace context is available`,
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
      // The control duplex is created synchronously because the harness reads
      // `handle.control` immediately after spawn, while the guest's capability
      // is only known once the binding resolves. A guest without ExecControl
      // clears it again before the exec starts, which leaves the runtime with
      // its normal missing-control error.
      const wantsControl = spec.stdio?.control === "pipe";
      // A control spawn is a PTC child, so it is assigned a private numeric
      // identity for its whole run. A non-control spawn keeps the caller's own
      // identity and never touches the pool.
      const ptcUid = wantsControl ? ptcUids.allocate() : undefined;
      const controlIn = wantsControl ? new PassThrough() : undefined;
      const controlOut = wantsControl ? new PassThrough() : undefined;
      let control = controlIn !== undefined && controlOut !== undefined
        // @types/node omits the documented { writable, readable } overload.
        ? Duplex.from({ writable: controlOut, readable: controlIn } as any)
        : undefined;
      // The provider destroys this duplex on fallback and on exec exit.
      // Duplexify reports that teardown as an AbortError, which would crash
      // the host when no caller listener is attached; the caller's own
      // listeners still observe transport failures.
      control?.on("error", () => {});
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
          const grace = typeof spec.graceMs === "number" && spec.graceMs > 0
            ? spec.graceMs
            : 5000;
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
      //
      // A control spawn is a PTC child: the harness runs its programmatic
      // tool-calling runtime there, with the fd-7 channel it requested. The PTC
      // container is separate from the workspace container and has no project
      // mount, so the child starts in its scratch /tmp rather than the caller's
      // workspace cwd. Every other spawn keeps today's binding and cwd.
      const runCwd = wantsControl
        ? PTC_SCRATCH_CWD
        : globCwd(spec.argv, spec.cwd) ?? spec.cwd;
      const resolved = wantsControl
        ? resolver.ptcBinding().catch((error: unknown) => {
          const detail = error instanceof Error ? error.message : String(error);
          // There is deliberately no fallback to the workspace container: a
          // PTC child that cannot run in the PTC container must fail instead of
          // executing with the wrong filesystem, mounts, and credentials.
          throw new Error(
            `cannot obtain the shared PTC container ${
              JSON.stringify(PTC_CONTAINER)
            } for this control spawn: ${detail}`,
          );
        })
        : resolver.resolve(spec.cwd);
      const done = resolved.then(
        async (binding) => {
          processBinding = binding;
          const withControl = wantsControl &&
            await supportsControl(binding);
          if (wantsControl && !withControl) {
            control?.destroy();
            control = undefined;
          }
          return new Promise<any>((resolveDone, reject) => {
            // One control call per exec. It is opened only after the guest
            // reports the process id, because its first frame names the exec.
            let controlCall: any;
            let controlClosed = false;
            const closeControl = (): void => {
              if (controlClosed) return;
              controlClosed = true;
              try {
                controlCall?.cancel?.();
              } catch {
                // A finished call cannot be cancelled again.
              }
            };
            const openControl = (execId: string): void => {
              if (!withControl || controlCall !== undefined) return;
              controlCall = (binding.guest as any).execControl(
                metadata(binding.token),
              );
              controlCall.on("data", (frame: any) => {
                const data = frame?.data;
                if (data !== undefined && data.length > 0) {
                  controlIn?.write(Buffer.from(data));
                }
              });
              controlCall.on("error", (error: unknown) => {
                // The transport is gone; fail the caller's channel rather than
                // leaving it open with no way to deliver frames.
                controlIn?.destroy(
                  error instanceof Error ? error : new Error(String(error)),
                );
              });
              controlCall.on("end", () => controlIn?.end());
              controlOut?.on("data", (data: Buffer) => {
                if (controlClosed) return;
                try {
                  controlCall.write({ data });
                } catch {
                  closeControl();
                }
              });
              controlOut?.on("end", () => {
                if (!controlClosed) controlCall.end();
              });
              controlOut?.on("close", closeControl);
              controlCall.write({ execId });
            };
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
              control?.destroy();
              closeControl();
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
                if (spec.stdio?.stdout === "inherit") {
                  process.stdout.write(data);
                }
              }
              if (output.processId) {
                state.pid = Number(output.processId);
                openControl(String(output.processId));
                if (terminated) terminate();
              }
              if (output.stderrChunk) {
                const data = Buffer.from(output.stderrChunk);
                stderrReader?.append(data);
                writeChunk(stream, state.stderr, data);
                if (spec.stdio?.stderr === "inherit") {
                  process.stderr.write(data);
                }
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
            if (withControl) env.env.DSH_SUBPROCESS_CONTROL = "pipe";
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
                ...(withControl ? { control: true } : {}),
                // The PTC child runs as its own numeric uid/gid; it inherits no
                // supplementary groups from the agent.
                ...(ptcUid !== undefined
                  ? { uid: { value: ptcUid }, gid: { value: ptcUid } }
                  : {}),
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
              state.stdin.on(
                "data",
                (data: Buffer) => stream.write({ stdinChunk: data }),
              );
              state.stdin.on("end", () => stream.end());
            }
          });
        },
      );
      if (spec.signal !== undefined) {
        if (spec.signal.aborted) terminate();
        else spec.signal.addEventListener("abort", terminate, { once: true });
      }
      live.add(terminate);
      void done.catch(() => control?.destroy());
      void done.finally(() => live.delete(terminate)).catch(() => {});
      // The child's identity is free again once its exec settles, however it
      // ended (an exit, a stream failure, or a failed binding).
      if (ptcUid !== undefined) {
        void done.finally(() => ptcUids.release(ptcUid)).catch(() => {});
      }
      return {
        ...state,
        // The control channel is present only when the caller requested it and
        // the guest implements ExecControl; a guest without the feature clears
        // it before the exec starts.
        get control() {
          return control;
        },
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
      const terminal = openGuestTerminal(binding, {
        argv: spec.argv,
        cwd: spec.cwd,
        env: spec.env,
        cols: spec.cols,
        rows: spec.rows,
        terminalType: spec.terminalType,
      });
      const output = new PassThrough();
      terminal.onOutput((chunk) => output.write(chunk));
      // Startup failure rejects here, before the caller receives a handle.
      const pid = await terminal.started;
      const done = terminal.done;
      // The handle's output ends however the stream settles, so a consumer
      // reading it is released on exit exactly as it was on a clean close.
      const endOutput = (): void => {
        if (!output.writableEnded) output.end();
      };
      void done.then(endOutput, endOutput).catch(() => {});

      const handle = {
        pid,
        output,
        done,
        write: async (data: string) => {
          terminal.write(data);
        },
        resize: async (cols: number, rows: number) => {
          terminal.resize(cols, rows);
        },
        inspectActivity: async () => ({
          state: "unknown" as const,
          revision: terminal.activityRevision(),
        }),
        inspectForeground: async () => terminal.inspectForeground(),
        signalForeground: async (signal: string) =>
          terminal.signalForeground(signal),
        terminate: async () => {
          await terminal.terminate();
          endOutput();
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
