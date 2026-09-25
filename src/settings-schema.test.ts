// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import { Config } from "./settings-schema.js";
import { WorkspaceResolver } from "./workspace-binding.js";

test("every preference is a volatile field with an empty default", () => {
  const config = (Config as any)({});
  const expected: Array<[string, unknown]> = [
    ["defaultImage", ""],
    ["socketsRoot", ""],
    ["uiLocale", ""],
    ["containerEnv", {}],
  ];
  for (const [field, value] of expected) {
    assert.equal(typeof config[field].get, "function", `${field} must be volatile`);
    assert.deepEqual(config[field].get(), value, `${field} must resolve its default`);
  }
  // The host serves the schema to the client config form: volatility must be
  // declared on the schema, not only in the parsed value.
  assert.match(JSON.stringify((Config as any).toJSON()), /"volatile":true/);
});

test("the resolver reads its config through the live reader", () => {
  let socketsRoot = "/run/one";
  const resolver = new WorkspaceResolver(
    () => ({
      socketsRoot,
      defaultImage: "archlinux",
      projectsRoot: "/projects",
      controlToken: "token",
      containerEnv: {},
    }),
    undefined,
  );
  assert.equal(resolver.getConfig().socketsRoot, "/run/one");
  socketsRoot = "/run/two";
  assert.equal(
    resolver.getConfig().socketsRoot,
    "/run/two",
    "a volatile change must be visible without rebuilding the resolver",
  );
});
