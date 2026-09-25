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
  containerNotFound,
  metadata,
  normalizeToolError,
  WorkspaceResolver,
  workspaceSlug,
} from "./workspace-binding.js";
import { VERSION } from "./generated/version.js";

const SLUG = "2c573001-4171-4900-904b-12a5cc02737a";
const SLUG_SUB = "3d684112-5282-4a11-a15c-23b6dd13848b";

test("normalizeToolError strips the prefix only for a gRPC status", () => {
  const statusError: any = Object.assign(new Error("5 NOT_FOUND: missing"), { code: 5 });
  const normalized = normalizeToolError(statusError);
  assert.equal(normalized.message, "missing");
  assert.equal((normalized as { code?: string }).code, "NOT_FOUND");
  // A plain message that merely looks like a status keeps its text.
  const plain = normalizeToolError(new Error("5 NOT_FOUND: missing"));
  assert.equal(plain.message, "5 NOT_FOUND: missing");
  assert.equal((plain as { code?: string }).code, undefined);
});

test("workspaceSlug accepts a UUID workspace id", () => {
  assert.equal(workspaceSlug(SLUG), SLUG);
  assert.equal(workspaceSlug(SLUG.toUpperCase()), SLUG);
});

test("workspaceSlug rejects anything that is not a UUID", () => {
  const invalid = [
    undefined,
    null,
    "",
    "proj",
    "team-app",
    "a/b",
    "..",
    "a b",
    `${SLUG}-x`,
    SLUG.slice(0, -1),
  ];
  for (const value of invalid) {
    assert.throws(
      () => workspaceSlug(value),
      /expected a UUID/,
      `expected ${JSON.stringify(value)} to be rejected`,
    );
  }
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

test("metadata carries the plugin version only when one is given", () => {
  const withVersion = metadata("token-1", "1.2.3");
  assert.equal(withVersion.get("x-dsh-podman-plugin-version")[0], "1.2.3");
  // Guest calls pass no version, and the guest agent does not check it.
  assert.equal(metadata("token-1").get("x-dsh-podman-plugin-version").length, 0);
});

test("normalizeToolError strips the grpc prefix and names the code", () => {
  const prefixed = Object.assign(new Error("5 NOT_FOUND: container not found"), { code: 5 });
  const normalized = normalizeToolError(prefixed);
  assert.equal(normalized.message, "container not found");
  assert.equal((normalized as { code?: string }).code, "NOT_FOUND");

  const plain = normalizeToolError(new Error("boom"));
  assert.equal(plain.message, "boom");
  assert.equal((plain as { code?: string }).code, undefined);

  const named = Object.assign(new Error("bad input"), { code: "INVALID_ARGUMENT" });
  assert.equal((normalizeToolError(named) as { code?: string }).code, "INVALID_ARGUMENT");
});

test("containerNotFound reports one stable shape", () => {
  assert.equal(
    containerNotFound("db", "w1").message,
    'container "db" not found in workspace "w1"',
  );
  assert.equal((containerNotFound("db") as { code?: string }).code, "NOT_FOUND");
  assert.equal(containerNotFound("db").message, 'container "db" not found');
});

test("control and guest proto files resolve next to the runtime", () => {
  const control = controlClient("/tmp/dsh-proto-control.sock");
  const guest = guestClient("/tmp/dsh-proto-guest.sock");
  control.close();
  guest.close();
});

async function startControlServer(
  containers: any[] = [],
  options: { rewriteContainerSocket?: boolean; staleToken?: boolean } = {},
): Promise<{
  socketsRoot: string;
  received: string[];
  versions: Array<string | undefined>;
  createRequests: any[];
  recreateRequests: any[];
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
  const guestDefinition = loader.loadSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      "grpc/proto/dshguest/v1/guest.proto",
    ),
    { longs: String, enums: String, defaults: true },
  );
  const guestLoaded = grpc.loadPackageDefinition(guestDefinition) as any;
  const server = new grpc.Server();
  // With staleToken, the first container row carries a credential the agent
  // rejects, so the caller must refresh before it can proceed.
  let ensureCalls = 0;
  server.addService(guestLoaded.dshguest.v1.WorkspaceGuestAgent.service, {
    ping: (call: any, callback: any) => {
      const bearer = String(call.metadata.get("authorization")[0] ?? "");
      if (bearer === "bearer stale") {
        callback({ code: grpc.status.UNAUTHENTICATED, details: "invalid agent token" });
        return;
      }
      callback(null, { version: "test", commit: "test" });
    },
  });
  const received: string[] = [];
  const versions: Array<string | undefined> = [];
  const createRequests: any[] = [];
  const recreateRequests: any[] = [];
  server.addService(loaded.dshctl.v1.OrchestratorControl.service, {
    listWorkspaces: (call: any, callback: any) => {
      received.push(call.metadata.get("authorization")[0]);
      versions.push(call.metadata.get("x-dsh-podman-plugin-version")[0]);
      callback(null, { workspaces: [] });
    },
    describeWorkspace: (_call: any, callback: any) => {
      callback({ code: grpc.status.NOT_FOUND, details: "workspace not found" });
    },
    ensureContainer: (call: any, callback: any) => {
      const agentToken = options.staleToken === true && ensureCalls++ === 0 ? "stale" : "tok";
      const row = containers.find(
        (candidate: any) =>
          candidate.workspaceSlug === call.request.workspaceSlug &&
          candidate.containerName === call.request.container,
      );
      if (row !== undefined) {
        callback(null, { ...row, agentToken });
        return;
      }
      if (call.request.container === "default") {
        // The default container createWorkspace just made.
        callback(null, {
          workspaceSlug: call.request.workspaceSlug,
          containerName: "default",
          agentSocketPath: resolve(socketsRoot, "guest.sock"),
          agentToken,
          mounts: [],
        });
        return;
      }
      callback({ code: grpc.status.NOT_FOUND, details: "container not found" });
    },
    createWorkspace: (call: any, callback: any) => {
      createRequests.push(call.request);
      callback(null, {
        workspaceSlug: call.request.workspaceSlug,
        agentSocketPath: resolve(socketsRoot, "guest.sock"),
        agentToken: "tok",
      });
    },
    recreateContainer: (call: any, callback: any) => {
      recreateRequests.push(call.request);
      callback(null, { workspaceSlug: call.request.workspaceSlug });
    },
    addContainerMount: (_call: any, callback: any) => {
      callback(null, {});
    },
    removeWorkspace: (_call: any, callback: any) => {
      callback(null, {});
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
    )
  );
  // Also answer on the guest socket the fake createWorkspace hands back, so a
  // resolved binding becomes ready immediately instead of waiting out the
  // readiness deadline.
  await new Promise<void>((ok, fail) =>
    server.bindAsync(
      `unix:${resolve(socketsRoot, "guest.sock")}`,
      grpc.ServerCredentials.createInsecure(),
      (error: any) => (error ? fail(error) : ok()),
    )
  );
  // Point the fake container rows at the same guest socket, so a named
  // container binding becomes ready immediately too.
  if (options.rewriteContainerSocket !== false) {
    for (const row of containers) {
      row.agentSocketPath = resolve(socketsRoot, "guest.sock");
    }
  }
  return {
    socketsRoot,
    received,
    versions,
    createRequests,
    recreateRequests,
    stop: () => server.forceShutdown(),
  };
}

test("control calls carry the bearer token", async () => {
  const { socketsRoot, received, versions, stop } = await startControlServer();
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
    assert.equal(versions[0], VERSION, "control calls report the plugin version");
  } finally {
    stop();
  }
});

