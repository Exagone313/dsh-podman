// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { baseValue, fakeContext, fakeScope } from "./card-test-support.js";
import { installCardCommandDriver } from "./card-test-support.js";
import { WORKSPACE_ID } from "./test-support.js";

test("refresh on install publishes containers, images and workspaces", async () => {
  const scope = fakeScope(baseValue());
  const calls: Array<[string, unknown]> = [];
  const resolver: any = {
    getConfig: () => ({
      defaultImage: "archlinux",
      socketsRoot: "/run/dsh-podman",
      projectsRoot: "/projects",
    }),
    setConfig: () => {},
    async control(method: string, request: unknown) {
      calls.push([method, request]);
      if (method === "getVersion") return { version: "0.2.0", commit: "abc" };
      if (method === "listContainers") {
        return { containers: [{ containerName: "c1", workspaceSlug: "w1" }] };
      }
      if (method === "listImages") {
        return { images: [{ imageId: "img1" }] };
      }
      if (method === "listWorkspaces") {
        return { workspaces: [{ workspaceSlug: "w1", mounts: [{ projectName: "team/app" }] }] };
      }
      if (method === "listVolumes") {
        return { volumes: [{ name: "data" }, { name: "cache" }] };
      }
      if (method === "listSecrets") {
        return { secrets: [{ name: "db-pass" }, { name: "api-key" }] };
      }
      return {};
    },
  };
  await installCardCommandDriver(fakeContext(scope), resolver);
  await scope.update({}); // settle the queued async refresh
  assert.deepEqual(
    calls.map(([method]) => method),
    [
      "getVersion",
      "listContainers",
      "listImages",
      "listWorkspaces",
      "listVolumes",
      "listSecrets",
      "listCaches",
    ],
  );
  assert.equal((scope.value.containers as any[]).length, 1);
  assert.equal((scope.value.images as any[]).length, 1);
  const workspaces = scope.value.workspaces as any[];
  assert.equal(workspaces.length, 1);
  assert.equal(workspaces[0].workspaceSlug, "w1");
  assert.equal(workspaces[0].projectName, "team/app");
  assert.deepEqual(scope.value.volumes, [{ name: "data" }, { name: "cache" }]);
  assert.deepEqual(scope.value.secrets, [{ name: "db-pass" }, { name: "api-key" }]);
});

test("create command drives createWorkspace with env", async () => {
  const scope = fakeScope(baseValue());
  const calls: Array<[string, unknown]> = [];
  const resolver: any = {
    getConfig: () => ({}),
    setConfig: () => {},
    async control(method: string, request: unknown) {
      calls.push([method, request]);
      if (method === "listContainers") return { containers: [] };
      if (method === "listImages") return { images: [] };
      if (method === "listWorkspaces") return { workspaces: [] };
      return {};
    },
  };
  await installCardCommandDriver(fakeContext(scope), resolver);
  await scope.update({
    command: {
      op: "create",
      workspace: "w1",
      projectName: "w1",
      image: "img1",
      at: 13,
      mounts: [],
      env: { A: "1", B: "2" },
      container: "",
      secretEnv: {},
      mount: null,
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const createCall = calls.find(([method]) => method === "createWorkspace");
  assert.deepEqual(createCall?.[1], {
    workspaceSlug: "w1",
    projectName: "w1",
    imageId: "img1",
    env: { A: "1", B: "2" },
  });
  assert.equal(scope.value.command, null);
});

test("create command drives createWorkspace without env when empty", async () => {
  const scope = fakeScope(baseValue());
  const calls: Array<[string, unknown]> = [];
  const resolver: any = {
    getConfig: () => ({}),
    setConfig: () => {},
    async control(method: string, request: unknown) {
      calls.push([method, request]);
      if (method === "listContainers") return { containers: [] };
      if (method === "listImages") return { images: [] };
      if (method === "listWorkspaces") return { workspaces: [] };
      return {};
    },
  };
  await installCardCommandDriver(fakeContext(scope), resolver);
  await scope.update({
    command: {
      op: "create",
      workspace: "w1",
      projectName: "w1",
      image: "img1",
      at: 14,
      mounts: [],
      env: {},
      container: "",
      secretEnv: {},
      mount: null,
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const createCall = calls.find(([method]) => method === "createWorkspace");
  assert.deepEqual(createCall?.[1], {
    workspaceSlug: "w1",
    projectName: "w1",
    imageId: "img1",
  });
  assert.equal(scope.value.command, null);
});

test("workspace list comes from the dsh registry even without orchestrator state", async () => {
  const scope = fakeScope(baseValue());
  const registry = {
    list: () => [
      {
        id: WORKSPACE_ID,
        path: "/projects/team/app",
        title: "app",
        createdAt: "2026-01-01T00:00:00Z",
      },
    ],
  };
  const resolver: any = {
    getConfig: () => ({
      defaultImage: "archlinux",
      socketsRoot: "/run/dsh-podman",
      projectsRoot: "/projects",
    }),
    setConfig: () => {},
    async control(method: string) {
      if (method === "listContainers") return { containers: [] };
      if (method === "listImages") return { images: [] };
      if (method === "listWorkspaces") return { workspaces: [] };
      return {};
    },
  };
  await installCardCommandDriver(fakeContext(scope), resolver, registry);
  await scope.update({});
  const workspaces = scope.value.workspaces as any[];
  assert.equal(workspaces.length, 1);
  assert.equal(workspaces[0].projectName, "team/app");
  assert.equal(workspaces[0].containerName, "");
  assert.deepEqual(workspaces[0].mounts, [
    { projectName: "team/app", mode: "MOUNT_MODE_READ_WRITE" },
  ]);
  assert.ok(workspaces[0].workspaceSlug.length > 0);
});

test("dsh workspace layers orchestrator container info", async () => {
  const scope = fakeScope(baseValue());
  const registry = {
    list: () => [
      {
        id: WORKSPACE_ID,
        path: "/projects/team/app",
        title: "app",
        createdAt: "2026-01-01T00:00:00Z",
      },
    ],
  };
  const resolver: any = {
    getConfig: () => ({
      defaultImage: "archlinux",
      socketsRoot: "/run/dsh-podman",
      projectsRoot: "/projects",
    }),
    setConfig: () => {},
    async control(method: string) {
      if (method === "listContainers") return { containers: [] };
      if (method === "listImages") return { images: [] };
      if (method === "listWorkspaces") {
        return {
          workspaces: [{
            workspaceSlug: WORKSPACE_ID,
            containerName: `dsh-podman-${WORKSPACE_ID}-default`,
            imageId: "arch",
            status: "running",
            mounts: [{ projectName: "team/app", mode: "MOUNT_MODE_READ_WRITE" }],
          }],
        };
      }
      return {};
    },
  };
  await installCardCommandDriver(fakeContext(scope), resolver, registry);
  await scope.update({});
  const workspaces = scope.value.workspaces as any[];
  assert.equal(workspaces.length, 1);
  assert.equal(workspaces[0].projectName, "team/app");
  assert.equal(workspaces[0].containerName, `dsh-podman-${WORKSPACE_ID}-default`);
  assert.equal(workspaces[0].status, "running");
  assert.equal(workspaces[0].imageId, "arch");
});
