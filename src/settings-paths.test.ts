// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import { baseValue, fakeContext, fakeScope } from "./settings-bridge-support.js";
import { installContainerSettings } from "./settings-bridge.js";
import { WORKSPACE_ID } from "./test-support.js";

test("container_path_set command persists the list and pushes it to the guest", async () => {
  const scope = fakeScope(baseValue());
  const calls: Array<[string, unknown]> = [];
  const pushed: string[][] = [];
  const guest = {
    setPaths: (
      request: { paths: string[] },
      _metadata: unknown,
      callback: (error: Error | null, result: unknown) => void,
    ) => {
      pushed.push(request.paths);
      callback(null, { paths: request.paths });
    },
  };
  const binding = { guest, token: "t", socket: "/run/x.sock" };
  const resolver: any = {
    getConfig: () => ({}),
    setConfig: () => {},
    resolve: async () => binding,
    containerBinding: async () => binding,
    async control(method: string, request: unknown) {
      calls.push([method, request]);
      if (method === "listContainers") return { containers: [] };
      if (method === "listImages") return { images: [] };
      if (method === "listWorkspaces") return { workspaces: [] };
      return {};
    },
  };
  installContainerSettings(fakeContext(scope), resolver, {
    list: () => [{ id: WORKSPACE_ID, path: "/projects/team" }],
  });
  await scope.update({});
  await new Promise((resolve) => setImmediate(resolve));
  calls.length = 0;
  await scope.update({
    command: {
      op: "container_path_set",
      workspace: WORKSPACE_ID,
      container: "default",
      image: "",
      at: 1,
      paths: ["/opt/bin", "/usr/local/bin"],
      mounts: [],
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    calls
      .filter(([method]) => method === "setContainerPaths")
      .map(([, request]) => request),
    [
      {
        workspaceSlug: WORKSPACE_ID,
        container: "default",
        paths: ["/opt/bin", "/usr/local/bin"],
      },
    ],
  );
  assert.deepEqual(pushed, [["/opt/bin", "/usr/local/bin"]]);
  assert.equal(scope.value.command, null);
});
