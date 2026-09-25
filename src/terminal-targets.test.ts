// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import { containerOptions, sessionWorkspace } from "./client/terminal-targets.js";
import type { ContainerView, WorkspaceView } from "./client/card-protocol.js";

function row(containerName: string, workspaceSlug: string): ContainerView {
  return { containerName, workspaceSlug } as ContainerView;
}

function workspace(projectName: string): WorkspaceView {
  return { projectName, workspaceSlug: projectName } as WorkspaceView;
}

test("terminal container options are logical names only", () => {
  const containers = [
    row("default", "alpha"),
    row("dev", "alpha"),
    row("db", "beta"),
    // A podman name is never a valid target: the API rejects it.
    row("dsh-podman-alpha-default", "alpha"),
  ];
  assert.deepEqual(containerOptions(containers, "alpha"), ["dev"]);
  assert.deepEqual(containerOptions(containers, "beta"), ["db"]);
  assert.deepEqual(containerOptions(containers, "missing"), []);
  assert.deepEqual(containerOptions(containers, undefined), []);
});

test("the session workspace comes from the session cwd and has no fallback", () => {
  const workspaces = [workspace("alpha"), workspace("beta")];
  // The cwd wins over the first workspace.
  assert.equal(sessionWorkspace(workspaces, "/projects/beta/src", "/projects"), "beta");
  assert.equal(sessionWorkspace(workspaces, "/projects/alpha", "/projects"), "alpha");
  // A trailing slash on the projects root is tolerated.
  assert.equal(sessionWorkspace(workspaces, "/projects/alpha/src", "/projects/"), "alpha");
  // Everything else refuses rather than guessing: the caller reports it.
  assert.equal(sessionWorkspace(workspaces, "/projects", "/projects"), undefined);
  assert.equal(sessionWorkspace(workspaces, "/elsewhere", "/projects"), undefined);
  assert.equal(sessionWorkspace(workspaces, "/projects/gamma", "/projects"), undefined);
  assert.equal(sessionWorkspace(workspaces, undefined, "/projects"), undefined);
  assert.equal(sessionWorkspace(workspaces, "", "/projects"), undefined);
  // An empty snapshot is "still loading", also answered without a workspace.
  assert.equal(sessionWorkspace([], "/projects/alpha", "/projects"), undefined);
});
