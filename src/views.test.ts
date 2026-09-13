// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import { SECRET_BEARING_CONTAINER } from "./test-support.js";
import { publicContainer } from "./index.js";

test("publicContainer rebuilds a safe object from an API row", () => {
  const out = publicContainer(SECRET_BEARING_CONTAINER);
  assert.deepEqual(Object.keys(out).sort(), [
    "containerName",
    "env",
    "imageId",
    "mounts",
    "secretEnv",
    "status",
  ]);
  assert.deepEqual(out.mounts, [
    { projectName: "team", mode: "read_write", kind: "project" },
  ]);
  assert.deepEqual(out.env, { PATH: "/bin", DB_PASSWORD: "hunter2" });
});
