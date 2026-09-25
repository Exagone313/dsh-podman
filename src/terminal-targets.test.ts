// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import { containerOptions, validContainer, validShell } from "./client/terminal-targets.js";
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

test("remembered targets are reused only while they are still offered", () => {
  // Containers: the default answer is the workspace's own default.
  assert.equal(validContainer(undefined, ["dev"]), "");
  assert.equal(validContainer("", ["dev"]), "");
  assert.equal(validContainer("dev", ["dev"]), "dev");
  assert.equal(validContainer("gone", ["dev"]), "");

  // Shells: a recreated container may no longer offer the remembered path.
  const shells = [{ name: "bash", path: "/usr/bin/bash" }];
  assert.equal(validShell(undefined, shells), undefined);
  assert.equal(validShell("", shells), undefined);
  assert.equal(validShell("/usr/bin/bash", shells), "/usr/bin/bash");
  assert.equal(validShell("/bin/zsh", shells), undefined);
});
