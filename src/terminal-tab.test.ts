// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
// Importing the client module here also typechecks it under the host program,
// which has no DOM lib: it must stay environment-free data.
import { PODMAN_TERMINAL_SHORTCUT_DEFAULTS } from "./client/terminal-tab.js";

// The harness's shortcuts registry rejects a declared default it does not admit
// by THROWING from register(), which runs inside apply(): one bad profile fails
// the client entry and the whole web boot. These assertions pin the profiles
// that rule allows, so such a break is caught by pnpm test instead of in the UI.
test("the Podman terminal shortcut declares only admitted profiles", () => {
  const defaults: Record<string, unknown> = PODMAN_TERMINAL_SHORTCUT_DEFAULTS;
  assert.deepEqual(
    Object.keys(defaults).sort(),
    ["desktop:linux", "desktop:macos", "desktop:windows", "web:macos", "web:windows"],
  );
  for (const [profile, value] of Object.entries(PODMAN_TERMINAL_SHORTCUT_DEFAULTS)) {
    assert.match(profile, /^(desktop|web):(macos|windows|linux)$/u);
    assert.ok(
      Array.isArray(value.modifiers) && value.modifiers.length > 0,
      `${profile} needs at least one modifier`,
    );
  }
  // Linux Web admits only Ctrl+/, Ctrl+Shift+, and Ctrl+Shift+.
  assert.equal(defaults["web:linux"], undefined);
  // macOS Web admits Ctrl+` and Meta+Shift+`, never Ctrl+Shift+`.
  assert.deepEqual(PODMAN_TERMINAL_SHORTCUT_DEFAULTS["web:macos"], {
    code: "Backquote",
    modifiers: ["meta", "shift"],
  });
});
