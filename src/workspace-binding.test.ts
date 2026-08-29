// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import grpc from "@grpc/grpc-js";
import loader from "@grpc/proto-loader";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { mkdirSync } from "node:fs";
import { controlClient, guestClient } from "./grpc/runtime-client.js";
import {
  workspaceSlug,
  metadata,
  WorkspaceResolver,
  containerRowFor,
} from "./workspace-binding.js";

test("workspace slugs are stable and container-safe", () => {
  assert.equal(workspaceSlug({ projectName: "my/project" }), "my-project");
  assert.equal(workspaceSlug({ id: "session-1" }), "session-1");
  assert.equal(workspaceSlug({ projectName: "../../etc" }), "etc");
  assert.equal(workspaceSlug("workspace-123"), "workspace-123");
});

test("workspace slugs read from the workspace shape", () => {
  assert.equal(workspaceSlug({ workspace: { name: "alpha" } }), "alpha");
  assert.equal(workspaceSlug({ workspaceName: "beta" }), "beta");
  assert.equal(workspaceSlug({ projectName: "gamma" }), "gamma");
  assert.equal(workspaceSlug({ id: "delta" }), "delta");
});

test("workspace slugs fall back to default", () => {
  assert.equal(workspaceSlug(undefined), "default");
  assert.equal(workspaceSlug(null), "default");
  assert.equal(workspaceSlug({}), "default");
  assert.equal(workspaceSlug({ workspace: { name: "" } }), "default");
});

test("workspace slugs are sanitized and truncated", () => {
  assert.equal(workspaceSlug({ projectName: "a b/c-d" }), "a-b-c-d");
  assert.equal(workspaceSlug("a b c"), "a-b-c");
  assert.equal(workspaceSlug({ projectName: "x_y.z" }), "x_y.z");
  assert.equal(workspaceSlug("-leading"), "leading");
  assert.equal(workspaceSlug("trailing-"), "trailing");
  assert.equal(workspaceSlug("a".repeat(200)), "a".repeat(50));
  assert.equal(workspaceSlug("a/b/c"), "a-b-c");
});

test("workspace slugs handle traversal parts", () => {
  assert.equal(workspaceSlug({ projectName: "../../etc" }), "etc");
  assert.equal(workspaceSlug("../../etc/passwd"), "etc-passwd");
  assert.equal(workspaceSlug("a/../b"), "a-b");
  assert.equal(workspaceSlug(".."), "default");
  assert.equal(workspaceSlug({ projectName: "../../.." }), "default");
});

test("metadata carries the bearer token", () => {
  const result = metadata("token-1");
  assert.ok(result instanceof grpc.Metadata);
  assert.equal(result.get("authorization")[0], "bearer token-1");
});

test("metadata omits the header when the token is empty", () => {
  const result = metadata("");
  assert.ok(result instanceof grpc.Metadata);
  assert.equal(result.get("authorization").length, 0);
});

test("containerRowFor finds rows by workspace and name", () => {
  const containers = [
    { workspaceSlug: "team-app", containerName: "default", status: "running" },
    { workspaceSlug: "team-app", containerName: "db", status: "stopped" },
    { workspaceSlug: "other", containerName: "db", status: "running" },
  ];
  assert.deepEqual(containerRowFor(containers, "team-app", "db"), {
    workspaceSlug: "team-app",
    containerName: "db",
    status: "stopped",
  });
  assert.deepEqual(containerRowFor(containers, "team-app", "default"), {
    workspaceSlug: "team-app",
    containerName: "default",
    status: "running",
  });
  assert.equal(containerRowFor(containers, "team-app", "missing"), undefined);
  assert.equal(containerRowFor([], "team-app", "default"), undefined);
});

test("control and guest proto files resolve next to the runtime", () => {
  const control = controlClient("/tmp/dsh-proto-control.sock");
  const guest = guestClient("/tmp/dsh-proto-guest.sock");
  control.close();
  guest.close();
});

async function startControlServer(): Promise<{
  socketsRoot: string;
  received: string[];
  stop: () => void;
}> {
  const protoPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "grpc/proto/dshctl/v1/control.proto",
  );
  const definition = loader.loadSync(protoPath, {
    longs: String,
    enums: String,
    defaults: true,
  });
  const loaded = grpc.loadPackageDefinition(definition) as any;
  const server = new grpc.Server();
  const received: string[] = [];
  server.addService(loaded.dshctl.v1.OrchestratorControl.service, {
    listWorkspaces: (call: any, callback: any) => {
      received.push(call.metadata.get("authorization")[0]);
      callback(null, { workspaces: [] });
    },
  });
  const socketsRoot = resolve(
    tmpdir(),
    `dsh-control-test-${process.pid}-${Date.now()}-${Math.random()}`,
  );
  mkdirSync(socketsRoot, { recursive: true });
  const socket = resolve(socketsRoot, "orchestrator.sock");
  await new Promise<void>((ok, fail) =>
    server.bindAsync(
      `unix:${socket}`,
      grpc.ServerCredentials.createInsecure(),
      (error: any) => (error ? fail(error) : ok()),
    ),
  );
  return { socketsRoot, received, stop: () => server.forceShutdown() };
}

test("control calls carry the bearer token", async () => {
  const { socketsRoot, received, stop } = await startControlServer();
  try {
    const resolver = new WorkspaceResolver(
      {
        socketsRoot,
        defaultImage: "arch",
        projectsRoot: "/projects",
        controlToken: "tok-1",
      },
      undefined as any,
    );
    await resolver.control("listWorkspaces", {});
    assert.equal(received[0], "bearer tok-1");
  } finally {
    stop();
  }
});

test("control calls omit the token when unset", async () => {
  const { socketsRoot, received, stop } = await startControlServer();
  try {
    const resolver = new WorkspaceResolver(
      {
        socketsRoot,
        defaultImage: "arch",
        projectsRoot: "/projects",
        controlToken: "",
      },
      undefined as any,
    );
    await resolver.control("listWorkspaces", {});
    assert.equal(received[0], undefined);
  } finally {
    stop();
  }
});