test("control calls omit the token when unset", async () => {
  const { socketsRoot, received, versions, stop } = await startControlServer();
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

test("the auto-created workspace mount stays read-write", async () => {
  // Additional mounts default to read-only, but the workspace's own project
  // directory must stay writable or the agent cannot edit the project.
  const { socketsRoot, createRequests, stop } = await startControlServer();
  try {
    const resolver = new WorkspaceResolver(
      {
        socketsRoot,
        defaultImage: "arch",
        projectsRoot: "/projects",
        controlToken: "",
      },
      { resolveByPath: () => ({ id: SLUG, path: "/projects/team" }) } as any,
    );
    await resolver.resolve("/projects/team");
    assert.equal(createRequests.length, 1);
    assert.equal(createRequests[0].projectName, "team");
    const mounts = createRequests[0].mounts;
    assert.equal(mounts.length, 1);
    assert.equal(mounts[0].projectName, "team");
    assert.equal(mounts[0].mode, "MOUNT_MODE_READ_WRITE");
  } finally {
    stop();
  }
});

test("resolve exposes the session directory as the default cwd", async () => {
  const { socketsRoot, stop } = await startControlServer();
  try {
    const resolver = new WorkspaceResolver(
      {
        socketsRoot,
        defaultImage: "arch",
        projectsRoot: "/projects",
        controlToken: "",
      },
      { resolveByPath: () => ({ id: SLUG, path: "/projects/team" }) } as any,
    );
    const binding = await resolver.resolve("/projects/team");
    assert.equal(binding.defaultCwd, "/projects/team");
  } finally {
    stop();
  }
});

test("resolve refreshes a binding whose token the agent rejects", async () => {
  // The first row carries a credential the guest agent rejects; resolving must
  // re-run the orchestrator's ensure and end with the usable token.
  const { socketsRoot, stop } = await startControlServer([], { staleToken: true });
  try {
    const resolver = new WorkspaceResolver(
      {
        socketsRoot,
        defaultImage: "arch",
        projectsRoot: "/projects",
        controlToken: "",
      },
      { resolveByPath: () => ({ id: SLUG, path: "/projects/team" }) } as any,
    );
    const binding = await resolver.resolve("/projects/team");
    assert.equal(binding.token, "tok");
  } finally {
    stop();
  }
});

test("the auto-created workspace seeds the default environment", async () => {
  const { socketsRoot, createRequests, stop } = await startControlServer();
  try {
    const resolver = new WorkspaceResolver(
      {
        socketsRoot,
        defaultImage: "arch",
        projectsRoot: "/projects",
        controlToken: "",
        containerEnv: { GIT_AUTHOR_NAME: "Elouan" },
      },
      { resolveByPath: () => ({ id: SLUG, path: "/projects/team" }) } as any,
    );
    await resolver.resolve("/projects/team");
    assert.equal(createRequests.length, 1);
    assert.deepEqual(createRequests[0].env, { GIT_AUTHOR_NAME: "Elouan" });
  } finally {
    stop();
  }
});

test("the auto-created workspace omits env without defaults", async () => {
  const { socketsRoot, createRequests, stop } = await startControlServer();
  try {
    const resolver = new WorkspaceResolver(
      {
        socketsRoot,
        defaultImage: "arch",
        projectsRoot: "/projects",
        controlToken: "",
      },
      { resolveByPath: () => ({ id: SLUG, path: "/projects/team" }) } as any,
    );
    await resolver.resolve("/projects/team");
    assert.deepEqual(createRequests[0].env, {});
  } finally {
    stop();
  }
});

test("containerBinding exposes the session directory only when a project mount covers it", async () => {
  const mounted = await startControlServer([{
    workspaceSlug: SLUG,
    containerName: "db",
    agentSocketPath: "/run/x.sock",
    agentToken: "tok",
    mounts: [{ kind: "MOUNT_KIND_PROJECT", projectName: "team" }],
  }]);
  try {
    const resolver = new WorkspaceResolver(
      {
        socketsRoot: mounted.socketsRoot,
        defaultImage: "arch",
        projectsRoot: "/projects",
        controlToken: "",
      },
      { resolveByPath: () => ({ id: SLUG, path: "/projects/team" }) } as any,
    );
    const binding = await resolver.containerBinding("/projects/team", "db");
    assert.equal(binding.defaultCwd, "/projects/team");
  } finally {
    mounted.stop();
  }

  const unmounted = await startControlServer([{
    workspaceSlug: SLUG,
    containerName: "db",
    agentSocketPath: "/run/x.sock",
    agentToken: "tok",
    mounts: [{ kind: "MOUNT_KIND_VOLUME", volume: "data", destination: "/data" }],
  }]);
  try {
    const resolver = new WorkspaceResolver(
      {
        socketsRoot: unmounted.socketsRoot,
        defaultImage: "arch",
        projectsRoot: "/projects",
        controlToken: "",
      },
      { resolveByPath: () => ({ id: SLUG, path: "/projects/team" }) } as any,
    );
    const binding = await resolver.containerBinding("/projects/team", "db");
    assert.equal(binding.defaultCwd, undefined);
  } finally {
    unmounted.stop();
  }
});

test("containerBinding re-resolves the mount set after a container mutation", async () => {
  const rows: any[] = [
    {
      workspaceSlug: SLUG,
      containerName: "db",
      agentSocketPath: "/run/x.sock",
      agentToken: "tok",
      mounts: [{ kind: "MOUNT_KIND_PROJECT", projectName: "team" }],
    },
  ];
  const control = await startControlServer(rows);
  try {
    const resolver = new WorkspaceResolver(
      {
        socketsRoot: control.socketsRoot,
        defaultImage: "arch",
        projectsRoot: "/projects",
        controlToken: "",
      },
      { resolveByPath: () => ({ id: SLUG, path: "/projects/team" }) } as any,
    );
    const first = await resolver.containerBinding("/projects/team", "db");
    assert.equal(first.defaultCwd, "/projects/team");
    // The container no longer mounts the session directory, but the cached
    // entry still describes the row it was built from.
    rows[0].mounts = [
      { kind: "MOUNT_KIND_VOLUME", volume: "data", destination: "/data" },
    ];
    const stale = await resolver.containerBinding("/projects/team", "db");
    assert.equal(
      stale.defaultCwd,
      "/projects/team",
      "the cache is served until it is invalidated",
    );
    await resolver.control("addContainerMount", {
      workspaceSlug: SLUG,
      container: "db",
    });
    const fresh = await resolver.containerBinding("/projects/team", "db");
    assert.equal(
      fresh.defaultCwd,
      undefined,
      "a mutation re-resolves the mount set",
    );
  } finally {
    control.stop();
  }
});

test("removing a workspace drops every cached container binding", async () => {
  const rows: any[] = [
    {
      workspaceSlug: SLUG,
      containerName: "db",
      agentSocketPath: "/run/x.sock",
      agentToken: "tok",
      mounts: [{ kind: "MOUNT_KIND_PROJECT", projectName: "team" }],
    },
  ];
  const control = await startControlServer(rows);
  try {
    const resolver = new WorkspaceResolver(
      {
        socketsRoot: control.socketsRoot,
        defaultImage: "arch",
        projectsRoot: "/projects",
        controlToken: "",
      },
      { resolveByPath: () => ({ id: SLUG, path: "/projects/team" }) } as any,
    );
    await resolver.containerBinding("/projects/team", "db");
    rows[0].mounts = [];
    await resolver.control("removeWorkspace", { workspaceSlug: SLUG });
    const fresh = await resolver.containerBinding("/projects/team", "db");
    assert.equal(fresh.defaultCwd, undefined);
  } finally {
    control.stop();
  }
});

test("containerBinding recreates a container whose agent never answers", async () => {
  const control = await startControlServer(
    [{
      workspaceSlug: SLUG,
      containerName: "db",
      agentSocketPath: "/nonexistent/guest.sock",
      agentToken: "tok",
      mounts: [],
    }],
    { rewriteContainerSocket: false },
  );
  try {
    const resolver = new WorkspaceResolver(
      {
        socketsRoot: control.socketsRoot,
        defaultImage: "arch",
        projectsRoot: "/projects",
        controlToken: "",
        readyTimeoutMs: 50,
      },
      { resolveByPath: () => ({ id: SLUG, path: "/projects/team" }) } as any,
    );
    await assert.rejects(() => resolver.containerBinding("/projects/team", "db"));
    assert.equal(control.recreateRequests.length, 1);
    assert.equal(control.recreateRequests[0].container, "db");
  } finally {
    control.stop();
  }
});

test("resolveForPath derives the workspace from an absolute path without a cwd", async () => {
  const { socketsRoot, createRequests, stop } = await startControlServer();
  try {
    const resolver = new WorkspaceResolver(
      {
        socketsRoot,
        defaultImage: "arch",
        projectsRoot: "/projects",
        controlToken: "",
      },
      {
        list: () => [
          { id: SLUG, path: "/projects/team" },
          { id: SLUG_SUB, path: "/projects/team/sub" },
        ],
        resolveByPath: (path: string) =>
          path === "/projects/team/sub"
            ? { id: SLUG_SUB, path: "/projects/team/sub" }
            : { id: SLUG, path: "/projects/team" },
      } as any,
    );
    const binding = await resolver.resolveForPath(
      "/projects/team/sub/AGENTS.md",
      undefined,
    );
    assert.equal(binding.defaultCwd, "/projects/team/sub");
    assert.equal(createRequests[0].projectName, "team/sub");
  } finally {
    stop();
  }
});

test("resolveForPath rejects paths it cannot map to a workspace", async () => {
  const resolver = new WorkspaceResolver(
    {
      socketsRoot: "/run/dsh",
      defaultImage: "arch",
      projectsRoot: "/projects",
      controlToken: "",
    },
    {
      list: () => [{ id: SLUG, path: "/projects/team" }],
      resolveByPath: () => undefined,
    } as any,
  );
  await assert.rejects(
    () => resolver.resolveForPath("README.md", undefined),
    /session working directory/,
  );
  // A path outside every workspace is not in any container's filesystem: it is
  // reported with the harness's missing-path code so callers treat it as absent
  // (agent-instructions walks ancestors above the workspace this way).
  await assert.rejects(
    () => resolver.resolveForPath("/elsewhere/file", undefined),
    (error: unknown) =>
      error instanceof Error && (error as { code?: string }).code === "FS_NOT_FOUND",
  );
});

test("resolve rejects a missing cwd without stringifying it", async () => {
  const resolver = new WorkspaceResolver(
    {
      socketsRoot: "/run/dsh",
      defaultImage: "arch",
      projectsRoot: "/projects",
      controlToken: "",
    },
    {
      resolveByPath: () => {
        throw new Error("resolveByPath must not be called with a missing cwd");
      },
    } as any,
  );
  await assert.rejects(
    () => resolver.resolve(undefined),
    /session working directory/,
  );
});
