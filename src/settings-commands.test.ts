// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  fakeScope,
  fakeContext,
  baseValue,
  installedMountScope,
  mountCommand,
} from "./settings-bridge-support.js";
import { installContainerSettings } from "./settings-bridge.js";

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

test("workspace_remove command drives removeWorkspace and clears the command", async () => {
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
    command: { op: "workspace_remove", workspace: "w1", image: "", at: 2 },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const removeCall = calls.find(([method]) => method === "removeWorkspace");
  assert.deepEqual(removeCall?.[1], { workspaceSlug: "w1" });
  assert.equal(scope.value.command, null);
});

test("cache_clean command drives cleanCaches, maps the mode, and reports the result", async () => {
  const scope = fakeScope(baseValue());
  const calls: Array<[string, unknown]> = [];
  const resolver: any = {
    getConfig: () => ({}),
    setConfig: () => {},
    async control(method: string, request: unknown) {
      calls.push([method, request]);
      if (method === "listContainers") return { containers: [] };
      if (method === "listImages") return { images: [] };
      if (method === "cleanCaches") return { removedFiles: 2, removedBytes: "2048" };
      if (method === "listCaches") {
        return { caches: [{ manager: "pacman", path: "/cache", files: 1, bytes: "1024" }] };
      }
      return {};
    },
  };
  installContainerSettings(fakeContext(scope), resolver);
  await scope.update({
    command: { op: "cache_clean", workspace: "", image: "", at: 3, cacheMode: "all" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  await scope.update({
    command: { op: "cache_clean", workspace: "", image: "", at: 4, cacheMode: "keep-latest" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const modes = calls
    .filter(([method]) => method === "cleanCaches")
    .map(([, request]) => (request as { mode: string }).mode);
  assert.deepEqual(modes, ["CACHE_CLEAN_MODE_ALL", "CACHE_CLEAN_MODE_KEEP_LATEST"]);
  assert.equal(scope.value.command, null);
  assert.equal(scope.value.notice, "removed 2 cached files");
  const caches = scope.value.caches as any[];
  assert.equal(caches.length, 1);
  assert.equal(caches[0].manager, "pacman");
  // The control plane reports int64 as a string.
  assert.equal(caches[0].bytes, 1024);
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
      projectName: "team",
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
    projectName: "team",
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
