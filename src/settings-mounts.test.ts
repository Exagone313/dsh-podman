// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  baseValue,
  fakeContext,
  fakeScope,
  installedMountScope,
  mountCommand,
} from "./settings-bridge-support.js";
import { installContainerSettings } from "./settings-bridge.js";

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
      projectName: "team",
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
    projectName: "team",
    imageId: "img1",
    mounts: [{ projectName: "team", kind: "MOUNT_KIND_PROJECT", mode: "MOUNT_MODE_READ_WRITE" }],
  });
  assert.equal(scope.value.command, null);
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
