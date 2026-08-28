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
    controlSocket: "/run/dsh-sockets/control.sock",
    projectsRoot: "/mnt/project",
    notice: "",
    containers: [],
    images: [],
    command: null,
  };
}

test("refresh on install publishes containers and images", async () => {
  const scope = fakeScope(baseValue());
  const calls: Array<[string, unknown]> = [];
  const resolver: any = {
    getConfig: () => ({
      defaultImage: "arch-base",
      controlSocket: "/run/dsh-sockets/control.sock",
      projectsRoot: "/mnt/project",
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
      return {};
    },
  };
  installContainerSettings(fakeContext(scope), resolver);
  await scope.update({}); // settle the queued async refresh
  assert.deepEqual(
    calls.map(([method]) => method),
    ["listContainers", "listImages"],
  );
  assert.equal((scope.value.containers as any[]).length, 1);
  assert.equal((scope.value.images as any[]).length, 1);
});

test("stop command drives stopWorkspace and clears the command", async () => {
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
    command: { op: "stop", workspace: "w1", image: "", at: 1 },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const stopCall = calls.find(([method]) => method === "stopWorkspace");
  assert.deepEqual(stopCall?.[1], { workspaceSlug: "w1" });
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
