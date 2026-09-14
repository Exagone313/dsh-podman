// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import {
  MOUNT_EXEC,
  MOUNT_TOOLS,
  guestExecRecorder,
  mountRequestRecorder,
  testReadSession,
  WORKSPACE_ID,
} from "./test-support.js";
import { TOOLS, approvalDecision, preExecutePolicy, summarizeArgs, toolHandlers } from "./index.js";

test("container_start approval depends on mounts being passed", () => {
  const tool = TOOLS.find((entry) => entry.name === "container_start");
  assert.ok(tool, "container_start registered");
  assert.notEqual(tool!.approval, true, "container_start must not always ask");
  assert.ok(typeof tool!.approvalWhen === "function", "container_start approvalWhen");

  assert.equal(
    approvalDecision("container_start", { container: "web" }),
    undefined,
    "no mounts: must not ask",
  );
  assert.equal(
    approvalDecision("container_start", { container: "web", mounts: [] }),
    undefined,
    "empty mounts: must not ask",
  );
  const decision = approvalDecision("container_start", {
    container: "web",
    image: "localhost/dsh-podman/nginx:latest",
    mounts: [
      { project: "team/src", mode: "read_only" },
      { project: "team", destination: "/workspace/team", mode: "read_write" },
    ],
  });
  assert.ok(decision, "mounts passed: must ask");
  assert.equal(decision!.kind, "ask");
  assert.equal(
    decision!.reason,
    'Start container "web" from image "localhost/dsh-podman/nginx:latest" with mounts: project "team/src" (read-only), project "team" at "/workspace/team" (read-write).',
  );
});

test("summarizeArgs infers the mount target when kind is omitted", () => {
  assert.equal(
    summarizeArgs("container_mount_remove", {
      container: "valkey-ctr",
      secret: "valkey-tls",
    }),
    'Remove mount from container "valkey-ctr": secret "valkey-tls".',
  );
  assert.equal(
    summarizeArgs("container_mount_add", {
      container: "valkey-ctr",
      volume: "valkey-data",
    }),
    'Add mount to container "valkey-ctr": volume "valkey-data" (read-only).',
  );
});

test("preExecutePolicy denies project mounts that carry a destination", async () => {
  const deny = (await preExecutePolicy(
    {
      name: "container_mount_add",
      arguments: { kind: "project", project: "team/src", destination: "/custom" },
    },
    () => Promise.resolve({ kind: "allow" }),
    () => "/projects",
  )) as { kind: string; reason: string };
  assert.equal(deny.kind, "deny", "must deny instead of asking");
  assert.equal(
    deny.reason,
    'Project mounts cannot set a destination; "team/src" always mounts at "/projects/team/src".',
  );

  const startDeny = (await preExecutePolicy(
    {
      name: "container_start",
      arguments: {
        container: "web",
        mounts: [
          { project: "team", mode: "read_only" },
          { kind: "project", project: "team", destination: "/x" },
        ],
      },
    },
    () => Promise.resolve({ kind: "allow" }),
    () => "/projects",
  )) as { kind: string };
  assert.equal(startDeny.kind, "deny", "a mounts array with a project destination must deny");

  const volumeAllowed = (await preExecutePolicy(
    {
      name: "container_mount_add",
      arguments: { kind: "volume", volume: "data", destination: "/data" },
    },
    () => Promise.resolve({ kind: "ask", reason: "x" }),
  )) as { kind: string };
  assert.equal(volumeAllowed.kind, "ask", "non-project mounts with a destination must still ask");

  const underNever = (await preExecutePolicy(
    {
      name: "container_mount_add",
      arguments: { kind: "project", project: "team", destination: "/x" },
      agent: { session: { facts: { policy: "never" } } },
    },
    () => Promise.resolve({ kind: "allow" }),
    () => "/projects",
    undefined,
    testReadSession,
  )) as { kind: string };
  assert.equal(underNever.kind, "deny", "full access must not accept an invalid project mount");
});

