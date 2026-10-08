// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import { EXPECTED_TOOLS } from "./test-support.js";
import { TOOL_PRESENTATION } from "./client/tool-presentations.js";
import { en, zh } from "./client/locales.js";

// Every tool this package registers must own a client row, or the shipped
// client silently falls back to "Tool call · <tool name>". The row table is
// React-free precisely so this test can import it: the browser bundle pulls in
// browser-only UI primitives and cannot be loaded here.
test("every tool has a client row with a title in both languages", () => {
  assert.deepEqual(
    Object.keys(TOOL_PRESENTATION).sort(),
    [...EXPECTED_TOOLS].sort(),
    "a tool without a row renders as the generic Tool call fallback",
  );
  for (const [tool, presentation] of Object.entries(TOOL_PRESENTATION)) {
    assert.notEqual(
      en[presentation.titleKey],
      undefined,
      `${tool} has no en title`,
    );
    assert.notEqual(
      zh[presentation.titleKey],
      undefined,
      `${tool} has no zh title`,
    );
  }
});
