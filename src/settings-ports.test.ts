// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { test } from "node:test";
import { strict as assert } from "node:assert";
import {
  baseValue,
  fakeContext,
  fakeScope,
  installCardCommandDriver,
} from "./card-test-support.js";

// The publishPort answer a healthy orchestrator returns for a workspace that
// really has the port.
const PUBLISHED = {
  container: "web",
  protocol: "PROTOCOL_TCP",
  port: 8080,
  address: "127.0.0.1",
  hostPort: 26000,
  endpoint: "tcp://127.0.0.1:26000",
};

function portResolver(
  calls: Array<[string, unknown]>,
  overrides: Record<string, unknown> = {},
): any {
  return {
    getConfig: () => ({}),
    setConfig: () => {},
    async control(method: string, request: unknown) {
      calls.push([method, request]);
      if (method in overrides) {
        const value = overrides[method];
        if (value instanceof Error) throw value;
        return value;
      }
      if (method === "listContainers") return { containers: [] };
      if (method === "listImages") return { images: [] };
      if (method === "listWorkspaces") return { workspaces: [] };
      if (method === "publishPort") return PUBLISHED;
      return {};
    },
  };
}

async function installedPortScope(
  overrides: Record<string, unknown> = {},
): Promise<{ scope: any; calls: Array<[string, unknown]> }> {
  const scope = fakeScope(baseValue());
  const calls: Array<[string, unknown]> = [];
  await installCardCommandDriver(
    fakeContext(scope),
    portResolver(calls, overrides),
  );
  return { scope, calls };
}

test("container_publish_port drives publishPort with a suggested host port", async () => {
  const { scope, calls } = await installedPortScope();
  await scope.update({
    command: {
      op: "container_publish_port",
      workspace: "w1",
      container: "web",
      port: 8080,
      protocol: "tcp",
      suggestedHostPort: 26000,
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const published = calls.filter(([method]) => method === "publishPort");
  assert.deepEqual(published.map(([, request]) => request), [{
    workspaceSlug: "w1",
    container: "web",
    port: 8080,
    protocol: "PROTOCOL_TCP",
    suggestedHostPort: 26000,
  }]);
  // A host port the gateway chose is only knowable from the answer, so the
  // notice names the endpoint.
  assert.equal(scope.value.notice, "published on tcp://127.0.0.1:26000");
  assert.equal(scope.value.command, null);
});

test("container_publish_port defaults the protocol and omits an empty suggestion", async () => {
  const { scope, calls } = await installedPortScope();
  await scope.update({
    command: {
      op: "container_publish_port",
      workspace: "w1",
      container: "",
      port: 8080,
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const published = calls.filter(([method]) => method === "publishPort");
  assert.deepEqual(published.map(([, request]) => request), [{
    workspaceSlug: "w1",
    container: "default",
    port: 8080,
    protocol: "PROTOCOL_TCP",
  }]);
});

test("container_unpublish_port drives unpublishPort", async () => {
  const { scope, calls } = await installedPortScope();
  await scope.update({
    command: {
      op: "container_unpublish_port",
      workspace: "w1",
      container: "web",
      port: 8080,
      protocol: "tcp",
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const unpublished = calls.filter(([method]) => method === "unpublishPort");
  assert.deepEqual(unpublished.map(([, request]) => request), [{
    workspaceSlug: "w1",
    container: "web",
    port: 8080,
    protocol: "PROTOCOL_TCP",
  }]);
  assert.equal(scope.value.notice, "");
  assert.equal(scope.value.command, null);
});

test("a publish the orchestrator refuses surfaces its message as the notice", async () => {
  // The orchestrator owns the port ranges, so the card only relays the refusal.
  const { scope, calls } = await installedPortScope({
    publishPort: new Error("port 0 is outside 1..65535"),
  });
  await scope.update({
    command: {
      op: "container_publish_port",
      workspace: "w1",
      container: "web",
      port: 0,
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scope.value.notice, "port 0 is outside 1..65535");
  assert.equal(scope.value.command, null);
  assert.equal(
    calls.some(([method]) => method === "unpublishPort"),
    false,
    "a refused publish must not touch another port",
  );
});

test("listContainers published ports reach the card in logical names", async () => {
  const scope = fakeScope(baseValue());
  const calls: Array<[string, unknown]> = [];
  const resolver = portResolver(calls, {
    listContainers: {
      containers: [{
        containerName: "web",
        workspaceSlug: "w1",
        status: "running",
        publishedPorts: [{ ...PUBLISHED, agentToken: "must-not-leak" }],
      }],
    },
  });
  await installCardCommandDriver(fakeContext(scope), resolver);
  await scope.update({});
  assert.deepEqual((scope.value.containers as any[])[0].publishedPorts, [{
    protocol: "tcp",
    port: 8080,
    address: "127.0.0.1",
    hostPort: 26000,
    endpoint: "tcp://127.0.0.1:26000",
  }]);
});
