// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import { core, major, versionState } from "./version-compat.js";

test("core keeps the leading x.y.z", () => {
  assert.equal(core("1.2.3"), "1.2.3");
  assert.equal(core("0.2.0-rc.3"), "0.2.0");
  assert.equal(core("1.2.3-4-gabc123"), "1.2.3");
  assert.equal(core("dev"), "");
  assert.equal(core(""), "");
});

test("major reports the leading component", () => {
  assert.equal(major("1.2.3"), 1);
  assert.equal(major("0.2.0-rc.3"), 0);
  assert.equal(major("dev"), -1);
});

test("versionState mirrors the orchestrator's compatibility rule", () => {
  assert.equal(versionState("1.2.3", "1.2.3"), "ok");
  assert.equal(versionState("1.2.3-4-gabc", "1.2.3"), "ok");
  assert.equal(versionState("1.3.0", "1.2.3"), "minor-mismatch");
  assert.equal(versionState("1.2.4", "1.2.3"), "minor-mismatch");
  assert.equal(versionState("2.0.0", "1.9.0"), "major-mismatch");
  assert.equal(versionState("1.9.0", "2.0.0"), "major-mismatch");
  assert.equal(
    versionState("1.2.3", "dev"),
    "ok",
    "an orchestrator with no comparable version accepts any plugin",
  );
});
