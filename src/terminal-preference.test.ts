// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import {
  readTerminalTarget,
  TERMINAL_TARGET_KEY,
  writeTerminalTarget,
} from "./client/terminal-preference.js";

function fakeStorage(initial?: string) {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(TERMINAL_TARGET_KEY, initial);
  return {
    values,
    getItem: (key: string): string | null => values.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      values.set(key, value);
    },
  };
}

test("the terminal card remembers the target it started", () => {
  const storage = fakeStorage();
  assert.equal(readTerminalTarget(storage), undefined);

  writeTerminalTarget({ container: "dev", shell: "/usr/bin/bash" }, storage);
  assert.deepEqual(readTerminalTarget(storage), {
    container: "dev",
    shell: "/usr/bin/bash",
  });
  // The default container is a real choice and must survive the round trip.
  writeTerminalTarget({ container: "", shell: "/bin/sh" }, storage);
  assert.deepEqual(readTerminalTarget(storage), { container: "", shell: "/bin/sh" });
});

test("unusable stored values leave the card without a preference", () => {
  for (
    const raw of [
      "",
      "{",
      "null",
      "[]",
      '"text"',
      "{}",
      '{"container":1}',
      '{"shell":2}',
      '{"container":null,"shell":false}',
    ]
  ) {
    assert.equal(readTerminalTarget(fakeStorage(raw)), undefined, raw);
  }
  // A partial record keeps the half that is usable.
  assert.deepEqual(
    readTerminalTarget(fakeStorage('{"shell":"/bin/sh","extra":true}')),
    { shell: "/bin/sh" },
  );
});

test("a storage that refuses to answer never breaks the card", () => {
  const failing = {
    getItem(): string | null {
      throw new Error("denied");
    },
    setItem(): void {
      throw new Error("denied");
    },
  };
  assert.equal(readTerminalTarget(failing), undefined);
  assert.doesNotThrow(() => writeTerminalTarget({ container: "", shell: "/bin/sh" }, failing));
});