test("mount tools are registered with the expected schemas", () => {
  const listTool = TOOLS.find((entry) => entry.name === "container_mount_list");
  assert.ok(listTool, "container_mount_list registered");
  assert.notEqual(listTool!.approval, true, "container_mount_list must not require approval");
  assert.deepEqual(listTool!.parameters.required, ["container"]);

  const addTool = TOOLS.find((entry) => entry.name === "container_mount_add");
  assert.ok(addTool, "container_mount_add registered");
  assert.equal(addTool!.approval, true, "container_mount_add must require approval");
  assert.deepEqual(addTool!.parameters.required, ["container"]);
  assert.deepEqual(addTool!.parameters.properties.mode.enum, [
    "read_only",
    "read_write",
  ]);
  assert.deepEqual(addTool!.parameters.properties.kind.enum, [
    "project",
    "tmpfs",
    "volume",
    "secret",
  ]);
  assert.equal(
    typeof addTool!.parameters.properties.volume,
    "object",
    "container_mount_add accepts a volume",
  );
  assert.equal(
    typeof addTool!.parameters.properties.secret,
    "object",
    "container_mount_add accepts a secret",
  );

  const removeTool = TOOLS.find((entry) => entry.name === "container_mount_remove");
  assert.ok(removeTool, "container_mount_remove registered");
  assert.equal(removeTool!.approval, true, "container_mount_remove must require approval");
  assert.deepEqual(removeTool!.parameters.required, ["container"]);
  assert.deepEqual(removeTool!.parameters.properties.kind.enum, [
    "project",
    "tmpfs",
    "volume",
    "secret",
  ]);
  assert.equal(
    typeof removeTool!.parameters.properties.volume,
    "object",
    "container_mount_remove accepts a volume",
  );
  assert.equal(
    typeof removeTool!.parameters.properties.secret,
    "object",
    "container_mount_remove accepts a secret",
  );
  assert.equal(
    typeof removeTool!.parameters.properties.destination,
    "object",
    "container_mount_remove accepts a destination",
  );

  const updateTool = TOOLS.find((entry) => entry.name === "container_mount_update");
  assert.ok(updateTool, "container_mount_update registered");
  assert.equal(updateTool!.approval, true, "container_mount_update must require approval");
  assert.deepEqual(updateTool!.parameters.required, ["container", "mode"]);
  assert.deepEqual(updateTool!.parameters.properties.kind.enum, [
    "project",
    "volume",
  ]);
  assert.deepEqual(updateTool!.parameters.properties.mode.enum, [
    "read_only",
    "read_write",
  ]);
  assert.equal(
    typeof updateTool!.parameters.properties.destination,
    "object",
    "container_mount_update accepts a destination",
  );
});

test("an omitted mount kind is inferred from the source field", async () => {
  const { requests, resolver } = mountRequestRecorder();
  await toolHandlers.container_mount_remove(
    resolver as never,
    { container: "valkey-ctr", secret: "valkey-tls" },
    MOUNT_EXEC,
  );
  await toolHandlers.container_mount_add(
    resolver as never,
    { container: "valkey-ctr", volume: "valkey-data", destination: "/data" },
    MOUNT_EXEC,
  );
  assert.deepEqual(requests[0], [
    "removeContainerMount",
    {
      workspaceSlug: WORKSPACE_ID,
      container: "valkey-ctr",
      kind: "MOUNT_KIND_SECRET",
      secret: "valkey-tls",
    },
  ]);
  assert.deepEqual(requests[1], [
    "addContainerMount",
    {
      workspaceSlug: WORKSPACE_ID,
      container: "valkey-ctr",
      kind: "MOUNT_KIND_VOLUME",
      volume: "valkey-data",
      destination: "/data",
      mode: "MOUNT_MODE_READ_ONLY",
    },
  ]);
});

test("container_mount_update maps the selector and mode", async () => {
  const { requests, resolver } = mountRequestRecorder();
  await toolHandlers.container_mount_update(
    resolver as never,
    { container: "valkey-ctr", kind: "project", project: "team/src", mode: "read_only" },
    MOUNT_EXEC,
  );
  await toolHandlers.container_mount_update(
    resolver as never,
    { container: "valkey-ctr", volume: "valkey-data", destination: "/data", mode: "read_write" },
    MOUNT_EXEC,
  );
  assert.deepEqual(requests[0], [
    "updateContainerMount",
    {
      workspaceSlug: WORKSPACE_ID,
      container: "valkey-ctr",
      kind: "MOUNT_KIND_PROJECT",
      project: "team/src",
      mode: "MOUNT_MODE_READ_ONLY",
    },
  ]);
  assert.deepEqual(requests[1], [
    "updateContainerMount",
    {
      workspaceSlug: WORKSPACE_ID,
      container: "valkey-ctr",
      kind: "MOUNT_KIND_VOLUME",
      volume: "valkey-data",
      destination: "/data",
      mode: "MOUNT_MODE_READ_WRITE",
    },
  ]);
});

