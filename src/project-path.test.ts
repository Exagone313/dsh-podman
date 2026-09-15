// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import {
  hostPathForProjectName,
  projectNameFromHostPath,
} from "./project-path.js";

test("projectNameFromHostPath maps a host directory to a project path", () => {
  assert.equal(projectNameFromHostPath("/projects", "/projects/web"), "web");
  assert.equal(
    projectNameFromHostPath("/projects", "/projects/group/web"),
    "group/web",
  );
  assert.equal(
    projectNameFromHostPath("/projects/", "/projects/web/"),
    "web",
    "trailing slashes are ignored",
  );
});

test("projectNameFromHostPath refuses anything outside the projects root", () => {
  assert.equal(projectNameFromHostPath("/projects", "/projects"), undefined);
  assert.equal(projectNameFromHostPath("/projects", "/projects/"), undefined);
  assert.equal(projectNameFromHostPath("/projects", "/projects2/web"), undefined);
  assert.equal(projectNameFromHostPath("/projects", "/etc/hosts"), undefined);
  assert.equal(projectNameFromHostPath("/projects", "web"), undefined);
  assert.equal(projectNameFromHostPath("/projects", ""), undefined);
  assert.equal(projectNameFromHostPath("", "/projects/web"), undefined);
});

test("hostPathForProjectName is the inverse", () => {
  assert.equal(hostPathForProjectName("/projects", "web"), "/projects/web");
  assert.equal(
    hostPathForProjectName("/projects", "group/web"),
    "/projects/group/web",
  );
  assert.equal(hostPathForProjectName("/projects", ""), "/projects");
  assert.equal(hostPathForProjectName("/projects", "/web"), "/projects/web");
});
