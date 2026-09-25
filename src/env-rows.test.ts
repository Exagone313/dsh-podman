// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import {
  commitEnvDraft,
  emptyEnvDraft,
  envKeyAvailable,
  envRows,
  removeEnvRow,
  renameEnvKey,
  setEnvValue,
} from "./env-rows.js";

test("envRows lists the committed entries and then the pending draft", () => {
  assert.deepEqual(envRows({}, undefined), []);
  assert.deepEqual(envRows({ A: "1" }, undefined), [
    { key: "A", value: "1", pending: false },
  ]);
  assert.deepEqual(envRows({ A: "1", B: "2" }, emptyEnvDraft()), [
    { key: "A", value: "1", pending: false },
    { key: "B", value: "2", pending: false },
    { key: "", value: "", pending: true },
  ]);
});

test("envKeyAvailable accepts only a new, non-empty key", () => {
  assert.equal(envKeyAvailable({}, ""), false);
  assert.equal(envKeyAvailable({ A: "1" }, "A"), false);
  assert.equal(envKeyAvailable({ A: "1" }, "B"), true);
  // A key inherited from the prototype is not an existing variable.
  assert.equal(envKeyAvailable({}, "toString"), true);
});

test("commitEnvDraft refuses an empty or duplicate key", () => {
  assert.equal(commitEnvDraft({}, { key: "", value: "x" }), undefined);
  assert.equal(commitEnvDraft({ A: "1" }, { key: "A", value: "x" }), undefined);
});

test("commitEnvDraft appends an accepted key with its value", () => {
  assert.deepEqual(commitEnvDraft({ A: "1" }, { key: "B", value: "2" }), {
    A: "1",
    B: "2",
  });
  assert.deepEqual(commitEnvDraft({}, { key: "B", value: "" }), { B: "" });
});

test("env transformations keep row order", () => {
  const env = { A: "1", B: "2", C: "3" };
  assert.deepEqual(renameEnvKey(env, 1, "BB"), { A: "1", BB: "2", C: "3" });
  assert.deepEqual(setEnvValue(env, 2, "33"), { A: "1", B: "2", C: "33" });
  assert.deepEqual(removeEnvRow(env, 0), { B: "2", C: "3" });
  // The input record is never mutated.
  assert.deepEqual(env, { A: "1", B: "2", C: "3" });
});