test("container_mount_update rejects kinds without a mode", async () => {
  const { requests, resolver } = mountRequestRecorder();
  await assert.rejects(
    () =>
      toolHandlers.container_mount_update(
        resolver as never,
        { container: "web", kind: "tmpfs", destination: "/mnt", mode: "read_only" },
        MOUNT_EXEC,
      ),
    /only project and volume mounts carry a mode; tmpfs mounts cannot be remounted/,
  );
  await assert.rejects(
    () =>
      toolHandlers.container_mount_update(
        resolver as never,
        { container: "web", project: "team", mode: "rw" },
        MOUNT_EXEC,
      ),
    /unknown mount mode: rw/,
  );
  assert.deepEqual(requests, [], "a rejected update must not reach the orchestrator");
});

test("summarizeArgs renders the remount reason", () => {
  assert.equal(
    summarizeArgs("container_mount_update", {
      container: "valkey-ctr",
      kind: "project",
      project: "team",
      mode: "read_only",
    }),
    'Update mount in container "valkey-ctr": remount project "team" to read-only.',
  );
  assert.equal(
    summarizeArgs("container_mount_update", {
      container: "valkey-ctr",
      volume: "data",
      destination: "/data",
      mode: "read_write",
    }),
    'Update mount in container "valkey-ctr": remount volume "data" at "/data" to read-write.',
  );
});

test("container_mount_add rejects unknown mount kinds and modes", async () => {
  const { requests, resolver } = mountRequestRecorder();
  await assert.rejects(
    () =>
      toolHandlers.container_mount_add(
        resolver as never,
        { container: "web", kind: "bind", project: "team" },
        MOUNT_EXEC,
      ),
    /unknown mount kind: bind/,
  );
  await assert.rejects(
    () =>
      toolHandlers.container_mount_add(
        resolver as never,
        { container: "web", project: "team", mode: "rw" },
        MOUNT_EXEC,
      ),
    /unknown mount mode: rw/,
  );
  assert.deepEqual(requests, [], "a rejected mount must not reach the orchestrator");
});

test("container_mount_add rejects a destination on a project mount", async () => {
  const { requests, resolver } = mountRequestRecorder();
  await assert.rejects(
    () =>
      toolHandlers.container_mount_add(
        resolver as never,
        { container: "web", kind: "project", project: "team/src", destination: "/custom" },
        MOUNT_EXEC,
      ),
    /Project mounts cannot set a destination; "team\/src" always mounts at "\/projects\/team\/src"/,
  );
  await assert.rejects(
    () =>
      toolHandlers.container_mount_add(
        resolver as never,
        { container: "web", project: "team", destination: "/custom" },
        MOUNT_EXEC,
      ),
    /Project mounts cannot set a destination/,
  );
  assert.deepEqual(requests, [], "a rejected mount must not reach the orchestrator");

  await toolHandlers.container_mount_add(
    resolver as never,
    { container: "web", kind: "volume", volume: "data", destination: "/data" },
    MOUNT_EXEC,
  );
  assert.equal(requests.length, 1, "a volume mount with a destination is still accepted");
});

test("container_start rejects a destination on a project mount", async () => {
  const { requests, resolver } = mountRequestRecorder();
  await assert.rejects(
    () =>
      toolHandlers.container_start(
        resolver as never,
        {
          container: "web",
          image: "img1",
          mounts: [{ project: "team", destination: "/custom" }],
        },
        MOUNT_EXEC,
      ),
    /Project mounts cannot set a destination/,
  );
  assert.deepEqual(requests, [], "a rejected mount must not reach the orchestrator");
});

test("container_mount_remove rejects unknown mount kinds", async () => {
  const { requests, resolver } = mountRequestRecorder();
  await assert.rejects(
    () =>
      toolHandlers.container_mount_remove(
        resolver as never,
        { container: "web", kind: "bind", project: "team" },
        MOUNT_EXEC,
      ),
    /unknown mount kind: bind/,
  );
  assert.deepEqual(requests, [], "a rejected mount must not reach the orchestrator");
});

