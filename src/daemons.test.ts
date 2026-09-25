// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import { DAEMON_TOOLS } from "./test-support.js";
import { publicDaemon, toolHandlers, TOOLS } from "./index.js";

test("daemon_start accepts optional uid, gid and groups", () => {
  const tool = TOOLS.find((entry) => entry.name === "daemon_start");
  assert.ok(tool, "daemon_start registered");
  const properties = tool!.parameters.properties;
  assert.equal(properties.name.type, "string");
  assert.ok(
    (tool!.parameters.required as string[]).includes("name"),
    "daemon_start must require a name",
  );
  assert.equal(properties.uid.type, "integer");
  assert.equal(properties.uid.minimum, 0);
  assert.equal(properties.gid.type, "integer");
  assert.equal(properties.gid.minimum, 0);
  assert.equal(properties.groups.type, "array");
  assert.equal(properties.groups.items.type, "integer");
  assert.equal(properties.groups.items.minimum, 0);
  assert.equal(properties.inheritEnv.type, "boolean");
});

test("daemon_start serializes uid/gid as protobuf wrapper objects", async () => {
  let captured: Record<string, unknown> | undefined;
  const resolver = {
    containerBinding: async () => ({
      guest: {
        startDaemon: (
          request: Record<string, unknown>,
          _metadata: unknown,
          callback: (error: Error | null, result: unknown) => void,
        ) => {
          captured = request;
          callback(null, {
            name: "valkey-1001",
            running: true,
            argv: ["valkey-server"],
          });
        },
      },
      token: "t",
      socket: "/run/x.sock",
    }),
  };
  const exec = { agent: { session: { header: { cwd: "/proj" } } } };
  await toolHandlers.daemon_start(
    resolver as never,
    {
      container: "valkey-ctr",
      argv: ["valkey-server"],
      uid: 1001,
      gid: 1001,
    },
    exec,
  );
  assert.deepEqual(captured!.uid, { value: 1001 });
  assert.deepEqual(captured!.gid, { value: 1001 });
  assert.deepEqual(captured!.inheritEnv, { value: true });

  captured = undefined;
  await toolHandlers.daemon_start(
    resolver as never,
    { container: "valkey-ctr", argv: ["valkey-server"] },
    exec,
  );
  assert.equal(captured!.uid, undefined);
  assert.equal(captured!.gid, undefined);
  assert.deepEqual(captured!.inheritEnv, { value: true });

  captured = undefined;
  await toolHandlers.daemon_start(
    resolver as never,
    { container: "valkey-ctr", argv: ["valkey-server"], inheritEnv: false },
    exec,
  );
  assert.deepEqual(captured!.inheritEnv, { value: false });
});

test("daemon tools require no approval and are valid object-rooted schemas", () => {
  for (const name of DAEMON_TOOLS) {
    const tool = TOOLS.find((entry) => entry.name === name);
    assert.ok(tool, `${name} registered`);
    assert.notEqual(tool!.approval, true, `${name} must not require approval`);
    assert.equal(tool!.parameters.type, "object", `${name} type`);
    assert.equal(typeof tool!.parameters.properties, "object");
    assert.ok(Array.isArray(tool!.parameters.required));
    assert.ok(tool!.parameters.required.includes("container"));
  }
});

test("publicDaemon omits the exit code while the daemon runs", () => {
  const running = publicDaemon({ name: "web", argv: ["sleep", "600"], running: true, exitCode: 0 });
  assert.equal(running.running, true);
  assert.equal("exitCode" in running, false);

  const exited = publicDaemon({ name: "web", argv: ["sleep", "600"], running: false, exitCode: 3 });
  assert.equal(exited.running, false);
  assert.equal(exited.exitCode, 3);
});

test("publicDaemon reports supplementary groups", () => {
  const withGroups = publicDaemon({
    name: "web",
    argv: ["sleep", "600"],
    running: true,
    uid: 1000,
    gid: 1000,
    groups: [3000, 4000],
  });
  assert.deepEqual(withGroups.groups, [3000, 4000]);
  const without = publicDaemon({
    name: "web",
    argv: ["sleep", "600"],
    running: true,
    groups: [],
  });
  assert.equal("groups" in without, false);
});

test("daemon_start returns a daemon info object", async () => {
  const resolver = {
    resolve: async () => ({
      guest: {
        startDaemon: (_metadata: unknown, _request: unknown, callback: any) =>
          callback(null, {
            name: "web",
            running: true,
            argv: ["python3", "-m", "http.server", "8000"],
            uid: 1000,
            gid: 1000,
          }),
      },
      token: "t",
      socket: "/run/x.sock",
    }),
  } as never;
  const exec = { agent: { session: { header: { cwd: "/proj" } } } };
  const out = await toolHandlers.daemon_start(
    resolver,
    { container: "default", argv: ["python3", "-m", "http.server", "8000"], name: "web" },
    exec,
  );
  assert.deepEqual(out, {
    name: "web",
    running: true,
    argv: ["python3", "-m", "http.server", "8000"],
    uid: 1000,
    gid: 1000,
  });
});

test("daemon_start resolves a relative working directory", async () => {
  const makeResolver = (defaultCwd?: string) => {
    let captured: Record<string, unknown> | undefined;
    const resolver = {
      containerBinding: async () => ({
        guest: {
          startDaemon: (
            request: Record<string, unknown>,
            _metadata: unknown,
            callback: (error: Error | null, result: unknown) => void,
          ) => {
            captured = request;
            callback(null, { name: "d", running: true, argv: ["x"] });
          },
        },
        token: "t",
        socket: "/run/x.sock",
        ...(defaultCwd === undefined ? {} : { defaultCwd }),
      }),
    };
    return { resolver, captured: () => captured };
  };
  const exec = { agent: { session: { header: { cwd: "/projects/team" } } } };

  const relative = makeResolver("/projects/team");
  await toolHandlers.daemon_start(
    relative.resolver as never,
    { container: "c", argv: ["x"], cwd: "sub" },
    exec,
  );
  assert.equal(relative.captured()!.cwd, "/projects/team/sub");

  // No explicit cwd: the mounted session directory is used.
  const defaulted = makeResolver("/projects/team");
  await toolHandlers.daemon_start(
    defaulted.resolver as never,
    { container: "c", argv: ["x"] },
    exec,
  );
  assert.equal(defaulted.captured()!.cwd, "/projects/team");

  // Not mounted: the guest agent's own working directory stays in place.
  const unmounted = makeResolver();
  await toolHandlers.daemon_start(
    unmounted.resolver as never,
    { container: "c", argv: ["x"] },
    exec,
  );
  assert.equal(unmounted.captured()!.cwd, undefined);
});
