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
    defaultImage: "archlinux",
    socketsRoot: "/run/dsh-podman",
    notice: "",
    workspaces: [],
    containers: [],
    images: [],
    volumes: [],
    secrets: [],
    command: null,
  };
}

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
  installContainerSettings(fakeContext(scope), resolver);
  await scope.update({}); // settle the queued async refresh
  assert.deepEqual(
    calls.map(([method]) => method),
    ["listContainers", "listImages", "listWorkspaces", "listVolumes", "listSecrets"],
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
    command: { op: "recreate", workspace: "w1", image: "img2", at: 2, env: {} },
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
      mounts: [{ kind: "project", project: "team", mode: "read_write", path: "", destination: "", volume: "", secret: "" }],
      env: {},
      container: "",
      secretEnvMap: {},
      mount: null,
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const createCall = calls.find(([method]) => method === "createWorkspace");
  assert.deepEqual(createCall?.[1], {
    workspaceSlug: "w1",
    imageId: "img1",
    mounts: [{ projectName: "team", kind: "MOUNT_KIND_PROJECT", mode: "MOUNT_MODE_READ_WRITE" }],
  });
  assert.equal(scope.value.command, null);
});

test("volume_create command drives createVolume with the name", async () => {
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
      if (method === "listVolumes") return { volumes: [] };
      return {};
    },
  };
  installContainerSettings(fakeContext(scope), resolver);
  await scope.update({
    command: { op: "volume_create", workspace: "data", image: "", at: 3 },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const createCall = calls.find(([method]) => method === "createVolume");
  assert.deepEqual(createCall?.[1], { name: "data" });
  assert.equal(scope.value.command, null);
});

test("volume_remove command drives removeVolume with the name", async () => {
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
      if (method === "listVolumes") return { volumes: [] };
      return {};
    },
  };
  installContainerSettings(fakeContext(scope), resolver);
  await scope.update({
    command: { op: "volume_remove", workspace: "cache", image: "", at: 4 },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const removeCall = calls.find(([method]) => method === "removeVolume");
  assert.deepEqual(removeCall?.[1], { name: "cache" });
  assert.equal(scope.value.command, null);
});

test("image_remove command drives removeImage with the imageId", async () => {
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
      if (method === "listVolumes") return { volumes: [] };
      return {};
    },
  };
  installContainerSettings(fakeContext(scope), resolver);
  await scope.update({
    command: { op: "image_remove", workspace: "valkey", image: "", at: 5 },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const removeCall = calls.find(([method]) => method === "removeImage");
  assert.deepEqual(removeCall?.[1], { imageId: "valkey" });
  assert.equal(scope.value.command, null);
});

