// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import { workspaceSlug, metadata } from "./workspace-binding.js";
import { grpc } from "./grpc/runtime-client.js";

test("workspace slugs are stable and container-safe", () => {
  assert.equal(workspaceSlug({ projectName: "my/project" }), "my-project");
  assert.equal(workspaceSlug({ id: "session-1" }), "session-1");
  assert.equal(workspaceSlug({ projectName: "../../etc" }), "etc");
  assert.equal(workspaceSlug("workspace-123"), "workspace-123");
});

test("workspace slugs read from the workspace shape", () => {
  assert.equal(workspaceSlug({ workspace: { name: "alpha" } }), "alpha");
  assert.equal(workspaceSlug({ workspaceName: "beta" }), "beta");
  assert.equal(workspaceSlug({ projectName: "gamma" }), "gamma");
  assert.equal(workspaceSlug({ id: "delta" }), "delta");
});

test("workspace slugs fall back to default", () => {
  assert.equal(workspaceSlug(undefined), "default");
  assert.equal(workspaceSlug(null), "default");
  assert.equal(workspaceSlug({}), "default");
  assert.equal(workspaceSlug({ workspace: { name: "" } }), "default");
});

test("workspace slugs are sanitized and truncated", () => {
  assert.equal(workspaceSlug({ projectName: "a b/c-d" }), "a-b-c-d");
  assert.equal(workspaceSlug("a b c"), "a-b-c");
  assert.equal(workspaceSlug({ projectName: "x_y.z" }), "x_y.z");
  assert.equal(workspaceSlug("-leading"), "leading");
  assert.equal(workspaceSlug("trailing-"), "trailing");
  assert.equal(workspaceSlug("a".repeat(200)), "a".repeat(50));
  assert.equal(workspaceSlug("a/b/c"), "a-b-c");
});

test("workspace slugs handle traversal parts", () => {
  assert.equal(workspaceSlug({ projectName: "../../etc" }), "etc");
  assert.equal(workspaceSlug("../../etc/passwd"), "etc-passwd");
  assert.equal(workspaceSlug("a/../b"), "a-b");
  assert.equal(workspaceSlug(".."), "default");
  assert.equal(workspaceSlug({ projectName: "../../.." }), "default");
});

test("metadata carries the bearer token", () => {
  const result = metadata("token-1");
  assert.ok(result instanceof grpc.Metadata);
  assert.equal(result.get("authorization")[0], "bearer token-1");
});
