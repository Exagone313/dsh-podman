// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
// Importing the client modules here also typechecks them under the host program,
// which has no DOM lib: they must stay environment-free.
import {
  PODMAN_CONTAINERS_KIND,
  PODMAN_CONTAINERS_TAB_ID,
  resolveContainersOpen,
} from "./client/containers-tab.js";
import {
  openPluginSettings,
  PLUGIN_PACKAGE,
  setPluginNavigation,
} from "./client/plugin-navigation.js";

test("the containers panel is its own tab type", () => {
  assert.equal(PODMAN_CONTAINERS_KIND, "podman-containers");
  assert.equal(
    PODMAN_CONTAINERS_TAB_ID,
    "@exagone313/dsh-podman#containers",
  );
  // The terminal owns the bundle's plain id; a second type must not collide on
  // the registration id or on the kind.
  assert.notEqual(PODMAN_CONTAINERS_TAB_ID, "@exagone313/dsh-podman");
  assert.notEqual(PODMAN_CONTAINERS_KIND, "podman-terminal");
});

test("the settings action opens this bundle's page", () => {
  const opened: string[] = [];
  setPluginNavigation({ openBundle: (name) => opened.push(name) });
  openPluginSettings();
  assert.deepEqual(opened, [PLUGIN_PACKAGE]);
  assert.equal(PLUGIN_PACKAGE, "@exagone313/dsh-podman");
  setPluginNavigation(undefined);
  // Without the service the action is a no-op, not a failed click.
  openPluginSettings();
  assert.deepEqual(opened, [PLUGIN_PACKAGE]);
});

test("the command opens the panel at its captured target", () => {
  const opened: Array<[string, string]> = [];
  const captured = { id: "pane-1" };
  const resolution = resolveContainersOpen({
    commandTarget: (target) => target === captured ? captured : undefined,
    openTabFromTarget: (kind, target) => opened.push([kind, target.id]),
  }, captured);
  assert.equal(resolution.status, "handled");
  if (resolution.status === "handled") resolution.run();
  assert.deepEqual(opened, [[PODMAN_CONTAINERS_KIND, "pane-1"]]);

  // No capturable session means the command reports why it was blocked.
  assert.deepEqual(
    resolveContainersOpen({
      commandTarget: () => undefined,
      openTabFromTarget: () => {},
    }, null),
    { status: "blocked" },
  );
});