test("secret_create command drives createSecret with the name", async () => {
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
      if (method === "listVolumes") return { volumes: [] };
      if (method === "listSecrets") return { secrets: [] };
      return {};
    },
  };
  installContainerSettings(fakeContext(scope), resolver);
  await scope.update({
    command: { op: "secret_create", workspace: "db-pass", image: "", at: 6, mounts: [], value: "" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const createCall = calls.find(([method]) => method === "createSecret");
  assert.deepEqual(createCall?.[1], { name: "db-pass" });
  assert.equal(scope.value.command, null);
});

test("secret_remove command drives removeSecret with the name", async () => {
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
      if (method === "listVolumes") return { volumes: [] };
      if (method === "listSecrets") return { secrets: [] };
      return {};
    },
  };
  installContainerSettings(fakeContext(scope), resolver);
  await scope.update({
    command: { op: "secret_remove", workspace: "db-pass", image: "", at: 7, mounts: [], value: "" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const removeCall = calls.find(([method]) => method === "removeSecret");
  assert.deepEqual(removeCall?.[1], { name: "db-pass" });
  assert.equal(scope.value.command, null);
});

test("secret_set command drives writeSecretValue with the name and value", async () => {
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
      if (method === "listVolumes") return { volumes: [] };
      if (method === "listSecrets") return { secrets: [] };
      return {};
    },
  };
  installContainerSettings(fakeContext(scope), resolver);
  await scope.update({
    command: { op: "secret_set", workspace: "db-pass", image: "", at: 8, mounts: [], value: "s3cr3t" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const setCall = calls.find(([method]) => method === "writeSecretValue");
  assert.deepEqual(setCall?.[1], { name: "db-pass", value: "s3cr3t" });
  assert.equal(scope.value.command, null);
});

test("image_rebuild command drives rebuildImage with the imageId", async () => {
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
      if (method === "listVolumes") return { volumes: [] };
      if (method === "listSecrets") return { secrets: [] };
      return {};
    },
  };
  installContainerSettings(fakeContext(scope), resolver);
  await scope.update({
    command: { op: "image_rebuild", workspace: "valkey", image: "", at: 9 },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const rebuildCall = calls.find(([method]) => method === "rebuildImage");
  assert.deepEqual(rebuildCall?.[1], { imageId: "valkey" });
  assert.equal(scope.value.command, null);
});

test("image_rebuild_all command drives rebuildAllImages with an empty payload", async () => {
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
      if (method === "listVolumes") return { volumes: [] };
      if (method === "listSecrets") return { secrets: [] };
      return {};
    },
  };
  installContainerSettings(fakeContext(scope), resolver);
  await scope.update({
    command: { op: "image_rebuild_all", workspace: "", image: "", at: 10 },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const rebuildCall = calls.find(([method]) => method === "rebuildAllImages");
  assert.deepEqual(rebuildCall?.[1], {});
  assert.equal(scope.value.command, null);
});

test("image_base_rebuild command drives rebuildBaseImage with the name", async () => {
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
      if (method === "listVolumes") return { volumes: [] };
      if (method === "listSecrets") return { secrets: [] };
      return {};
    },
  };
  installContainerSettings(fakeContext(scope), resolver);
  await scope.update({
    command: { op: "image_base_rebuild", workspace: "archlinux", image: "", at: 21 },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const rebuildCall = calls.find(([method]) => method === "rebuildBaseImage");
  assert.deepEqual(rebuildCall?.[1], { name: "archlinux" });
  assert.equal(scope.value.command, null);
});

test("image_base_pull command drives pullBaseImage with the name", async () => {
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
      if (method === "listVolumes") return { volumes: [] };
      if (method === "listSecrets") return { secrets: [] };
      return {};
    },
  };
  installContainerSettings(fakeContext(scope), resolver);
  await scope.update({
    command: { op: "image_base_pull", workspace: "archlinux", image: "", at: 22 },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const pullCall = calls.find(([method]) => method === "pullBaseImage");
  assert.deepEqual(pullCall?.[1], { name: "archlinux" });
  assert.equal(scope.value.command, null);
});

test("handle never writes projectsRoot into setConfig", async () => {
  const scope = fakeScope(baseValue());
  const setConfigCalls: Array<Record<string, unknown>> = [];
  const resolver: any = {
    getConfig: () => ({}),
    setConfig: (patch: Record<string, unknown>) => setConfigCalls.push(patch),
    async control(method: string) {
      if (method === "listContainers") return { containers: [] };
      if (method === "listImages") return { images: [] };
      if (method === "listWorkspaces") return { workspaces: [] };
      return {};
    },
  };
  installContainerSettings(fakeContext(scope), resolver);
  await scope.update({});
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(setConfigCalls.length > 0, "handle must write resolver config");
  for (const patch of setConfigCalls) {
    assert.ok(
      !Object.prototype.hasOwnProperty.call(patch, "projectsRoot"),
      "projectsRoot must not be written via setConfig",
    );
  }
});

test("settings seed projectsRoot from the resolver config", async () => {
  let registeredBase: Record<string, unknown> | undefined;
  const scope = fakeScope(baseValue());
  const context: any = {
    inject(deps: string[], callback: (sctx: any) => void): void {
      assert.deepEqual(deps, ["settings"]);
      callback({
        settings: {
          register(
            _namespace: string,
            _schema: unknown,
            options: { base?: Record<string, unknown> },
          ) {
            registeredBase = options?.base ?? {};
            return scope;
          },
        },
      });
    },
  };
  const resolver: any = {
    getConfig: () => ({
      defaultImage: "archlinux",
      socketsRoot: "/run/dsh-podman",
      projectsRoot: "/projects",
    }),
    setConfig: () => {},
    async control() {
      return {};
    },
  };
  installContainerSettings(context, resolver);
  assert.equal(registeredBase?.projectsRoot, "/projects");
});

test("image_build command drives buildImage with the imageId, parent and packages", async () => {
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
      if (method === "listVolumes") return { volumes: [] };
      if (method === "listSecrets") return { secrets: [] };
      return {};
    },
  };
  installContainerSettings(fakeContext(scope), resolver);
  await scope.update({
    command: {
      op: "image_build",
      workspace: "valkey",
      image: "archlinux",
      packages: ["valkey", "git"],
      at: 20,
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const buildCall = calls.find(([method]) => method === "buildImage");
  assert.deepEqual(buildCall?.[1], {
    imageId: "valkey",
    parent: "archlinux",
    packages: ["valkey", "git"],
  });
  assert.equal(scope.value.command, null);
});

test("secret_create command drives createSecret with length when provided", async () => {
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
      if (method === "listVolumes") return { volumes: [] };
      if (method === "listSecrets") return { secrets: [] };
      return {};
    },
  };
  installContainerSettings(fakeContext(scope), resolver);
  await scope.update({
    command: { op: "secret_create", workspace: "s", image: "", at: 11, length: 48 },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const createCall = calls.find(([method]) => method === "createSecret");
  assert.deepEqual(createCall?.[1], { name: "s", length: 48 });
  assert.equal(scope.value.command, null);
});

test("secret_create command drives createSecret without length when omitted", async () => {
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
      if (method === "listVolumes") return { volumes: [] };
      if (method === "listSecrets") return { secrets: [] };
      return {};
    },
  };
  installContainerSettings(fakeContext(scope), resolver);
  await scope.update({
    command: { op: "secret_create", workspace: "s", image: "", at: 12 },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const createCall = calls.find(([method]) => method === "createSecret");
  assert.deepEqual(createCall?.[1], { name: "s" });
  assert.equal(scope.value.command, null);
});

test("secret_create command drives createSecret with charset when provided", async () => {
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
      if (method === "listVolumes") return { volumes: [] };
      if (method === "listSecrets") return { secrets: [] };
      return {};
    },
  };
  installContainerSettings(fakeContext(scope), resolver);
  await scope.update({
    command: { op: "secret_create", workspace: "tok", length: 48, charset: "hex" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const createCall = calls.find(([method]) => method === "createSecret");
  assert.deepEqual(createCall?.[1], { name: "tok", length: 48, charset: "hex" });
  assert.equal(scope.value.command, null);
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
  installContainerSettings(fakeContext(scope), resolver);
  await scope.update({
    command: {
      op: "create",
      workspace: "w1",
      image: "img1",
      at: 13,
      mounts: [],
      env: { A: "1", B: "2" },
      container: "",
      secretEnvMap: {},
      mount: null,
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const createCall = calls.find(([method]) => method === "createWorkspace");
  assert.deepEqual(createCall?.[1], {
    workspaceSlug: "w1",
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
  installContainerSettings(fakeContext(scope), resolver);
  await scope.update({
    command: {
      op: "create",
      workspace: "w1",
      image: "img1",
      at: 14,
      mounts: [],
      env: {},
      container: "",
      secretEnvMap: {},
      mount: null,
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const createCall = calls.find(([method]) => method === "createWorkspace");
  assert.deepEqual(createCall?.[1], {
    workspaceSlug: "w1",
    imageId: "img1",
  });
  assert.equal(scope.value.command, null);
});

test("recreate command drives recreateContainer with env", async () => {
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
      op: "recreate",
      workspace: "w1",
      image: "img2",
      at: 15,
      env: { A: "1" },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const recreateCall = calls.find(([method]) => method === "recreateContainer");
  assert.deepEqual(recreateCall?.[1], {
    workspaceSlug: "w1",
    imageId: "img2",
    env: { A: "1" },
  });
  assert.equal(scope.value.command, null);
});

test("container_secret_add command drives addContainerSecret with env and secret", async () => {
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
      if (method === "listVolumes") return { volumes: [] };
      if (method === "listSecrets") return { secrets: [] };
      return {};
    },
  };
  installContainerSettings(fakeContext(scope), resolver);
  await scope.update({
    command: {
      op: "container_secret_add",
      workspace: "w",
      container: "web",
      secret: "tok",
      secretEnv: "TOKEN",
      image: "",
      at: 16,
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const addCall = calls.find(([method]) => method === "addContainerSecret");
  assert.deepEqual(addCall?.[1], {
    workspaceSlug: "w",
    container: "web",
    env: "TOKEN",
    secret: "tok",
  });
  assert.equal(scope.value.command, null);
});

test("container_secret_add command uses the default container when omitted", async () => {
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
      if (method === "listVolumes") return { volumes: [] };
      if (method === "listSecrets") return { secrets: [] };
      return {};
    },
  };
  installContainerSettings(fakeContext(scope), resolver);
  await scope.update({
    command: {
      op: "container_secret_add",
      workspace: "w",
      container: "",
      secret: "tok",
      secretEnv: "TOKEN",
      image: "",
      at: 17,
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const addCall = calls.find(([method]) => method === "addContainerSecret");
  assert.deepEqual(addCall?.[1], {
    workspaceSlug: "w",
    container: "default",
    env: "TOKEN",
    secret: "tok",
  });
  assert.equal(scope.value.command, null);
});

test("container_secret_remove command drives removeContainerSecret with the default container", async () => {
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
      if (method === "listVolumes") return { volumes: [] };
      if (method === "listSecrets") return { secrets: [] };
      return {};
    },
  };
  installContainerSettings(fakeContext(scope), resolver);
  await scope.update({
    command: {
      op: "container_secret_remove",
      workspace: "w",
      container: "",
      secretEnv: "TOKEN",
      image: "",
      at: 18,
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const removeCall = calls.find(([method]) => method === "removeContainerSecret");
  assert.deepEqual(removeCall?.[1], {
    workspaceSlug: "w",
    container: "default",
    env: "TOKEN",
  });
  assert.equal(scope.value.command, null);
});

test("workspace list comes from the dsh registry even without orchestrator state", async () => {  const scope = fakeScope(baseValue());
  const registry = {
    list: () => [
      { id: "uuid-1", path: "/projects/team/app", title: "app", createdAt: "2026-01-01T00:00:00Z" },
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

test("create command with a container name routes to startContainer", async () => {
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
      container: "dev",
      image: "img1",
      at: 1,
      mounts: [],
      env: {},
      secretEnvMap: {},
      mount: null,
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const startCall = calls.find(([method]) => method === "startContainer");
  assert.deepEqual(startCall?.[1], {
    workspaceSlug: "w1",
    imageId: "img1",
    container: "dev",
  });
  assert.equal(
    calls.some(([method]) => method === "createWorkspace"),
    false,
    "a create command with a container name must not create a workspace",
  );
  assert.equal(scope.value.command, null);
});

test("create command sends secret env", async () => {
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
      mounts: [],
      env: {},
      container: "",
      secretEnvMap: { VALKEY_PASSWORD: "valkey-tls" },
      mount: null,
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const createCall = calls.find(([method]) => method === "createWorkspace");
  assert.deepEqual(createCall?.[1], {
    workspaceSlug: "w1",
    imageId: "img1",
    secretEnv: { VALKEY_PASSWORD: "valkey-tls" },
  });
  assert.equal(scope.value.command, null);

  const calls2: Array<[string, unknown]> = [];
  const resolver2: any = {
    getConfig: () => ({}),
    setConfig: () => {},
    async control(method: string, request: unknown) {
      calls2.push([method, request]);
      if (method === "listContainers") return { containers: [] };
      if (method === "listImages") return { images: [] };
      if (method === "listWorkspaces") return { workspaces: [] };
      return {};
    },
  };
  const scope2 = fakeScope(baseValue());
  installContainerSettings(fakeContext(scope2), resolver2);
  await scope2.update({
    command: {
      op: "create",
      workspace: "w1",
      image: "img1",
      at: 2,
      mounts: [],
      env: {},
      container: "",
      secretEnvMap: {},
      mount: null,
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const createCall2 = calls2.find(([method]) => method === "createWorkspace");
  assert.deepEqual(createCall2?.[1], {
    workspaceSlug: "w1",
    imageId: "img1",
  });
  assert.equal(scope2.value.command, null);
});

test("container_mount_add command drives addContainerMount for each kind", async () => {
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
      op: "container_mount_add",
      workspace: "w1",
      container: "web",
      image: "",
      at: 1,
      mount: {
        kind: "project",
        project: "team",
        path: "src",
        destination: "/workspace/team",
        mode: "read_only",
        volume: "",
        secret: "",
      },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  await scope.update({
    command: {
      op: "container_mount_add",
      workspace: "w1",
      container: "web",
      image: "",
      at: 2,
      mount: {
        kind: "volume",
        project: "",
        path: "",
        destination: "/data",
        mode: "read_write",
        volume: "valkey-data",
        secret: "",
      },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  await scope.update({
    command: {
      op: "container_mount_add",
      workspace: "w1",
      container: "web",
      image: "",
      at: 3,
      mount: {
        kind: "tmpfs",
        project: "",
        path: "",
        destination: "/dev/shm",
        mode: "read_write",
        volume: "",
        secret: "",
      },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  await scope.update({
    command: {
      op: "container_mount_add",
      workspace: "w1",
      container: "",
      image: "",
      at: 4,
      mount: {
        kind: "secret",
        project: "",
        path: "",
        destination: "/run/secrets/tls",
        mode: "read_write",
        volume: "",
        secret: "valkey-tls",
      },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const addCalls = calls.filter(([method]) => method === "addContainerMount");
  assert.deepEqual(addCalls.map(([, request]) => request), [
    {
      workspaceSlug: "w1",
      container: "web",
      kind: "MOUNT_KIND_PROJECT",
      project: "team",
      path: "src",
      mode: "MOUNT_MODE_READ_ONLY",
    },
    {
      workspaceSlug: "w1",
      container: "web",
      kind: "MOUNT_KIND_VOLUME",
      volume: "valkey-data",
      destination: "/data",
      mode: "MOUNT_MODE_READ_WRITE",
    },
    {
      workspaceSlug: "w1",
      container: "web",
      kind: "MOUNT_KIND_TMPFS",
      destination: "/dev/shm",
      mode: "MOUNT_MODE_READ_WRITE",
    },
    {
      workspaceSlug: "w1",
      container: "default",
      kind: "MOUNT_KIND_SECRET",
      secret: "valkey-tls",
      destination: "/run/secrets/tls",
    },
  ]);
  assert.equal(scope.value.command, null);
});

test("container_mount_remove command drives removeContainerMount for each kind", async () => {
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
      op: "container_mount_remove",
      workspace: "w1",
      container: "web",
      image: "",
      at: 1,
      mount: {
        kind: "project",
        project: "team",
        path: "src",
        destination: "/workspace/team",
        mode: "read_write",
        volume: "",
        secret: "",
      },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  await scope.update({
    command: {
      op: "container_mount_remove",
      workspace: "w1",
      container: "web",
      image: "",
      at: 2,
      mount: {
        kind: "volume",
        project: "",
        path: "",
        destination: "",
        mode: "read_write",
        volume: "valkey-data",
        secret: "",
      },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  await scope.update({
    command: {
      op: "container_mount_remove",
      workspace: "w1",
      container: "",
      image: "",
      at: 3,
      mount: {
        kind: "tmpfs",
        project: "",
        path: "",
        destination: "/dev/shm",
        mode: "read_write",
        volume: "",
        secret: "",
      },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  await scope.update({
    command: {
      op: "container_mount_remove",
      workspace: "w1",
      container: "web",
      image: "",
      at: 4,
      mount: {
        kind: "secret",
        project: "",
        path: "",
        destination: "/run/secrets/tls",
        mode: "read_write",
        volume: "",
        secret: "valkey-tls",
      },
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const removeCalls = calls.filter(([method]) => method === "removeContainerMount");
  assert.deepEqual(removeCalls.map(([, request]) => request), [
    {
      workspaceSlug: "w1",
      container: "web",
      kind: "MOUNT_KIND_PROJECT",
      project: "team",
      path: "src",
    },
    {
      workspaceSlug: "w1",
      container: "web",
      kind: "MOUNT_KIND_VOLUME",
      volume: "valkey-data",
    },
    {
      workspaceSlug: "w1",
      container: "default",
      kind: "MOUNT_KIND_TMPFS",
      destination: "/dev/shm",
    },
    {
      workspaceSlug: "w1",
      container: "web",
      kind: "MOUNT_KIND_SECRET",
      secret: "valkey-tls",
      destination: "/run/secrets/tls",
    },
  ]);
  assert.equal(scope.value.command, null);
});

async function installedMountScope(): Promise<{
  scope: FakeScope;
  calls: Array<[string, unknown]>;
}> {
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
  await scope.update({}); // settle the queued async refresh
  await new Promise((resolve) => setImmediate(resolve));
  calls.length = 0;
  return { scope, calls };
}

function mountCommand(
  op: string,
  mount: Record<string, string>,
): Record<string, unknown> {
  return {
    op,
    workspace: "w1",
    container: "web",
    image: "",
    at: 1,
    mount: {
      kind: "",
      project: "",
      path: "",
      destination: "",
      mode: "",
      volume: "",
      secret: "",
      ...mount,
    },
  };
}

test("container_mount_add command reports an unknown kind as a notice", async () => {
  const { scope, calls } = await installedMountScope();
  await scope.update({
    command: mountCommand("container_mount_add", {
      kind: "bind",
      project: "team",
      mode: "read_write",
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scope.value.notice, "unknown mount kind: bind");
  assert.equal(scope.value.command, null);
  assert.equal(
    calls.some(([method]) => method === "addContainerMount"),
    false,
    "a rejected mount must not reach the orchestrator",
  );
});

test("container_mount_add command reports an unknown mode as a notice", async () => {
  const { scope, calls } = await installedMountScope();
  await scope.update({
    command: mountCommand("container_mount_add", {
      kind: "project",
      project: "team",
      mode: "rw",
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scope.value.notice, "unknown mount mode: rw");
  assert.equal(scope.value.command, null);
  assert.equal(
    calls.some(([method]) => method === "addContainerMount"),
    false,
    "a rejected mount must not reach the orchestrator",
  );
});

test("container_mount_remove command reports an unknown kind as a notice", async () => {
  const { scope, calls } = await installedMountScope();
  await scope.update({
    command: mountCommand("container_mount_remove", {
      kind: "bind",
      project: "team",
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scope.value.notice, "unknown mount kind: bind");
  assert.equal(scope.value.command, null);
  assert.equal(
    calls.some(([method]) => method === "removeContainerMount"),
    false,
    "a rejected mount must not reach the orchestrator",
  );
});

test("create command reports an unknown mount kind as a notice", async () => {
  const { scope, calls } = await installedMountScope();
  await scope.update({
    command: {
      op: "create",
      workspace: "w1",
      image: "",
      at: 1,
      mounts: [{
        kind: "bind",
        project: "team",
        path: "",
        destination: "",
        mode: "read_write",
        volume: "",
        secret: "",
      }],
      env: {},
      container: "",
      secretEnvMap: {},
      mount: null,
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scope.value.notice, "unknown mount kind: bind");
  assert.equal(scope.value.command, null);
  assert.equal(
    calls.some(([method]) => method === "createWorkspace"),
    false,
    "a rejected mount must not reach the orchestrator",
  );
});

test("create command reports an unknown mount mode as a notice", async () => {
  const { scope, calls } = await installedMountScope();
  await scope.update({
    command: {
      op: "create",
      workspace: "w1",
      image: "",
      at: 1,
      mounts: [{
        kind: "project",
        project: "team",
        path: "",
        destination: "",
        mode: "rw",
        volume: "",
        secret: "",
      }],
      env: {},
      container: "",
      secretEnvMap: {},
      mount: null,
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scope.value.notice, "unknown mount mode: rw");
  assert.equal(scope.value.command, null);
  assert.equal(
    calls.some(([method]) => method === "createWorkspace"),
    false,
    "a rejected mount must not reach the orchestrator",
  );
});

test("unset kind and mode strings map to project and read_only", async () => {
  const { scope, calls } = await installedMountScope();
  await scope.update({
    command: mountCommand("container_mount_add", { project: "team" }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  await scope.update({
    command: {
      op: "create",
      workspace: "w1",
      image: "",
      at: 2,
      mounts: [{
        kind: "",
        project: "team",
        path: "",
        destination: "",
        mode: "",
        volume: "",
        secret: "",
      }],
      env: {},
      container: "",
      secretEnvMap: {},
      mount: null,
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const addCall = calls.find(([method]) => method === "addContainerMount");
  assert.deepEqual(addCall?.[1], {
    workspaceSlug: "w1",
    container: "web",
    kind: "MOUNT_KIND_PROJECT",
    project: "team",
    mode: "MOUNT_MODE_READ_ONLY",
  });
  const createCall = calls.find(([method]) => method === "createWorkspace");
  assert.deepEqual(createCall?.[1], {
    workspaceSlug: "w1",
    imageId: undefined,
    mounts: [{
      projectName: "team",
      kind: "MOUNT_KIND_PROJECT",
      mode: "MOUNT_MODE_READ_ONLY",
    }],
  });
  assert.equal(scope.value.notice, "");
  assert.equal(scope.value.command, null);
});

test("listContainers container mounts carry the raw proto fields", async () => {
  const scope = fakeScope(baseValue());
  const resolver: any = {
    getConfig: () => ({}),
    setConfig: () => {},
    async control(method: string) {
      if (method === "listContainers") {
        return {
          containers: [{
            containerName: "c1",
            workspaceSlug: "w1",
            mounts: [{
              projectName: "team",
              path: "src",
              destination: "/x",
              kind: "MOUNT_KIND_PROJECT",
              mode: "MOUNT_MODE_READ_WRITE",
              volume: "",
              secret: "",
            }],
          }],
        };
      }
      if (method === "listImages") return { images: [] };
      if (method === "listWorkspaces") return { workspaces: [] };
      return {};
    },
  };
  installContainerSettings(fakeContext(scope), resolver);
  await scope.update({});
  assert.deepEqual((scope.value.containers as any[])[0].mounts[0], {
    projectName: "team",
    path: "src",
    destination: "/x",
    kind: "MOUNT_KIND_PROJECT",
    mode: "MOUNT_MODE_READ_WRITE",
    volume: "",
    secret: "",
  });
});
