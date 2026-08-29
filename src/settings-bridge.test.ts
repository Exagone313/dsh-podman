// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { installContainerSettings } from "./settings-bridge.js";

interface FakeScope {
  value: Record<string, unknown>;
  listeners: Array<(next: any, prev: any) => void>;
  update: (patch: object) => Promise<void>;
  watch: (
    callback: (next: any, prev: any) => void | Promise<void>,
  ) => () => void;
}

function fakeScope(initial: Record<string, unknown>): FakeScope {
  const scope: FakeScope = {
    value: { ...initial },
    listeners: [],
    async update(patch: object) {
      const prev = scope.value;
      scope.value = { ...scope.value, ...patch };
      for (const listener of [...scope.listeners]) {
        await listener(scope.value, prev);
      }
    },
    watch(callback) {
      scope.listeners.push(callback);
      return () => {
        scope.listeners = scope.listeners.filter(
          (listener) => listener !== callback,
        );
      };
    },
  };
  return scope;
}

function fakeContext(scope: FakeScope): any {
  return {
    inject(deps: string[], callback: (sctx: any) => void): void {
      assert.deepEqual(deps, ["settings"]);
      callback({
        settings: {
          register() {
            return scope;
          },
        },
      });
    },
  };
}

function baseValue(): Record<string, unknown> {
  return {
    defaultImage: "arch-base",
    socketsRoot: "/run/dsh-podman",
    projectsRoot: "/projects",
    notice: "",
    workspaces: [],
    containers: [],
    images: [],
    command: null,
  };
}

test("refresh on install publishes containers, images and workspaces", async () => {
  const scope = fakeScope(baseValue());
  const calls: Array<[string, unknown]> = [];
  const resolver: any = {
    getConfig: () => ({
      defaultImage: "arch-base",
      socketsRoot: "/run/dsh-podman",
      projectsRoot: "/projects",
    }),
    setConfig: () => {},
    async control(method: string, request: unknown) {
      calls.push([method, request]);
      if (method === "listContainers") {
        return { containers: [{ containerName: "c1", workspaceSlug: "w1" }] };
      }
      if (method === "listImages") {
        return { images: [{ imageId: "img1" }] };
      }
      if (method === "listWorkspaces") {
        return { workspaces: [{ workspaceSlug: "w1", mounts: [{ projectName: "team/app" }] }] };
      }
      return {};
    },
  };
  installContainerSettings(fakeContext(scope), resolver);
  await scope.update({}); // settle the queued async refresh
  assert.deepEqual(
    calls.map(([method]) => method),
    ["listContainers", "listImages", "listWorkspaces"],
  );
  assert.equal((scope.value.containers as any[]).length, 1);
  assert.equal((scope.value.images as any[]).length, 1);
  const workspaces = scope.value.workspaces as any[];
  assert.equal(workspaces.length, 1);
  assert.equal(workspaces[0].workspaceSlug, "w1");
  assert.equal(workspaces[0].projectName, "team/app");
});

test("remove command drives removeContainer and clears the command", async () => {
  const scope = fakeScope(baseValue());
  const calls: Array<[string, unknown]> = [];
  const resolver: any = {
    getConfig: () => ({}),
    setConfig: () => {},
    async control(method: string, request: unknown) {
      calls.push([method, request]);
      if (method === "listContainers") return { containers: [] };
      if (method === "listImages") return { images: [] };
      return {};
    },
  };
  installContainerSettings(fakeContext(scope), resolver);
  await scope.update({
    command: { op: "remove", workspace: "w1", image: "", at: 1 },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const removeCall = calls.find(([method]) => method === "removeContainer");
  assert.deepEqual(removeCall?.[1], { workspaceSlug: "w1" });
  assert.equal(scope.value.command, null);
});

test("recreate command is not re-run by the view refresh", async () => {
  const scope = fakeScope(baseValue());
  const recreateCalls: number[] = [];
  const resolver: any = {
    getConfig: () => ({}),
    setConfig: () => {},
    async control(method: string) {
      if (method === "recreateContainer") {
        recreateCalls.push(recreateCalls.length);
        return {};
      }
      if (method === "listContainers") return { containers: [] };
      if (method === "listImages") return { images: [] };
      return {};
    },
  };
  installContainerSettings(fakeContext(scope), resolver);
  await scope.update({
    command: { op: "recreate", workspace: "w1", image: "img2", at: 2 },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(recreateCalls.length, 1);
  assert.equal(scope.value.command, null);
});

test("create command drives createWorkspace with mounts and image", async () => {
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
  installContainerSettings(fakeContext(scope), resolver);
  await scope.update({
    command: {
      op: "create",
      workspace: "w1",
      image: "img1",
      at: 1,
      mounts: [{ projectName: "team", mode: "MOUNT_MODE_READ_WRITE" }],
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const createCall = calls.find(([method]) => method === "createWorkspace");
  assert.deepEqual(createCall?.[1], {
    workspaceSlug: "w1",
    imageId: "img1",
    mounts: [{ projectName: "team", mode: "MOUNT_MODE_READ_WRITE" }],
  });
  assert.equal(scope.value.command, null);
});

test("workspace list comes from the dsh registry even without orchestrator state", async () => {
  const scope = fakeScope(baseValue());
  const registry = {
    list: () => [
      { id: "uuid-1", path: "/projects/team/app", title: "app", createdAt: "2026-01-01T00:00:00Z" },
    ],
  };
  const resolver: any = {
    getConfig: () => ({
      defaultImage: "arch-base",
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
  installContainerSettings(fakeContext(scope), resolver, registry);
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
      { id: "uuid-1", path: "/projects/team/app", title: "app", createdAt: "2026-01-01T00:00:00Z" },
    ],
  };
  const resolver: any = {
    getConfig: () => ({
      defaultImage: "arch-base",
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
            workspaceSlug: "uuid-1",
            containerName: "dsh-workspace-uuid-1",
            imageId: "arch",
            status: "running",
            mounts: [{ projectName: "team/app", mode: "MOUNT_MODE_READ_WRITE" }],
          }],
        };
      }
      return {};
    },
  };
  installContainerSettings(fakeContext(scope), resolver, registry);
  await scope.update({});
  const workspaces = scope.value.workspaces as any[];
  assert.equal(workspaces.length, 1);
  assert.equal(workspaces[0].projectName, "team/app");
  assert.equal(workspaces[0].containerName, "dsh-workspace-uuid-1");
  assert.equal(workspaces[0].status, "running");
  assert.equal(workspaces[0].imageId, "arch");
});
