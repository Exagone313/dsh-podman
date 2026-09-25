// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import { TOOLS } from "./index.js";

// Tool parameters are camelCase. The only snake_case names allowed are the ones
// that intentionally mirror the harness's built-in read/write/edit tools. Proto
// field names are lower_snake_case and never reach a tool schema: proto-loader
// projects them to camelCase (`secret_env` -> `secretEnv`, `image_id` ->
// `imageId`), so an exposed snake_case proto name is a bug.
const BUILTIN_MIRRORED = new Set([
  "file_path",
  "old_string",
  "new_string",
  "replace_all",
]);

test("tool parameters never expose a proto-style snake_case name", () => {
  for (const tool of TOOLS) {
    for (const name of Object.keys(tool.parameters.properties)) {
      if (name.includes("_")) {
        assert.ok(
          BUILTIN_MIRRORED.has(name),
          `${tool.name}.${name} is snake_case but does not mirror a built-in tool`,
        );
      }
      assert.notEqual(
        name,
        "secret_env",
        `${tool.name} must expose secretEnv, not secret_env`,
      );
      assert.notEqual(
        name,
        "image_id",
        `${tool.name} must expose imageId, not image_id`,
      );
    }
  }
});
