// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import { MOUNT_EXEC, SECRET_TOOLS, WORKSPACE_ID, mountRequestRecorder } from "./test-support.js";
import { READ_ONLY_TOOLS, TOOLS, toolHandlers } from "./index.js";

test("secret tools are registered with the expected schemas", () => {
  assert.ok(READ_ONLY_TOOLS.has("secret_list"), "secret_list must be read-only");

  const listTool = TOOLS.find((entry) => entry.name === "secret_list");
  assert.ok(listTool, "secret_list registered");
  assert.notEqual(listTool!.approval, true, "secret_list must not require approval");
  assert.deepEqual(listTool!.parameters.required, []);

  const createTool = TOOLS.find((entry) => entry.name === "secret_create");
  assert.ok(createTool, "secret_create registered");
  assert.notEqual(createTool!.approval, true, "secret_create must not require approval");
  assert.deepEqual(createTool!.parameters.required, ["name"]);
  assert.equal(createTool!.parameters.properties.length.type, "integer");
  assert.equal(createTool!.parameters.properties.length.minimum, 1);
  assert.deepEqual(createTool!.parameters.properties.charset.enum, [
    "alphanumeric",
    "hex",
    "base64url",
  ]);

  const removeTool = TOOLS.find((entry) => entry.name === "secret_remove");
  assert.ok(removeTool, "secret_remove registered");
  assert.equal(removeTool!.approval, true, "secret_remove must require approval");
  assert.deepEqual(removeTool!.parameters.required, ["name"]);

  const addTool = TOOLS.find((entry) => entry.name === "container_secret_add");
  assert.ok(addTool, "container_secret_add registered");
  assert.equal(addTool!.approval, true, "container_secret_add must require approval");
  assert.deepEqual(addTool!.parameters.required, ["container", "env", "secret"]);
  assert.equal(addTool!.parameters.properties.secret.type, "string");
  assert.equal(addTool!.parameters.properties.env.type, "string");

  const removeEnvTool = TOOLS.find((entry) => entry.name === "container_secret_remove");
  assert.ok(removeEnvTool, "container_secret_remove registered");
  assert.equal(removeEnvTool!.approval, true, "container_secret_remove must require approval");
  assert.deepEqual(removeEnvTool!.parameters.required, ["container", "env"]);

  for (const name of SECRET_TOOLS) {
    const tool = TOOLS.find((entry) => entry.name === name);
    assert.ok(tool, `${name} registered`);
    assert.equal(tool!.parameters.type, "object", `${name} type`);
    assert.equal(typeof tool!.parameters.properties, "object");
    assert.ok(Array.isArray(tool!.parameters.required));
  }
});

test("secret mount kinds forward the secret to the orchestrator", async () => {
  const requests: Record<string, unknown>[] = [];
  const resolver = {
    registry: {
      resolveByPath: async () => ({ id: WORKSPACE_ID }),
    },
    getConfig: () => ({ projectsRoot: "/projects" }),
    async control(method: string, request: unknown) {
      if (method === "addContainerMount" || method === "removeContainerMount") {
        requests.push(request as Record<string, unknown>);
      }
      return {};
    },
  };
  const exec = { agent: { session: { header: { cwd: "/proj" } } } };
  await toolHandlers.container_mount_add(
    resolver as never,
    {
      container: "valkey-ctr",
      kind: "secret",
      secret: "valkey-tls",
      destination: "/run/secrets/tls",
    },
    exec,
  );
  await toolHandlers.container_mount_remove(
    resolver as never,
    {
      container: "valkey-ctr",
      kind: "secret",
      secret: "valkey-tls",
    },
    exec,
  );
  assert.deepEqual(requests[0], {
    workspaceSlug: WORKSPACE_ID,
    container: "valkey-ctr",
    kind: "MOUNT_KIND_SECRET",
    secret: "valkey-tls",
    destination: "/run/secrets/tls",
  });
  assert.deepEqual(requests[1], {
    workspaceSlug: WORKSPACE_ID,
    container: "valkey-ctr",
    kind: "MOUNT_KIND_SECRET",
    secret: "valkey-tls",
  });
});

test("mount tools reject a read-write secret mount", async () => {
  const { requests, resolver } = mountRequestRecorder();
  await assert.rejects(
    () =>
      toolHandlers.container_mount_add(
        resolver as never,
        { container: "web", kind: "secret", secret: "tls", destination: "/run/secrets/tls", mode: "read_write" },
        MOUNT_EXEC,
      ),
    /secret mounts are read-only/,
  );
  await assert.rejects(
    () =>
      toolHandlers.container_start(
        resolver as never,
        {
          container: "web",
          image: "img1",
          mounts: [{ kind: "secret", secret: "tls", destination: "/run/secrets/tls", mode: "read_write" }],
        },
        MOUNT_EXEC,
      ),
    /secret mounts are read-only/,
  );
  assert.deepEqual(requests, [], "a rejected mount must not reach the orchestrator");
});

test("container_list returns secret_env maps on container rows", async () => {
  const resolver = {
    registry: {
      resolveByPath: async () => ({ id: WORKSPACE_ID }),
    },
    control: async (method: string) => {
      if (method === "listContainers") {
        return {
          containers: [
            {
              workspaceSlug: WORKSPACE_ID,
              containerName: "default",
              status: "running",
              imageId: "img-1",
              secretEnv: { REDIS_PASSWORD: "db-pass" },
            },
            {
              workspaceSlug: WORKSPACE_ID,
              containerName: "db",
              status: "running",
              secretEnv: {
                A: "a",
                B: "b",
                C: "c",
                D: "d",
                E: "e",
                F: "f",
                G: "g",
                H: "h",
                I: "i",
                J: "j",
              },
            },
            {
              workspaceSlug: WORKSPACE_ID,
              containerName: "worker",
              status: "stopped",
            },
          ],
        };
      }
      return {};
    },
  } as never;
  const exec = { agent: { session: { header: { cwd: "/proj" } } } };
  const out = (await toolHandlers.container_list(resolver, {}, exec)) as any[];
  assert.deepEqual(out, [
    {
      containerName: "default",
      status: "running",
      imageId: "img-1",
      mounts: [],
      paths: [],
      env: {},
      secretEnv: { REDIS_PASSWORD: "db-pass" },
    },
    {
      containerName: "db",
      status: "running",
      mounts: [],
      paths: [],
      env: {},
      secretEnv: {
        A: "a",
        B: "b",
        C: "c",
        D: "d",
        E: "e",
        F: "f",
        G: "g",
        H: "h",
        I: "i",
        J: "j",
      },
    },
    {
      containerName: "worker",
      status: "stopped",
      mounts: [],
      paths: [],
      env: {},
      secretEnv: {},
    },
  ]);
});