test("adding a tmpfs mount without a mode stays read_write", async () => {
  // The orchestrator rejects a read-only tmpfs, so the read-only default must
  // not apply to it.
  const { requests, resolver } = mountRequestRecorder();
  await toolHandlers.container_mount_add(
    resolver as never,
    { container: "web", kind: "tmpfs", destination: "/scratch" },
    MOUNT_EXEC,
  );
  assert.deepEqual(requests, [
    ["addContainerMount", {
      workspaceSlug: WORKSPACE_ID,
      container: "web",
      kind: "MOUNT_KIND_TMPFS",
      destination: "/scratch",
      mode: "MOUNT_MODE_READ_WRITE",
    }],
  ]);
});

test("mount tools default a missing kind to project and a missing mode to read_only", async () => {
  const { requests, resolver } = mountRequestRecorder();
  await toolHandlers.container_mount_add(
    resolver as never,
    { container: "web", project: "team" },
    MOUNT_EXEC,
  );
  await toolHandlers.container_mount_add(
    resolver as never,
    {
      container: "web",
      kind: "volume",
      volume: "valkey-data",
      destination: "/data",
      mode: "read_only",
    },
    MOUNT_EXEC,
  );
  await toolHandlers.container_mount_remove(
    resolver as never,
    { container: "web", project: "team" },
    MOUNT_EXEC,
  );
  assert.deepEqual(requests, [
    ["addContainerMount", {
      workspaceSlug: WORKSPACE_ID,
      container: "web",
      kind: "MOUNT_KIND_PROJECT",
      project: "team",
      mode: "MOUNT_MODE_READ_ONLY",
    }],
    ["addContainerMount", {
      workspaceSlug: WORKSPACE_ID,
      container: "web",
      kind: "MOUNT_KIND_VOLUME",
      volume: "valkey-data",
      destination: "/data",
      mode: "MOUNT_MODE_READ_ONLY",
    }],
    ["removeContainerMount", {
      workspaceSlug: WORKSPACE_ID,
      container: "web",
      kind: "MOUNT_KIND_PROJECT",
      project: "team",
    }],
  ]);
});

test("container start and recreate reject unknown mount kinds and modes", async () => {
  const { requests, resolver } = mountRequestRecorder();
  await assert.rejects(
    () =>
      toolHandlers.container_start(
        resolver as never,
        { container: "web", mounts: [{ project: "team", kind: "bind" }] },
        MOUNT_EXEC,
      ),
    /unknown mount kind: bind/,
  );
  await assert.rejects(
    () =>
      toolHandlers.container_recreate(
        resolver as never,
        { container: "web", mounts: [{ project: "team", mode: "rw" }] },
        MOUNT_EXEC,
      ),
    /unknown mount mode: rw/,
  );
  assert.deepEqual(requests, [], "a rejected mount must not reach the orchestrator");
});

test("container start maps valid mounts and defaults the mode to read_only", async () => {
  const { requests, resolver } = mountRequestRecorder();
  await toolHandlers.container_start(
    resolver as never,
    {
      container: "web",
      image: "img1",
      mounts: [
        { project: "team/src", mode: "read_only" },
        { project: "team", mode: "read_write" },
        { kind: "volume", volume: "valkey-data", destination: "/data" },
        { kind: "secret", secret: "valkey-tls", destination: "/run/secrets/tls" },
        { kind: "tmpfs", destination: "/scratch" },
      ],
    },
    MOUNT_EXEC,
  );
  assert.deepEqual(requests, [
    ["startContainer", {
      workspaceSlug: WORKSPACE_ID,
      container: "web",
      imageId: "img1",
      mounts: [
        {
          projectName: "team/src",
          kind: "MOUNT_KIND_PROJECT",
          mode: "MOUNT_MODE_READ_ONLY",
        },
        {
          projectName: "team",
          kind: "MOUNT_KIND_PROJECT",
          mode: "MOUNT_MODE_READ_WRITE",
        },
        {
          projectName: "",
          kind: "MOUNT_KIND_VOLUME",
          mode: "MOUNT_MODE_READ_ONLY",
          destination: "/data",
          volume: "valkey-data",
        },
        {
          projectName: "",
          kind: "MOUNT_KIND_SECRET",
          mode: "MOUNT_MODE_READ_ONLY",
          destination: "/run/secrets/tls",
          secret: "valkey-tls",
        },
        {
          projectName: "",
          kind: "MOUNT_KIND_TMPFS",
          mode: "MOUNT_MODE_READ_WRITE",
          destination: "/scratch",
        },
      ],
    }],
  ]);
});

