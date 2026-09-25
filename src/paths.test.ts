// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import { pathRequestRecorder, WORKSPACE_ID } from "./test-support.js";
import { summarizeArgs, toolHandlers, TOOLS } from "./index.js";

const EXEC = { agent: { session: { header: { cwd: "/proj" } } } };

test("the path tools are registered and approval-gated", () => {
  for (
    const name of [
      "container_path_set",
      "container_path_add",
      "container_path_remove",
    ]
  ) {
    const tool = TOOLS.find((entry) => entry.name === name);
    assert.ok(tool, `${name} registered`);
    assert.equal(tool!.approval, true, `${name} must require approval`);
    assert.ok(
      tool!.parameters.required.includes("container"),
      `${name} requires container`,
    );
  }
  assert.deepEqual(
    TOOLS.find((entry) => entry.name === "container_path_set")!.parameters
      .required,
    ["container", "paths"],
  );
  assert.deepEqual(
    TOOLS.find((entry) => entry.name === "container_path_add")!.parameters
      .required,
    ["container", "path"],
  );
});

test("container_path_set persists and applies the whole list", async () => {
  const { controlCalls, setCalls, resolver } = pathRequestRecorder();
  const out = await toolHandlers.container_path_set(
    resolver as never,
    { container: "default", paths: ["/opt/bin", "/usr/local/bin"] },
    EXEC,
  );
  assert.deepEqual(controlCalls, [
    [
      "setContainerPaths",
      {
        workspaceSlug: WORKSPACE_ID,
        container: "default",
        paths: ["/opt/bin", "/usr/local/bin"],
      },
    ],
  ]);
  assert.deepEqual(setCalls, [["/opt/bin", "/usr/local/bin"]]);
  assert.deepEqual(out, { paths: ["/opt/bin", "/usr/local/bin"] });
});

test("container_path_add prepends and moves an existing entry to the front", async () => {
  const { controlCalls, resolver } = pathRequestRecorder({ paths: ["/a", "/b"] });
  const added = await toolHandlers.container_path_add(
    resolver as never,
    { container: "default", path: "/c" },
    EXEC,
  );
  assert.deepEqual(added, { paths: ["/c", "/a", "/b"] });
  const moved = await toolHandlers.container_path_add(
    resolver as never,
    { container: "default", path: "/b" },
    EXEC,
  );
  assert.deepEqual(moved, { paths: ["/b", "/c", "/a"] });
  assert.equal(controlCalls.length, 2);
});

test("container_path_remove removes an added path", async () => {
  const { resolver } = pathRequestRecorder({ paths: ["/a", "/b"] });
  const out = await toolHandlers.container_path_remove(
    resolver as never,
    { container: "default", path: "/a" },
    EXEC,
  );
  assert.deepEqual(out, { paths: ["/b"] });
});

test("container_path_remove distinguishes a default path from an unknown one", async () => {
  const { controlCalls, resolver } = pathRequestRecorder({
    paths: ["/a"],
    defaultPath: "/usr/bin:/bin",
  });
  await assert.rejects(
    () =>
      toolHandlers.container_path_remove(
        resolver as never,
        { container: "default", path: "/usr/bin" },
        EXEC,
      ),
    /is part of the container's default PATH and cannot be removed/,
  );
  await assert.rejects(
    () =>
      toolHandlers.container_path_remove(
        resolver as never,
        { container: "default", path: "/nope" },
        EXEC,
      ),
    /is not an added path/,
  );
  assert.deepEqual(
    controlCalls,
    [],
    "a rejected removal must not reach the orchestrator",
  );
});

test("summarizeArgs renders the PATH reasons", () => {
  assert.equal(
    summarizeArgs("container_path_set", {
      container: "web",
      paths: ["/opt/bin", "/usr/local/bin"],
    }),
    'Set the PATH additions of container "web": "/opt/bin", "/usr/local/bin".',
  );
  assert.equal(
    summarizeArgs("container_path_set", { container: "web", paths: [] }),
    'Set the PATH additions of container "web": (none).',
  );
  assert.equal(
    summarizeArgs("container_path_add", { container: "web", path: "/opt/bin" }),
    'Add "/opt/bin" to the PATH of container "web".',
  );
  assert.equal(
    summarizeArgs("container_path_remove", {
      container: "web",
      path: "/opt/bin",
    }),
    'Remove "/opt/bin" from the PATH of container "web".',
  );
});
