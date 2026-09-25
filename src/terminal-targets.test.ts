// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import { containerOptions } from "./client/terminal-targets.js";
import type { ContainerView } from "./client/card-protocol.js";

function row(containerName: string, workspaceSlug: string): ContainerView {
  return { containerName, workspaceSlug } as ContainerView;
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
