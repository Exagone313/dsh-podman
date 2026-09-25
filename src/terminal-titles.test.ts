// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import {
  forgetTerminalTitle,
  publishTerminalTitle,
  subscribeTerminalTitles,
  terminalTitle,
} from "./client/terminal-titles.js";

test("published terminal titles are readable, notifying and forgettable", () => {
  let notifications = 0;
  const unsubscribe = subscribeTerminalTitles(() => {
    notifications += 1;
  });

  assert.equal(terminalTitle("s1:t1"), undefined);
  publishTerminalTitle("s1:t1", "bash");
  assert.equal(terminalTitle("s1:t1"), "bash");
  assert.equal(notifications, 1);

  // Re-publishing the same name is a no-op; another terminal is independent.
  publishTerminalTitle("s1:t1", "bash");
  publishTerminalTitle("s1:t1", "");
  assert.equal(notifications, 1);
  publishTerminalTitle("s1:t2", "sh");
  assert.equal(terminalTitle("s1:t2"), "sh");
  assert.equal(notifications, 2);

  // The same tab id in another session never bleeds through.
  publishTerminalTitle("s2:t1", "zsh");
  assert.equal(terminalTitle("s1:t1"), "bash");
  assert.equal(terminalTitle("s2:t1"), "zsh");

  forgetTerminalTitle("s1:t1");
  assert.equal(terminalTitle("s1:t1"), undefined);
  assert.equal(notifications, 4);
  // Forgetting an unknown key changes nothing.
  forgetTerminalTitle("s1:t1");
  assert.equal(notifications, 4);

  unsubscribe();
  publishTerminalTitle("s1:t2", "fish");
  assert.equal(notifications, 4);
});
