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
  containerNotFound,
  normalizeToolError,
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

async function startControlServer(
  containers: any[] = [],
  options: { rewriteContainerSocket?: boolean } = {},
): Promise<{
  socketsRoot: string;
  received: string[];
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
  const server = new grpc.Server();
  const received: string[] = [];
  const createRequests: any[] = [];
  const recreateRequests: any[] = [];
  server.addService(loaded.dshctl.v1.OrchestratorControl.service, {
    listWorkspaces: (call: any, callback: any) => {
      received.push(call.metadata.get("authorization")[0]);
      callback(null, { workspaces: [] });
    },
    describeWorkspace: (_call: any, callback: any) => {
      callback({ code: grpc.status.NOT_FOUND, details: "workspace not found" });
    },
    listContainers: (_call: any, callback: any) => {
      callback(null, { containers });
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
  // Also answer on the guest socket the fake createWorkspace hands back, so a
  // resolved binding becomes ready immediately instead of waiting out the
  // readiness deadline.
  await new Promise<void>((ok, fail) =>
    server.bindAsync(
      `unix:${resolve(socketsRoot, "guest.sock")}`,
      grpc.ServerCredentials.createInsecure(),
      (error: any) => (error ? fail(error) : ok()),
    ),
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
    createRequests,
    recreateRequests,
    stop: () => server.forceShutdown(),
  };
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
      { resolveByPath: () => ({ id: "w1", path: "/projects/team" }) } as any,
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
      { resolveByPath: () => ({ id: "w1", path: "/projects/team" }) } as any,
    );
    const binding = await resolver.resolve("/projects/team");
    assert.equal(binding.defaultCwd, "/projects/team");
  } finally {
    stop();
  }
});

test("containerBinding exposes the session directory only when a project mount covers it", async () => {
  const mounted = await startControlServer([{
    workspaceSlug: "w1",
    containerName: "db",
    agentSocketPath: "/run/x.sock",
    agentToken: "tok",
    mounts: [{ kind: "MOUNT_KIND_PROJECT", projectName: "team", path: "" }],
  }]);
  try {
    const resolver = new WorkspaceResolver(
      {
        socketsRoot: mounted.socketsRoot,
        defaultImage: "arch",
        projectsRoot: "/projects",
        controlToken: "",
      },
      { resolveByPath: () => ({ id: "w1", path: "/projects/team" }) } as any,
    );
    const binding = await resolver.containerBinding("/projects/team", "db");
    assert.equal(binding.defaultCwd, "/projects/team");
  } finally {
    mounted.stop();
  }

  const unmounted = await startControlServer([{
    workspaceSlug: "w1",
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
      { resolveByPath: () => ({ id: "w1", path: "/projects/team" }) } as any,
    );
    const binding = await resolver.containerBinding("/projects/team", "db");
    assert.equal(binding.defaultCwd, undefined);
  } finally {
    unmounted.stop();
  }
});

test("containerBinding recreates a container whose agent never answers", async () => {
  const control = await startControlServer(
    [{
      workspaceSlug: "w1",
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
      { resolveByPath: () => ({ id: "w1", path: "/projects/team" }) } as any,
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
          { id: "w1", path: "/projects/team" },
          { id: "w2", path: "/projects/team/sub" },
        ],
        resolveByPath: (path: string) =>
          path === "/projects/team/sub"
            ? { id: "w2", path: "/projects/team/sub" }
            : { id: "w1", path: "/projects/team" },
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
      list: () => [{ id: "w1", path: "/projects/team" }],
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
