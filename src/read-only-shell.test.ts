// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import { createReadOnlyShellGate, READ_ONLY_GATED_TOOLS, REMOUNT_TOOL_NAME } from "./index.js";
import { WORKSPACE_ID } from "./test-support.js";

const EXEC = {
  name: "bash",
  arguments: {},
  agent: { session: { header: { cwd: "/proj" } } },
};

// A resolver whose control plane reports one container with the given mounts,
// recording every control call; the gate's approval is recorded by reason.
function gateFixture(
  mounts: unknown[] | undefined,
  options: { approve?: boolean; containerName?: string } = {},
) {
  const controlCalls: Array<[string, any]> = [];
  const approvals: string[] = [];
  const containerName = options.containerName ?? "default";
  const resolver = {
    registry: { resolveByPath: async () => ({ id: WORKSPACE_ID }) },
    getConfig: () => ({ projectsRoot: "/projects" }),
    async control(method: string, request: unknown) {
      controlCalls.push([method, request as any]);
      if (method === "listContainers") {
        return mounts === undefined ? { containers: [] } : {
          containers: [
            {
              workspaceSlug: WORKSPACE_ID,
              containerName,
              mounts,
            },
          ],
        };
      }
      return {};
    },
  } as any;
  const gate = createReadOnlyShellGate({
    resolver,
    approve: async (_exec, reason) => {
      approvals.push(reason);
      return options.approve ?? true;
    },
  });
  return { gate, controlCalls, approvals };
}

test("the gate ignores tools outside its set", async () => {
  const { gate, controlCalls } = gateFixture([]);
  assert.equal(await gate({ ...EXEC, name: "image_list" }, "en"), undefined);
  assert.equal(await gate({ ...EXEC, name: "container_read" }, "en"), undefined);
  assert.deepEqual(controlCalls, []);
});

test("the gate covers the shell, file, and daemon tools", () => {
  assert.deepEqual([...READ_ONLY_GATED_TOOLS].sort(), [
    "bash",
    "container_bash",
    "container_edit",
    "container_exec",
    "container_write",
    "daemon_start",
    "edit",
    "pwsh",
    "write",
  ]);
  assert.equal(REMOUNT_TOOL_NAME, "dsh_podman_builtin_remount_read_only");
});

test("all mounts read-only allows the tool without a prompt", async () => {
  const { gate, controlCalls, approvals } = gateFixture([
    { projectName: "team", kind: "MOUNT_KIND_PROJECT", mode: "MOUNT_MODE_READ_ONLY" },
    { kind: "MOUNT_KIND_TMPFS", destination: "/scratch", mode: "MOUNT_MODE_READ_WRITE" },
    { kind: "MOUNT_KIND_SECRET", secret: "tls", destination: "/run/secrets/tls" },
  ]);
  assert.deepEqual(await gate(EXEC, "en"), { kind: "allow" });
  assert.deepEqual(approvals, []);
  assert.equal(
    controlCalls.filter(([method]) => method === "recreateContainer").length,
    0,
  );
});

test("a read-write mount prompts and then remounts read-only", async () => {
  const { gate, controlCalls, approvals } = gateFixture([
    { projectName: "team", kind: "MOUNT_KIND_PROJECT", mode: "MOUNT_MODE_READ_WRITE" },
    {
      kind: "MOUNT_KIND_VOLUME",
      volume: "data",
      destination: "/data",
      mode: "MOUNT_MODE_READ_WRITE",
    },
    { kind: "MOUNT_KIND_TMPFS", destination: "/scratch", mode: "MOUNT_MODE_READ_WRITE" },
    { kind: "MOUNT_KIND_SECRET", secret: "tls", destination: "/run/secrets/tls" },
  ]);
  assert.deepEqual(await gate(EXEC, "en"), { kind: "allow" });
  assert.equal(approvals.length, 1);
  assert.match(approvals[0], /Read-only mode blocks "bash"/);
  assert.match(approvals[0], /- project "team" \(read-write\)/);
  assert.match(approvals[0], /- volume "data" at "\/data" \(read-write\)/);
  assert.match(approvals[0], /Kept as-is: tmpfs at "\/scratch"/);
  const recreate = controlCalls.filter(([method]) => method === "recreateContainer");
  assert.equal(recreate.length, 1);
  assert.deepEqual(recreate[0][1], {
    workspaceSlug: WORKSPACE_ID,
    container: "default",
    mounts: [
      { projectName: "team", kind: "MOUNT_KIND_PROJECT", mode: "MOUNT_MODE_READ_ONLY" },
      {
        projectName: "",
        kind: "MOUNT_KIND_VOLUME",
        mode: "MOUNT_MODE_READ_ONLY",
        destination: "/data",
        volume: "data",
      },
      {
        projectName: "",
        kind: "MOUNT_KIND_TMPFS",
        mode: "MOUNT_MODE_READ_WRITE",
        destination: "/scratch",
      },
      {
        projectName: "",
        kind: "MOUNT_KIND_SECRET",
        destination: "/run/secrets/tls",
        secret: "tls",
      },
    ],
  });
});

test("a declined prompt denies without remounting", async () => {
  const { gate, controlCalls, approvals } = gateFixture(
    [{ projectName: "team", kind: "MOUNT_KIND_PROJECT", mode: "MOUNT_MODE_READ_WRITE" }],
    { approve: false },
  );
  const decision = (await gate(EXEC, "en")) as { kind: string; reason: string };
  assert.equal(decision.kind, "deny");
  assert.match(decision.reason, /mounts were not remounted/);
  assert.equal(approvals.length, 1);
  assert.equal(
    controlCalls.filter(([method]) => method === "recreateContainer").length,
    0,
  );
});

test("an unreadable container falls through to the plain denial", async () => {
  const { gate, approvals } = gateFixture(undefined);
  assert.equal(await gate(EXEC, "en"), undefined);
  assert.deepEqual(approvals, []);
});

test("a plugin tool targets its own container", async () => {
  const { gate, controlCalls } = gateFixture(
    [{ projectName: "team", kind: "MOUNT_KIND_PROJECT", mode: "MOUNT_MODE_READ_ONLY" }],
    { containerName: "web" },
  );
  const exec = {
    name: "container_bash",
    arguments: { container: "web" },
    agent: { session: { header: { cwd: "/proj" } } },
  };
  assert.deepEqual(await gate(exec, "en"), { kind: "allow" });
  assert.equal(controlCalls[0][0], "listContainers");
});
