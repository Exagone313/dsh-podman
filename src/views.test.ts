// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import { SECRET_BEARING_CONTAINER } from "./test-support.js";
import {
  publicContainer,
  publicContainerResult,
  publicContainers,
} from "./index.js";

test("publicContainer rebuilds a safe object from an API row", () => {
  const out = publicContainer(SECRET_BEARING_CONTAINER);
  assert.deepEqual(Object.keys(out).sort(), [
    "containerName",
    "env",
    "imageId",
    "mounts",
    "paths",
    "publishedPorts",
    "secretEnv",
    "status",
  ]);
  assert.deepEqual(out.mounts, [
    { projectName: "team", mode: "read_write", kind: "project" },
  ]);
  assert.deepEqual(out.env, { PATH: "/bin", DB_PASSWORD: "hunter2" });
});

test("publicContainers drops the reserved PTC container", () => {
  const out = publicContainers([
    { ...SECRET_BEARING_CONTAINER, containerName: "default" },
    {
      containerName: "ptc",
      kind: "CONTAINER_KIND_PTC",
      status: "running",
    },
  ]);
  assert.deepEqual(out.map((row) => row.containerName), ["default"]);
});

test("publicContainerResult refuses the reserved PTC container", () => {
  assert.throws(
    () =>
      publicContainerResult({
        workspaceSlug: "w1",
        containerName: "ptc",
        kind: "CONTAINER_KIND_PTC",
      }),
    /container "ptc" not found in workspace "w1"/,
  );
});
