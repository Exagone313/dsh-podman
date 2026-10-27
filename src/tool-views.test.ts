// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import { EXPECTED_TOOLS } from "./test-support.js";
import {
  TOOL_PRESENTATION,
  toolPresentation,
  toolResultCode,
} from "./client/tool-presentations.js";
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

// A string result reaches the row as its JSON scalar, so the export's YAML
// would otherwise show as one quoted line with escaped newlines. Declaring the
// fence and decoding the envelope is what makes the row render the template as
// a selectable, copyable YAML code block instead.
test("the template export result is presented as fenced YAML", () => {
  const yaml = "image: ubuntu\nmounts:\n  - kind: project\n";
  assert.equal(TOOL_PRESENTATION.container_template_export.resultFence, "yaml");
  assert.deepEqual(
    toolResultCode("container_template_export", JSON.stringify(yaml)),
    { lang: "yaml", code: yaml },
  );
  assert.notEqual(
    toolResultCode("container_template_export", JSON.stringify(yaml))?.code,
    JSON.stringify(yaml),
    "the quoted JSON envelope must not reach the code block",
  );
  // A short status result stays a raw string.
  assert.equal(
    toolResultCode(
      "container_template_save",
      JSON.stringify({ name: "web.yml", path: "/p/.dsh-podman/web.yml" }),
    ),
    null,
  );
  assert.equal(
    toolPresentation("container_template_save")?.resultFence,
    undefined,
  );
});
