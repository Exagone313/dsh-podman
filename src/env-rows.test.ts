// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import {
  conflictingEnvNames,
  emptyEnvRow,
  envEditRows,
  envRecordFromRows,
  firstDuplicateEnvName,
} from "./env-rows.js";

test("envEditRows wraps a record's entries in display order, each with its own id", () => {
  assert.deepEqual(envEditRows({}), []);
  // The rows open as a container block lists them: by name, case-insensitively
  // and ascending, whichever order the record holds.
  const rows = envEditRows({ B: "2", a: "1" });
  assert.deepEqual(rows.map((row) => [row.key, row.value]), [
    ["a", "1"],
    ["B", "2"],
  ]);
  // Two names that differ only by case still read in one fixed order.
  assert.deepEqual(
    envEditRows({ a: "1", A: "2" }).map((row) => row.key),
    ["A", "a"],
  );
  // Every row carries an id, which keeps its React key stable across a rename.
  assert.equal(new Set(rows.map((row) => row.id)).size, 2);
});

test("emptyEnvRow is an unnamed, empty row with its own id", () => {
  const one = emptyEnvRow();
  const two = emptyEnvRow();
  assert.equal(one.key, "");
  assert.equal(one.value, "");
  assert.notEqual(one.id, two.id);
  assert.notEqual(one.id, envEditRows({ A: "1" })[0].id);
});

test("envRecordFromRows commits only the named rows, in order", () => {
  assert.deepEqual(envRecordFromRows([]), {});
  assert.deepEqual(
    envRecordFromRows([
      { id: 0, key: "A", value: "1" },
      { id: 1, key: "", value: "2" },
      { id: 2, key: "B", value: "3" },
    ]),
    { A: "1", B: "3" },
  );
});

test("envRecordFromRows lets the last of a repeated name win", () => {
  // The two rows stay side by side while the duplicate check refuses the apply,
  // so the derived record can only carry one of them.
  assert.deepEqual(
    envRecordFromRows([
      { id: 0, key: "A", value: "1" },
      { id: 1, key: "A", value: "2" },
    ]),
    { A: "2" },
  );
});

test("the conflict checks flag an empty or repeated name", () => {
  assert.deepEqual([...conflictingEnvNames([])], []);
  assert.deepEqual([...conflictingEnvNames(["A", "B"])], []);
  assert.deepEqual([...conflictingEnvNames(["A", "A", "B", "B", ""])], [
    "A",
    "B",
    "",
  ]);
  assert.equal(firstDuplicateEnvName(["A", "B"]), undefined);
  assert.equal(firstDuplicateEnvName(["", "A", "B", "A"]), "A");
});
