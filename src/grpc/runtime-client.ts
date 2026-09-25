// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import grpc from "@grpc/grpc-js";
import loader from "@grpc/proto-loader";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "proto");
const definitions = new Map<string, grpc.ServiceClientConstructor>();
// Live channels, keyed like the constructors: one client per service and
// socket for the plugin's lifetime. A channel holds a unix-socket connection
// and worker threads, so constructing one per call leaks both; the resolver
// disposes this cache on shutdown.
const clients = new Map<string, grpc.Client>();

// Keepalive lets a half-open channel fail fast instead of leaving a call
// pending forever, which is what backs the "hung orchestrator" symptom. Calls
// themselves carry no deadline: several control operations (image pull/build,
// cache clean) are legitimately long, so cancellation is driven by the turn's
// AbortSignal instead.
//
// Both servers permit exactly this policy (internal/grpcopts.KeepalivePolicy);
// grpc-go's default (5 minutes, no pings without streams) answers these pings
// with GOAWAY "too many pings", which grpc-js logs as "rejected by server
// because of excess pings". Keep the interval in sync with that policy.
const CHANNEL_OPTIONS = {
  "grpc.keepalive_time_ms": 30_000,
  "grpc.keepalive_timeout_ms": 10_000,
  "grpc.keepalive_permit_without_calls": 1,
} as const;

function unixTarget(socket: string): string {
  return socket.startsWith("unix:") ? socket : `unix:${socket}`;
}

function constructorFor(
  service: string,
  proto: string,
): grpc.ServiceClientConstructor {
  const cached = definitions.get(service);
  if (cached !== undefined) return cached;
  const packageDefinition = loader.loadSync(resolve(root, proto), {
    longs: String,
    enums: String,
    defaults: true,
  });
  const loaded = grpc.loadPackageDefinition(
    packageDefinition,
  ) as unknown as Record<string, unknown>;
  const namespace = service.startsWith("dshctl")
    ? (loaded.dshctl as Record<string, unknown>)
    : (loaded.dshguest as Record<string, unknown>);
  const version = namespace.v1 as Record<string, unknown>;
  const Constructor = version[
    service.split(".").at(-1)!
  ] as grpc.ServiceClientConstructor;
  definitions.set(service, Constructor);
  return Constructor;
}

function client(service: string, proto: string, socket: string): grpc.Client {
  const key = `${service}:${socket}`;
  let existing = clients.get(key);
  if (existing === undefined) {
    existing = new (constructorFor(service, proto))(
      unixTarget(socket),
      grpc.credentials.createInsecure(),
      CHANNEL_OPTIONS,
    );
    clients.set(key, existing);
  }
  return existing;
}

export function controlClient(socket: string): grpc.Client {
  return client(
    "dshctl.v1.OrchestratorControl",
    "dshctl/v1/control.proto",
    socket,
  );
}
export function guestClient(socket: string): grpc.Client {
  return client(
    "dshguest.v1.WorkspaceGuestAgent",
    "dshguest/v1/guest.proto",
    socket,
  );
}

// closeClients closes and forgets every cached channel. Called when the plugin
// is disposed; a later call would create a fresh client.
export function closeClients(): void {
  for (const client of clients.values()) {
    client.close();
  }
  clients.clear();
}

// abortError is the stable shape an aborted call rejects with, so callers can
// tell a cancellation apart from a transport failure without parsing text.
export function abortError(label: string): Error {
  const error = new Error(`${label} aborted`);
  (error as { code?: string }).code = "ABORTED";
  return error;
}

// onAbortCancel cancels a pending call when the signal aborts, and returns the
// detach function that removes the listener once the call settles.
function onAbortCancel(
  call: { cancel(): void },
  signal: AbortSignal | undefined,
): () => void {
  if (signal === undefined) return () => {};
  const onAbort = (): void => {
    try {
      call.cancel();
    } catch {
      // A finished call cannot be cancelled again; nothing to do.
    }
  };
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

export function unary<T>(
  client: grpc.Client,
  method: string,
  request: unknown,
  metadata?: grpc.Metadata,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise((resolvePromise, reject) => {
    if (signal?.aborted) {
      reject(abortError(method));
      return;
    }
    let detach: () => void = () => {};
    const call = (client as unknown as Record<string, Function>)[method](
      request,
      metadata ?? new grpc.Metadata(),
      (error: Error | null, value: T) => {
        detach();
        if (error) {
          reject(signal?.aborted ? abortError(method) : error);
        } else {
          resolvePromise(value);
        }
      },
    );
    detach = onAbortCancel(call, signal);
  });
}
export { grpc };
