// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import { portProtocolFromProto, portProtocolToProto } from "./publish-port.js";
import { publicPublishedPort } from "./public.js";
import { toolHandlers } from "./tool-handlers.js";
import { WORKSPACE_ID } from "./test-support.js";

test("port protocols map between the tool vocabulary and the wire", () => {
  assert.equal(portProtocolToProto(undefined), "PROTOCOL_TCP");
  assert.equal(portProtocolToProto("tcp"), "PROTOCOL_TCP");
  assert.equal(portProtocolToProto("udp"), "PROTOCOL_UDP");
  assert.equal(portProtocolToProto("http"), "PROTOCOL_HTTP");
  assert.throws(() => portProtocolToProto("sctp"), /unknown port protocol/);
  assert.equal(portProtocolFromProto("PROTOCOL_TCP"), "tcp");
  assert.equal(portProtocolFromProto("PROTOCOL_UDP"), "udp");
  assert.equal(portProtocolFromProto("PROTOCOL_HTTP"), "http");
  assert.equal(portProtocolFromProto("PROTOCOL_UNSPECIFIED"), undefined);
  assert.equal(portProtocolFromProto(undefined), undefined);
});

test("publicPublishedPort keeps only the safe fields", () => {
  const out = publicPublishedPort({
    container: "default",
    protocol: "PROTOCOL_TCP",
    port: 8080,
    address: "127.0.0.1",
    hostPort: 26000,
    endpoint: "tcp://127.0.0.1:26000",
    agentToken: "must-not-leak",
  });
  assert.deepEqual(Object.keys(out).sort(), [
    "address",
    "endpoint",
    "hostPort",
    "port",
    "protocol",
  ]);
  assert.equal(out.endpoint, "tcp://127.0.0.1:26000");
  assert.equal(out.protocol, "tcp");
});

function publishResolver(response: Record<string, unknown>): {
  resolver: never;
  calls: Array<[string, any]>;
} {
  const calls: Array<[string, any]> = [];
  const resolver = {
    registry: { resolveByPath: async () => ({ id: WORKSPACE_ID }) },
    control: async (method: string, request: any) => {
      calls.push([method, request]);
      return method === "publishPort" ? response : {};
    },
  } as never;
  return { resolver, calls };
}

const exec = { agent: { session: { header: { cwd: "/proj" } } } };

test("container_publish_port sends the pod port and returns the endpoint", async () => {
  const { resolver, calls } = publishResolver({
    container: "default",
    protocol: "PROTOCOL_TCP",
    port: 8080,
    address: "127.0.0.1",
    hostPort: 26000,
    endpoint: "tcp://127.0.0.1:26000",
  });
  const out = await toolHandlers.container_publish_port(
    resolver,
    { container: "default", port: 8080, suggestedHostPort: 26000 },
    exec,
  );
  assert.deepEqual(calls[0], [
    "publishPort",
    {
      workspaceSlug: WORKSPACE_ID,
      container: "default",
      port: 8080,
      protocol: "PROTOCOL_TCP",
      suggestedHostPort: 26000,
    },
  ]);
  assert.deepEqual(out, {
    container: "default",
    protocol: "tcp",
    port: 8080,
    address: "127.0.0.1",
    hostPort: 26000,
    endpoint: "tcp://127.0.0.1:26000",
  });
});

test("container_publish_port omits an unspecified host port", async () => {
  const { resolver, calls } = publishResolver({
    protocol: "PROTOCOL_TCP",
    port: 8080,
    address: "127.0.0.1",
    hostPort: 31234,
    endpoint: "tcp://127.0.0.1:31234",
  });
  await toolHandlers.container_publish_port(
    resolver,
    { container: "default", port: 8080 },
    exec,
  );
  assert.deepEqual(calls[0], [
    "publishPort",
    {
      workspaceSlug: WORKSPACE_ID,
      container: "default",
      port: 8080,
      protocol: "PROTOCOL_TCP",
    },
  ]);
});

test("container_unpublish_port identifies the port it releases", async () => {
  const { resolver, calls } = publishResolver({});
  const out = await toolHandlers.container_unpublish_port(
    resolver,
    { container: "default", port: 8080 },
    exec,
  );
  assert.deepEqual(calls[0], [
    "unpublishPort",
    {
      workspaceSlug: WORKSPACE_ID,
      container: "default",
      port: 8080,
      protocol: "PROTOCOL_TCP",
    },
  ]);
  assert.deepEqual(out, {
    container: "default",
    port: 8080,
    protocol: "tcp",
    unpublished: true,
  });
});
