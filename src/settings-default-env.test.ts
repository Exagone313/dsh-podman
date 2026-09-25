// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// The default container environment through the settings card: seeding on
// creation, authoritative recreates, and the synchronisation into existing
// containers.

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  baseValue,
  fakeContext,
  fakeScope,
  installCardCommandDriver,
} from "./card-test-support.js";

const DEFAULTS = {
  GIT_AUTHOR_NAME: "Elouan",
  GIT_AUTHOR_EMAIL: "exa@elou.world",
};

function driver(
  containerEnv: Record<string, string> | undefined,
  containers: any[] = [],
): { scope: ReturnType<typeof fakeScope>; calls: Array<[string, any]>; resolver: any } {
  const scope = fakeScope(baseValue());
  const calls: Array<[string, any]> = [];
  const resolver: any = {
    getConfig: () => (containerEnv === undefined ? {} : { containerEnv }),
    setConfig: () => {},
    async control(method: string, request: unknown) {
      calls.push([method, request as any]);
      if (method === "listContainers") return { containers };
      if (method === "listImages") return { images: [] };
      if (method === "listWorkspaces") return { workspaces: [] };
      return {};
    },
  };
  return { scope, calls, resolver };
}

const settle = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

test("create seeds the default environment into a new workspace", async () => {
  const { scope, calls, resolver } = driver(DEFAULTS);
  await installCardCommandDriver(fakeContext(scope), resolver);
  await scope.update({
    command: {
      op: "create",
      workspace: "w1",
      projectName: "team",
      image: "img1",
      mounts: [],
      env: { EXTRA: "1" },
      container: "",
    },
  });
  await settle();
  const create = calls.find(([method]) => method === "createWorkspace");
  assert.deepEqual(create?.[1].env, { ...DEFAULTS, EXTRA: "1" });
});

test("create seeds the default environment into a new named container", async () => {
  const { scope, calls, resolver } = driver(DEFAULTS);
  await installCardCommandDriver(fakeContext(scope), resolver);
  await scope.update({
    command: {
      op: "create",
      workspace: "w1",
      container: "web",
      image: "img1",
      mounts: [],
      env: {},
    },
  });
  await settle();
  const start = calls.find(([method]) => method === "startContainer");
  assert.deepEqual(start?.[1].env, DEFAULTS);
  assert.equal(start?.[1].container, "web");
});

test("recreate is authoritative and does not re-seed the defaults", async () => {
  const { scope, calls, resolver } = driver(DEFAULTS);
  await installCardCommandDriver(fakeContext(scope), resolver);
  await scope.update({
    command: { op: "recreate", workspace: "w1", image: "", env: { EXTRA: "1" } },
  });
  await settle();
  const recreate = calls.find(([method]) => method === "recreateContainer");
  assert.deepEqual(recreate?.[1].env, { EXTRA: "1" });
});

test("default_env_sync adds only missing keys to running containers", async () => {
  const containers = [
    {
      workspaceSlug: "w1",
      containerName: "default",
      status: "running",
      env: { EXTRA: "1" },
    },
    {
      workspaceSlug: "w1",
      containerName: "web",
      status: "running",
      env: { ...DEFAULTS },
    },
    { workspaceSlug: "w2", containerName: "default", status: "stopped", env: {} },
  ];
  const { scope, calls, resolver } = driver(DEFAULTS, containers);
  await installCardCommandDriver(fakeContext(scope), resolver);
  await scope.update({ command: { op: "default_env_sync", workspace: "" } });
  await settle();
  const recreates = calls.filter(([method]) => method === "recreateContainer");
  assert.deepEqual(
    recreates.map(([, request]) => request),
    [
      {
        workspaceSlug: "w1",
        container: "default",
        env: { ...DEFAULTS, EXTRA: "1" },
      },
    ],
    "only the incomplete running container is recreated, with existing values kept",
  );
  assert.equal(
    scope.value.notice,
    "applied the default environment to 1 container; 1 container stopped, to pick up on their next start",
  );
});

test("default_env_sync honors a workspace filter", async () => {
  const containers = [
    { workspaceSlug: "w1", containerName: "default", status: "running", env: {} },
    { workspaceSlug: "w2", containerName: "default", status: "running", env: {} },
  ];
  const { scope, calls, resolver } = driver(DEFAULTS, containers);
  await installCardCommandDriver(fakeContext(scope), resolver);
  await scope.update({ command: { op: "default_env_sync", workspace: "w2" } });
  await settle();
  const recreates = calls.filter(([method]) => method === "recreateContainer");
  assert.deepEqual(recreates.map(([, request]) => request), [
    { workspaceSlug: "w2", container: "default", env: DEFAULTS },
  ]);
});

test("default_env_sync reports nothing to do when the defaults are absent", async () => {
  const { scope, calls, resolver } = driver(undefined, [
    { workspaceSlug: "w1", containerName: "default", status: "running", env: {} },
  ]);
  await installCardCommandDriver(fakeContext(scope), resolver);
  await calls.splice(0);
  await scope.update({ command: { op: "default_env_sync", workspace: "" } });
  await settle();
  assert.equal(calls.some(([method]) => method === "recreateContainer"), false);
  assert.equal(scope.value.notice, "");
});

test("default_env_sync reports an already-complete state", async () => {
  const containers = [
    {
      workspaceSlug: "w1",
      containerName: "default",
      status: "running",
      env: { ...DEFAULTS },
    },
  ];
  const { scope, calls, resolver } = driver(DEFAULTS, containers);
  await installCardCommandDriver(fakeContext(scope), resolver);
  await scope.update({ command: { op: "default_env_sync", workspace: "" } });
  await settle();
  assert.equal(calls.some(([method]) => method === "recreateContainer"), false);
  assert.equal(
    scope.value.notice,
    "the default environment is already applied to every running container",
  );
});
