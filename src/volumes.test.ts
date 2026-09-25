// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import { VOLUME_TOOLS } from "./test-support.js";
import { toolHandlers, TOOLS } from "./index.js";

test("volume tools are registered with the expected schemas", () => {
  for (const name of VOLUME_TOOLS) {
    const tool = TOOLS.find((entry) => entry.name === name);
    assert.ok(tool, `${name} registered`);
    if (name === "volume_remove") {
      assert.equal(tool!.approval, true, "volume_remove must require approval");
    } else {
      assert.notEqual(tool!.approval, true, `${name} must not require approval`);
    }
    assert.equal(tool!.parameters.type, "object", `${name} type`);
    assert.equal(typeof tool!.parameters.properties, "object");
    assert.ok(Array.isArray(tool!.parameters.required));
  }

  const listTool = TOOLS.find((entry) => entry.name === "volume_list");
  assert.deepEqual(listTool!.parameters.required, []);

  const createTool = TOOLS.find((entry) => entry.name === "volume_create");
  assert.deepEqual(createTool!.parameters.required, ["name"]);
  assert.equal(createTool!.parameters.properties.name.type, "string");

  const removeTool = TOOLS.find((entry) => entry.name === "volume_remove");
  assert.deepEqual(removeTool!.parameters.required, ["name"]);
  assert.equal(removeTool!.parameters.properties.name.type, "string");
});

test("volume_list and secret_list return name objects", async () => {
  const volumeResolver = {
    control: async () => ({ volumes: [{ name: "myvol" }] }),
  } as never;
  assert.deepEqual(
    await toolHandlers.volume_list(volumeResolver, {}, {}),
    [{ name: "myvol" }],
  );
  const secretResolver = {
    control: async () => ({ secrets: [{ name: "dbpass" }] }),
  } as never;
  assert.deepEqual(
    await toolHandlers.secret_list(secretResolver, {}, {}),
    [{ name: "dbpass" }],
  );
});
