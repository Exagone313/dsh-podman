// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import { withGuestAuth } from "./guest-rpc.js";
import { grpc } from "./grpc/runtime-client.js";

// pingOnce is a stand-in for a real guest call: it invokes the guest client and
// settles from its callback.
function pingOnce(guest: any, _token: string): Promise<any> {
  return new Promise((resolve, reject) => {
    guest.ping({}, undefined, (error: any, value: any) =>
      error ? reject(error) : resolve(value),
    );
  });
}

function rejectingGuest() {
  return {
    guest: {
      ping: (_request: any, _metadata: any, callback: any) =>
        callback(
          Object.assign(new Error("invalid agent token"), {
            code: grpc.status.UNAUTHENTICATED,
          }),
        ),
    },
    token: "old",
  };
}

test("withGuestAuth retries once with a refreshed binding", async () => {
  const seen: string[] = [];
  const fresh = {
    guest: {
      ping: (_request: any, _metadata: any, callback: any) =>
        callback(null, { version: "v" }),
    },
    token: "new",
  };
  const binding: any = { ...rejectingGuest(), refresh: async () => fresh };
  const result = await withGuestAuth(binding, (guest, token) => {
    seen.push(token);
    return pingOnce(guest, token);
  });
  assert.deepEqual(seen, ["old", "new"]);
  assert.deepEqual(result, { version: "v" });
});

test("withGuestAuth surfaces a second rejection", async () => {
  const rejecting = rejectingGuest();
  const binding: any = { ...rejecting, refresh: async () => rejecting };
  await assert.rejects(() => withGuestAuth(binding, pingOnce), /invalid agent token/);
});

test("withGuestAuth does not refresh on a non-auth error", async () => {
  let refreshed = false;
  const binding: any = {
    guest: {
      ping: (_request: any, _metadata: any, callback: any) =>
        callback(
          Object.assign(new Error("boom"), { code: grpc.status.INTERNAL }),
        ),
    },
    token: "t",
    refresh: async () => {
      refreshed = true;
      return binding;
    },
  };
  await assert.rejects(() => withGuestAuth(binding, pingOnce), /boom/);
  assert.equal(refreshed, false);
});

test("withGuestAuth surfaces the error when the binding cannot refresh", async () => {
  const binding: any = rejectingGuest();
  await assert.rejects(() => withGuestAuth(binding, pingOnce), /invalid agent token/);
});