test("mount schemas are object-rooted without per-property required", () => {
  for (const name of MOUNT_TOOLS) {
    const tool = TOOLS.find((entry) => entry.name === name);
    assert.ok(tool, `${name} registered`);
    assert.equal(tool!.parameters.type, "object", `${name} type`);
    assert.equal(typeof tool!.parameters.properties, "object");
    assert.ok(Array.isArray(tool!.parameters.required));
    for (const key of Object.keys(tool!.parameters.properties)) {
      const property: any = tool!.parameters.properties[key];
      assert.ok(
        !Object.prototype.hasOwnProperty.call(property, "required"),
        `${name}.${key} must not carry per-property required`,
      );
    }
  }
  for (const name of ["container_start", "container_recreate"]) {
    const tool = TOOLS.find((entry) => entry.name === name);
    assert.ok(tool, `${name} registered`);
    const mounts = tool!.parameters.properties.mounts;
    assert.equal(mounts.type, "array", `${name}.mounts type`);
    assert.equal(mounts.items.type, "object", `${name}.mounts items type`);
    assert.equal(mounts.items.additionalProperties, false);
    assert.deepEqual(mounts.items.required, []);
    for (const key of Object.keys(mounts.items.properties)) {
      const property = mounts.items.properties[key];
      assert.ok(
        !Object.prototype.hasOwnProperty.call(property, "required"),
        `${name}.mounts.items.${key} must not carry per-property required`,
      );
    }
  }
});

test("container_mount_list returns mount objects", async () => {
  const resolver = {
    registry: {
      resolveByPath: async () => ({ id: WORKSPACE_ID }),
    },
    control: async () => ({
      containers: [
        {
          workspaceSlug: WORKSPACE_ID,
          containerName: "default",
          mounts: [
            { projectName: "team", mode: "MOUNT_MODE_READ_WRITE", kind: "MOUNT_KIND_PROJECT" },
            { volume: "myvol", destination: "/data", mode: "MOUNT_MODE_READ_ONLY", kind: "MOUNT_KIND_VOLUME" },
          ],
        },
      ],
    }),
  } as never;
  const exec = { agent: { session: { header: { cwd: "/projects/team" } } } };
  const out = await toolHandlers.container_mount_list(
    resolver,
    { container: "default" },
    exec,
  );
  assert.deepEqual(out, [
    { projectName: "team", mode: "read_write", kind: "project" },
    { volume: "myvol", destination: "/data", mode: "read_only", kind: "volume" },
  ]);
});

test("command tools default to the session directory when mounted", async () => {
  const exec = { agent: { session: { header: { cwd: "/projects/team" } } } };

  const bash = guestExecRecorder("/projects/team");
  await toolHandlers.container_bash(
    bash.resolver as never,
    { container: "default", command: "ls" },
    exec,
  );
  assert.equal(bash.starts[0].cwd, "/projects/team");

  const run = guestExecRecorder("/projects/team");
  await toolHandlers.container_exec(
    run.resolver as never,
    { container: "default", argv: ["ls"] },
    exec,
  );
  assert.equal(run.starts[0].cwd, "/projects/team");

  const glob = guestExecRecorder("/projects/team");
  await toolHandlers.container_glob(
    glob.resolver as never,
    { container: "default", pattern: "*.ts" },
    exec,
  );
  assert.equal(glob.starts[0].cwd, "/projects/team");

  const grep = guestExecRecorder("/projects/team");
  await toolHandlers.container_grep(
    grep.resolver as never,
    { container: "default", pattern: "TODO" },
    exec,
  );
  assert.equal(grep.starts[0].cwd, "/projects/team");
});

test("command tools fall back to the guest cwd when the session directory is not mounted", async () => {
  const exec = { agent: { session: { header: { cwd: "/projects/team" } } } };

  const bare = guestExecRecorder();
  await toolHandlers.container_exec(
    bare.resolver as never,
    { container: "db", argv: ["ls"] },
    exec,
  );
  assert.equal(bare.starts[0].cwd, undefined);

  // An explicit working directory still resolves without a mounted default.
  const explicit = guestExecRecorder();
  await toolHandlers.container_exec(
    explicit.resolver as never,
    { container: "db", argv: ["ls"], workdir: "/data" },
    exec,
  );
  assert.equal(explicit.starts[0].cwd, "/data");
});
