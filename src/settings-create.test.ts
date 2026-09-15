// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { fakeScope, fakeContext, baseValue } from "./settings-bridge-support.js";
import { installContainerSettings } from "./settings-bridge.js";

test("create command sends PATH additions", async () => {
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
      projectName: "w1",
      image: "img1",
      at: 1,
      mounts: [],
      paths: ["/opt/bin"],
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
    projectName: "w1",
    imageId: "img1",
    paths: ["/opt/bin"],
  });

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
      container: "dev",
      image: "img1",
      at: 2,
      mounts: [],
      paths: ["/opt/bin", "/usr/local/bin"],
      env: {},
      secretEnvMap: {},
      mount: null,
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const startCall = calls2.find(([method]) => method === "startContainer");
  assert.deepEqual(startCall?.[1], {
    workspaceSlug: "w1",
    imageId: "img1",
    container: "dev",
    paths: ["/opt/bin", "/usr/local/bin"],
  });
});

test("a re-delivered command is skipped but a new one still runs", async () => {
  const scope = fakeScope(baseValue());
  const calls: string[] = [];
  let releaseCreate!: () => void;
  const createGate = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });
  const resolver: any = {
    getConfig: () => ({}),
    setConfig: () => {},
    async control(method: string) {
      calls.push(method);
      if (method === "listContainers") return { containers: [] };
      if (method === "listImages") return { images: [] };
      if (method === "listWorkspaces") return { workspaces: [] };
      if (method === "createWorkspace") {
        await createGate;
        return {};
      }
      return {};
    },
  };
  installContainerSettings(fakeContext(scope), resolver);
  await scope.update({
    command: {
      op: "create",
      workspace: "w1",
      projectName: "w1",
      image: "img1",
      at: 1,
      mounts: [],
      env: {},
      container: "",
      secretEnvMap: {},
      mount: null,
    },
  });
  // The settings document keeps the command until the work finishes, so an
  // unrelated commit re-delivers it: it must not run a second time.
  await scope.update({ notice: "unrelated commit" });
  // A genuinely different command still runs while the first is in flight.
  await scope.update({
    command: { op: "remove", workspace: "w2", at: 2, mounts: [], env: {}, container: "", secretEnvMap: {}, mount: null },
  });
  releaseCreate();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.filter((method) => method === "createWorkspace").length, 1);
  assert.equal(calls.filter((method) => method === "removeContainer").length, 1);
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
      projectName: "w1",
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
    projectName: "w1",
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
      projectName: "w1",
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
    projectName: "w1",
    imageId: "img1",
  });
  assert.equal(scope2.value.command, null);
});
