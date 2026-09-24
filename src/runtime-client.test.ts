// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import {
  abortError,
  closeClients,
  controlClient,
  guestClient,
  unary,
} from "./grpc/runtime-client.js";

test("clients are reused per socket and a close drops the cache", () => {
  const first = controlClient("/run/dsh-podman/orchestrator.sock");
  const second = controlClient("/run/dsh-podman/orchestrator.sock");
  assert.equal(second, first, "the same socket must reuse one channel");
  assert.notEqual(
    controlClient("/tmp/other.sock"),
    first,
    "a different socket gets its own channel",
  );
  const guest = guestClient("/run/dsh-podman/w/guest.sock");
  closeClients();
  assert.notEqual(
    controlClient("/run/dsh-podman/orchestrator.sock"),
    first,
    "a disposed client is not served from the cache",
  );
  assert.notEqual(guestClient("/run/dsh-podman/w/guest.sock"), guest);
  closeClients();
});

test("unary rejects a pre-aborted call without invoking the client", async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  const client: any = {
    method: () => {
      called = true;
    },
  };
  await assert.rejects(
    () => unary(client, "method", {}, undefined, controller.signal),
    (error: any) => error.code === "ABORTED",
  );
  assert.equal(called, false);
});

test("unary cancels a pending call when the signal aborts", async () => {
  const controller = new AbortController();
  let cancelled = false;
  let settle: ((error: Error | null) => void) | undefined;
  const client: any = {
    method: (_request: unknown, _metadata: unknown, callback: any) => {
      settle = callback;
      return {
        cancel: () => {
          cancelled = true;
          // grpc-js settles a cancelled call with a CANCELLED status.
          settle?.(Object.assign(new Error("cancelled"), { code: 1 }));
        },
      };
    },
  };
  const pending = unary(client, "method", {}, undefined, controller.signal);
  controller.abort();
  await assert.rejects(pending, (error: any) => error.code === "ABORTED");
  assert.equal(cancelled, true);
});

test("abortError carries a stable code", () => {
  assert.equal((abortError("exec") as any).code, "ABORTED");
});
