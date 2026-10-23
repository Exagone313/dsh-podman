// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import { guardDecision } from "./fs-guard.js";

test("guardDecision accepts a matching version", () => {
  assert.equal(guardDecision("agent:1:5:mode", "agent:1:5:mode"), "unchanged");
});

test("guardDecision reports a changed version as stale", () => {
  assert.equal(guardDecision("agent:1:5:mode", "agent:2:5:mode"), "stale");
  assert.equal(guardDecision("agent:1:5:mode", "host:1:5:33188"), "stale");
});

test("guardDecision reports an absent target as missing", () => {
  assert.equal(guardDecision("agent:1:5:mode", undefined), "missing");
});

test("guardDecision treats a missing target as missing even when unguarded", () => {
  assert.equal(guardDecision(undefined, undefined), "missing");
});

test("guardDecision lets an unguarded caller proceed on a present target", () => {
  assert.equal(guardDecision(undefined, "agent:1:5:mode"), "unchanged");
});
