// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import {
  confineToRoot,
  crumbLabel,
  hostPathForProjectName,
  parentDirectory,
  projectNameFromHostPath,
  rootCrumbs,
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

test("confineToRoot clamps a directory to the projects root", () => {
  assert.equal(confineToRoot("/projects", "/projects/web"), "/projects/web");
  assert.equal(confineToRoot("/projects", "/projects"), "/projects");
  assert.equal(confineToRoot("/projects", "/etc"), "/projects");
  assert.equal(confineToRoot("/projects", ""), "/projects");
  assert.equal(
    confineToRoot("/projects", "/projects/web/"),
    "/projects/web",
    "trailing slashes are ignored",
  );
});

test("project paths resolve their dots and never escape the root", () => {
  // A ".." that stays inside the root is resolved.
  assert.equal(confineToRoot("/projects", "/projects/a/../b"), "/projects/b");
  assert.equal(hostPathForProjectName("/projects", "a/../b"), "/projects/b");
  // A ".." that would climb above the root clamps to the root, on both the
  // path-building and the path-clamping helper.
  assert.equal(confineToRoot("/projects", "/projects/../etc"), "/projects");
  assert.equal(confineToRoot("/projects", "/projects/a/../../etc"), "/projects");
  assert.equal(hostPathForProjectName("/projects", "../etc"), "/projects");
  assert.equal(hostPathForProjectName("/projects", "a/../../etc"), "/projects");
  assert.equal(hostPathForProjectName("/projects", "/../etc"), "/projects");
  // A "." segment is dropped, not kept as a directory name.
  assert.equal(hostPathForProjectName("/projects", "./web"), "/projects/web");
});

test("parentDirectory never climbs above the projects root", () => {
  assert.equal(parentDirectory("/projects", "/projects/web/sub"), "/projects/web");
  assert.equal(parentDirectory("/projects", "/projects/web"), "/projects");
  assert.equal(parentDirectory("/projects", "/projects"), "/projects");
  assert.equal(parentDirectory("/projects", "/elsewhere"), "/projects");
});

test("rootCrumbs lists the root-relative ancestry", () => {
  assert.deepEqual(rootCrumbs("/projects", "/projects/group/web"), [
    "/projects/group",
    "/projects/group/web",
  ]);
  assert.deepEqual(rootCrumbs("/projects", "/projects"), []);
  assert.deepEqual(
    rootCrumbs("/projects", "/etc"),
    [],
    "a path outside the root has no crumbs",
  );
});

test("crumbLabel is the last segment", () => {
  assert.equal(crumbLabel("/projects/group/web"), "web");
  assert.equal(crumbLabel("/projects/group/web/"), "web");
  assert.equal(crumbLabel("/projects"), "projects");
});
