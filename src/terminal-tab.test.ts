// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
// Importing the client module here also typechecks it under the host program,
// which has no DOM lib: it must stay environment-free data.
import {
  PODMAN_TERMINAL_SHORTCUT_DEFAULTS,
  PODMAN_TERMINAL_SHORTCUT_FALLBACK_DEFAULTS,
} from "./client/terminal-tab.js";
// The harness's shortcuts registry rejects a declared default it does not admit
// by THROWING from register(), which runs inside apply(): one bad profile fails
// the client entry and the whole web boot. These assertions pin the profiles
// that rule allows, so such a break is caught by pnpm test instead of in the UI.
test("the Podman terminal shortcut prefers the built-in terminal's binding", () => {
  const defaults: Record<string, unknown> = PODMAN_TERMINAL_SHORTCUT_DEFAULTS;
  assert.deepEqual(
    Object.keys(defaults).sort(),
    ["desktop:linux", "desktop:macos", "desktop:windows", "web:macos", "web:windows"],
  );
  for (const value of Object.values(PODMAN_TERMINAL_SHORTCUT_DEFAULTS)) {
    assert.deepEqual(value, { code: "Backquote", modifiers: ["control"] });
  }
  // Linux Web admits only Ctrl+/, Ctrl+Shift+, and Ctrl+Shift+.
  assert.equal(defaults["web:linux"], undefined);
});

test("the fallback binding is distinct and equally admitted", () => {
  const fallback: Record<string, unknown> = PODMAN_TERMINAL_SHORTCUT_FALLBACK_DEFAULTS;
  assert.deepEqual(
    Object.keys(fallback).sort(),
    ["desktop:linux", "desktop:macos", "desktop:windows", "web:macos", "web:windows"],
  );
  // macOS Web admits Ctrl+` and Meta+Shift+`, never Ctrl+Shift+`.
  assert.deepEqual(PODMAN_TERMINAL_SHORTCUT_FALLBACK_DEFAULTS["web:macos"], {
    code: "Backquote",
    modifiers: ["meta", "shift"],
  });
  for (
    const profile of ["desktop:macos", "desktop:windows", "desktop:linux", "web:windows"] as const
  ) {
    assert.deepEqual(PODMAN_TERMINAL_SHORTCUT_FALLBACK_DEFAULTS[profile], {
      code: "Backquote",
      modifiers: ["control", "shift"],
    });
  }
  // The two bindings can never overlap, so the fallback cannot be the reason a
  // re-enabled built-in terminal breaks the boot.
  for (const profile of Object.keys(fallback)) {
    assert.notDeepEqual(
      fallback[profile],
      (PODMAN_TERMINAL_SHORTCUT_DEFAULTS as Record<string, unknown>)[profile],
    );
  }
});
