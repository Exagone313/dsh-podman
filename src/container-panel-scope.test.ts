// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import { containersInWorkspace } from "./client/container-panel-scope.js";
import type { ContainerView } from "./client/card-protocol.js";

const ALPHA = { workspace: "alpha", workspaceSlug: "alpha" };
const BETA = { workspace: "beta", workspaceSlug: "beta" };

function row(containerName: string, workspaceSlug: string): ContainerView {
  return { containerName, workspaceSlug, status: "running" } as ContainerView;
}

function names(rows: readonly ContainerView[]): string[] {
  return rows.map((container) => container.containerName);
}

test("the panel shows only the resolved workspace's containers", () => {
  const containers = [
    row("default", "alpha"),
    row("dev", "alpha"),
    row("db", "beta"),
  ];
  assert.deepEqual(names(containersInWorkspace(containers, ALPHA)), [
    "default",
    "dev",
  ]);
  // Another workspace is never shown, even when it is the one asked for.
  assert.deepEqual(names(containersInWorkspace(containers, BETA)), ["db"]);
});

test("PTC and workspace-less rows belong to no workspace", () => {
  const containers = [
    row("ptc", "alpha"),
    row("default", ""),
    row("dev", ""),
    row("default", "alpha"),
  ];
  assert.deepEqual(names(containersInWorkspace(containers, ALPHA)), [
    "default",
  ]);
  // An empty slug never matches a target, so the workspace-less rows are never
  // shown as a group of their own either.
  assert.deepEqual(
    containersInWorkspace(containers, { workspace: "", workspaceSlug: "" }),
    [],
  );
});

test("an unknown session has no workspace to scope to", () => {
  const containers = [row("dev", "alpha")];
  assert.deepEqual(containersInWorkspace(containers, undefined), []);
  assert.deepEqual(
    containersInWorkspace(containers, { workspace: "", workspaceSlug: "" }),
    [],
  );
  // A target that names a project but no slug is as unplaceable as no target.
  assert.deepEqual(
    containersInWorkspace(containers, {
      workspace: "alpha",
      workspaceSlug: "",
    }),
    [],
  );
});

test("the default container sorts first, then the named ones", () => {
  const containers = [
    row("zdev", "alpha"),
    row("default", "alpha"),
    row("adev", "alpha"),
  ];
  assert.deepEqual(names(containersInWorkspace(containers, ALPHA)), [
    "default",
    "adev",
    "zdev",
  ]);
});
