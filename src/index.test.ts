// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  remoteArgv,
  outputReader,
  createSubprocessProvider,
  createFilesystemProvider,
  TOOLS,
  toolHandlers,
  imageRemoveParameters,
  approvalDecision,
  preExecutePolicy,
  summarizeArgs,
  resolveGuestPath,
  resolveGuestCwd,
  foldSandboxMode,
  foldApprovalPolicy,
  READ_ONLY_TOOLS,
  PODMAN_OPS_PRESET_YML,
  PODMAN_OPS_AGENT_CORDIS_YML,
  ensurePodmanOpsPreset,
  publicContainer,
  toolCallView,
  toolResultView,
  HARNESS_SOURCE_SECTION,
  withoutHarnessSourceSection,
  podmanRuntimeSection,
} from "./index.js";

test("remoteArgv remaps ripgrep onto the guest path", () => {
  assert.deepEqual(remoteArgv(["rg", "-n", "foo"]), [
    "/usr/bin/rg",
    "-n",
    "foo",
  ]);
  assert.deepEqual(remoteArgv(["/usr/bin/rg", "-l", "x"]), [
    "/usr/bin/rg",
    "-l",
    "x",
  ]);
});

test("remoteArgv unwraps landlock-run wrappers", () => {
  assert.deepEqual(remoteArgv(["landlock-run", "--", "/usr/bin/rg", "-l"]), [
    "/usr/bin/rg",
    "-l",
  ]);
  assert.deepEqual(
    remoteArgv(["landlock-run", "--", "rg", "-l", "src"]),
    ["/usr/bin/rg", "-l", "src"],
  );
});

test("remoteArgv leaves ordinary commands untouched", () => {
  assert.deepEqual(remoteArgv(["bash", "-c", "echo hi"]), [
    "bash",
    "-c",
    "echo hi",
  ]);
  assert.deepEqual(remoteArgv(["landlock-run", "cmd", "arg"]), [
    "landlock-run",
    "cmd",
    "arg",
  ]);
  assert.deepEqual(remoteArgv([]), []);
});

test("outputReader is undefined without a bounded mode", () => {
  assert.equal(outputReader(undefined), undefined);
  assert.equal(outputReader(null), undefined);
  assert.equal(outputReader("pipe"), undefined);
  assert.equal(outputReader({ maxBytes: -1 }), undefined);
  assert.equal(outputReader({ maxBytes: Number.NaN }), undefined);
});

test("outputReader reads appended output", () => {
  const reader = outputReader({ maxBytes: 16 })!;
  reader.append(Buffer.from("hello "));
  reader.append(Buffer.from("world"));
  const first = reader.readFrom(0);
  assert.equal(first.text, "hello world");
  assert.equal(first.nextOffset, 11);
  assert.equal(first.lossy, false);
});

test("outputReader drops bytes beyond the retention window", () => {
  const reader = outputReader({ maxBytes: 5 })!;
  reader.append(Buffer.from("hello"));
  reader.append(Buffer.from("world"));
  const read = reader.readFrom(0);
  assert.equal(read.text, "world");
  assert.equal(read.nextOffset, 10);
  assert.equal(read.lossy, true);
});

test("outputReader honors in-window offsets", () => {
  const reader = outputReader({ maxBytes: 5 })!;
  reader.append(Buffer.from("abcdefghij"));
  const atStart = reader.readFrom(5);
  assert.equal(atStart.text, "fghij");
  assert.equal(atStart.lossy, false);
  const pastEnd = reader.readFrom(10);
  assert.equal(pastEnd.text, "");
  assert.equal(pastEnd.lossy, false);
});

test("resolveExecutable resolves guest binaries", async () => {
  const provider = createSubprocessProvider({} as any);
  assert.equal(await provider.resolveExecutable("/abs/path"), "/abs/path");
  assert.equal(await provider.resolveExecutable("git"), "/usr/bin/git");
});

test("resolveExecutable rejects invalid names", async () => {
  const provider = createSubprocessProvider({} as any);
  await assert.rejects(() => provider.resolveExecutable(""));
  await assert.rejects(() => provider.resolveExecutable("bin/tool"));
});

class FakeTerminalCall extends EventEmitter {
  readonly stdinChunks: Buffer[] = [];

  write(message: any): void {
    if (message.start) {
      queueMicrotask(() => this.emit("data", { started: { pid: 42 } }));
      return;
    }
    if (message.stdinChunk) {
      this.stdinChunks.push(Buffer.from(message.stdinChunk));
      return;
    }
    if (message.inspectRequestId !== undefined) {
      const requestId = message.inspectRequestId;
      queueMicrotask(() =>
        this.emit("data", {
          foreground: { requestId, found: true, processGroupId: 7, inputWaiting: true },
        }),
      );
      return;
    }
    if (message.signal) {
      const requestId = message.signal.requestId;
      queueMicrotask(() =>
        this.emit("data", {
          signalled: { requestId, found: true, processGroupId: 7 },
        }),
      );
    }
  }

  end(): void {}

  cancel(): void {}

  emitStdout(data: Buffer): void {
    this.emit("data", { stdoutChunk: data });
  }

  emitExit(exitCode = 0, signaled = false): void {
    this.emit("data", { exit: { exitCode, signaled, signal: "" } });
    this.emit("end");
  }
}

const fakeTerminalResolver = (fake: FakeTerminalCall): any => ({
  resolveForPath: async () => ({
    guest: { terminal: () => fake },
    token: "t",
  }),
});

test("spawnTerminal drives the guest terminal stream", async () => {
  const fake = new FakeTerminalCall();
  const provider = createSubprocessProvider(fakeTerminalResolver(fake));
  const handle = await provider.spawnTerminal({
    argv: ["bash"],
    cwd: "/projects/team",
    rows: 24,
    cols: 80,
    graceMs: 1000,
  });
  assert.equal(handle.pid, 42);

  const chunks: Buffer[] = [];
  handle.output.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
  const outputEnded = new Promise<void>((resolve) =>
    handle.output.on("end", resolve),
  );

  fake.emitStdout(Buffer.from("hello"));
  await handle.write("ls\n");
  assert.deepEqual(
    fake.stdinChunks.map((chunk) => chunk.toString("utf8")),
    ["ls\n"],
  );

  assert.deepEqual(await handle.inspectForeground(), {
    processGroupId: 7,
    inputWaiting: true,
  });
  assert.equal(await handle.signalForeground("SIGINT"), 7);

  fake.emitExit(0, false);
  assert.deepEqual(await handle.done, { exitCode: 0, signal: null });
  await outputEnded;
  assert.equal(Buffer.concat(chunks).toString("utf8"), "hello");

  await handle.terminate();
});

test("spawnTerminal rejects an empty argv", async () => {
  const provider = createSubprocessProvider(fakeTerminalResolver(new FakeTerminalCall()));
  await assert.rejects(
    () =>
      provider.spawnTerminal({ argv: [], cwd: "/projects/team", rows: 24, cols: 80 }),
    /argv must contain a program/,
  );
});

const stubResolver = {
  resolve: async () => ({ kind: "binding" }),
  resolveForPath: async () => ({ kind: "binding" }),
} as any;

test("filesystem provider resolves absolute safe paths", async () => {
  const provider = createFilesystemProvider(stubResolver);
  const target = await provider.resolve("/projects/team/app", { cwd: "/x" });
  assert.equal(target.targetKey, "/projects/team/app");
  assert.equal(target.displayPath, "/projects/team/app");
  assert.deepEqual(target.binding, { kind: "binding" });
});

test("filesystem provider resolves absolute paths without a cwd", async () => {
  const seen: Array<[string, unknown]> = [];
  const provider = createFilesystemProvider({
    resolve: async () => ({ kind: "binding" }),
    resolveForPath: async (path: string, cwd: unknown) => {
      seen.push([path, cwd]);
      return { kind: "binding" };
    },
  } as any);
  const target = await provider.resolve("/projects/team/app");
  assert.equal(target.targetKey, "/projects/team/app");
  assert.deepEqual(target.binding, { kind: "binding" });
  assert.deepEqual(seen, [["/projects/team/app", undefined]]);
});

test("filesystem provider resolves relative paths against the cwd", async () => {
  const provider = createFilesystemProvider(stubResolver);
  const target = await provider.resolve("README.md", {
    cwd: "/projects/team/app",
  });
  assert.equal(target.targetKey, "/projects/team/app/README.md");
  assert.equal(target.displayPath, "/projects/team/app/README.md");
  assert.deepEqual(target.binding, { kind: "binding" });
});

test("filesystem provider rejects unsafe paths", async () => {
  const provider = createFilesystemProvider(stubResolver);
  await assert.rejects(() => provider.resolve("/a/../b"));
  await assert.rejects(() => provider.resolve("/a/b/../../etc"));
  await assert.rejects(() =>
    provider.resolve("../escape", { cwd: "/projects/team/app" }),
  );
});

test("filesystem provider maps targets", () => {
  const provider = createFilesystemProvider(stubResolver);
  assert.equal(provider.fileUrl({ targetKey: "/a/b" }), "file:///a/b");
  assert.equal(provider.processPath({ targetKey: "/a/b" }), "/a/b");
  const parent = { targetKey: "/a" };
  assert.equal(provider.contains(parent, { targetKey: "/a" }), true);
  assert.equal(provider.contains(parent, { targetKey: "/a/b" }), true);
  assert.equal(provider.contains(parent, { targetKey: "/a2" }), false);
  assert.equal(provider.contains(parent, { targetKey: "/b" }), false);
});

const EXPECTED_TOOLS = [
  "image_list",
  "image_get",
  "image_build",
  "image_rebuild",
  "image_rebuild_all",
  "image_remove",
  "container_list",
  "container_start",
  "container_recreate",
  "container_remove",
  "container_bash",
  "container_exec",
  "container_read",
  "container_write",
  "container_edit",
  "container_glob",
  "container_grep",
  "container_mount_list",
  "container_mount_add",
  "container_mount_remove",
  "volume_list",
  "volume_create",
  "volume_remove",
  "secret_list",
  "secret_create",
  "secret_remove",
  "container_secret_add",
  "container_secret_remove",
  "daemon_start",
  "daemon_list",
  "daemon_stop",
  "daemon_restart",
  "daemon_logs",
];

test("tool set covers the image and container surface", () => {
  assert.deepEqual(
    TOOLS.map((tool) => tool.name).sort(),
    [...EXPECTED_TOOLS].sort(),
  );
});

test("every tool parameters is a valid JSON-Schema object", () => {
  for (const tool of TOOLS) {
    assert.equal(tool.parameters.type, "object", `${tool.name} type`);
    assert.equal(typeof tool.parameters.properties, "object");
    assert.ok(Array.isArray(tool.parameters.required));
    for (const key of Object.keys(tool.parameters.properties)) {
      const property = tool.parameters.properties[key];
      assert.ok(
        !Object.prototype.hasOwnProperty.call(property, "required"),
        `${tool.name}.${key} must not carry per-property required`,
      );
      assert.ok(
        !Array.isArray(property.required),
        `${tool.name}.${key} must not carry a required array`,
      );
    }
  }
});

test("the destructive mutations require approval", () => {
  const approval = TOOLS.filter((tool) => tool.approval)
    .map((tool) => tool.name)
    .sort();
  assert.deepEqual(approval, [
    "container_mount_add",
    "container_mount_remove",
    "container_recreate",
    "container_remove",
    "container_secret_add",
    "container_secret_remove",
    "image_build",
    "image_rebuild",
    "image_rebuild_all",
    "image_remove",
    "secret_remove",
    "volume_remove",
  ]);
});

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
      { project: "team", path: "src", mode: "read_only" },
      { project: "team", destination: "/workspace/team", mode: "read_write" },
    ],
  });
  assert.ok(decision, "mounts passed: must ask");
  assert.equal(decision!.kind, "ask");
  assert.equal(
    decision!.reason,
    "start container web with localhost/dsh-podman/nginx:latest • mounts: team/src (ro), team → /workspace/team",
  );
});

test("approvalDecision gates exactly the approval-flagged tools", () => {
  const sampleArgs: Record<string, Record<string, unknown>> = {
    image_build: {
      imageId: "valkey",
      parent: "archlinux",
      packages: ["valkey"],
    },
    image_rebuild: { imageId: "valkey" },
    image_remove: { imageId: "valkey" },
    container_recreate: {
      container: "valkey-ctr",
      image: "localhost/dsh-podman/nginx:latest",
      mounts: [{ project: "team", mode: "read_only" }],
    },
    container_remove: { container: "valkey-ctr" },
    volume_remove: { name: "valkey-data" },
    container_mount_add: {
      container: "valkey-ctr",
      kind: "volume",
      volume: "valkey-data",
      destination: "/data",
      mode: "read_write",
    },
    container_mount_remove: {
      container: "valkey-ctr",
      kind: "volume",
      volume: "valkey-data",
      destination: "/data",
    },
    secret_remove: { name: "valkey-pass" },
    container_secret_add: {
      container: "valkey-ctr",
      env: "REDIS_PASSWORD",
      secret: "valkey-pass",
    },
    container_secret_remove: {
      container: "valkey-ctr",
      env: "REDIS_PASSWORD",
    },
  };
  for (const tool of TOOLS) {
    const decision = approvalDecision(tool.name, sampleArgs[tool.name] ?? {});
    if (tool.approval === true) {
      assert.ok(decision, `${tool.name} must ask for approval`);
      assert.equal(decision!.kind, "ask");
      assert.ok((decision!.reason ?? "").length > 0, `${tool.name} ask reason`);
    } else {
      assert.equal(decision, undefined, `${tool.name} must not ask`);
    }
  }
  assert.equal(approvalDecision("no_such_tool"), undefined);
});

test("summarizeArgs renders the approval reason for each gated tool", () => {
  assert.equal(
    summarizeArgs("image_build", {
      imageId: "valkey",
      parent: "archlinux",
      packages: ["valkey"],
    }),
    "build image valkey from archlinux • packages: valkey",
  );
  assert.equal(
    summarizeArgs("image_build", {
      imageId: "dev",
      parent: "archlinux",
      packages: ["git", "curl", "tmux", "vim", "zsh", "openssh", "jq", "ripgrep", "make", "cc", "go"],
    }),
    "build image dev from archlinux • packages: git, curl, tmux, vim, zsh, openssh, jq, ripgrep, +3 more",
  );
  assert.equal(summarizeArgs("image_rebuild", { imageId: "valkey" }), "rebuild image valkey");
  assert.equal(summarizeArgs("image_rebuild_all", {}), "rebuild all images");
  assert.equal(summarizeArgs("image_remove", { imageId: "valkey" }), "remove image valkey");
  assert.equal(
    summarizeArgs("container_recreate", { container: "valkey-ctr" }),
    "recreate container valkey-ctr",
  );
  assert.equal(
    summarizeArgs("container_remove", { container: "valkey-ctr" }),
    "remove container valkey-ctr",
  );
  assert.equal(
    summarizeArgs("volume_remove", { name: "valkey-data" }),
    "remove volume valkey-data",
  );
  assert.equal(
    summarizeArgs("container_start", {
      container: "web",
      image: "localhost/dsh-podman/nginx:latest",
      mounts: [
        { project: "team", path: "src", mode: "read_only" },
        { project: "team", destination: "/workspace/team", mode: "read_write" },
      ],
    }),
    "start container web with localhost/dsh-podman/nginx:latest • mounts: team/src (ro), team → /workspace/team",
  );
  assert.equal(
    summarizeArgs("container_recreate", {
      container: "valkey-ctr",
      image: "localhost/dsh-podman/nginx:latest",
      mounts: [
        { project: "team", path: "src", mode: "read_only" },
        { project: "team", destination: "/workspace/team", mode: "read_write" },
      ],
    }),
    "recreate container valkey-ctr with localhost/dsh-podman/nginx:latest • mounts: team/src (ro), team → /workspace/team",
  );
  assert.equal(
    summarizeArgs("container_mount_add", {
      container: "valkey-ctr",
      kind: "volume",
      volume: "valkey-data",
      destination: "/data",
      mode: "read_write",
    }),
    "container valkey-ctr: mount volume valkey-data at /data",
  );
  assert.equal(
    summarizeArgs("container_mount_add", {
      container: "valkey-ctr",
      kind: "project",
      project: "team",
      path: "src",
      destination: "/workspace/team",
      mode: "read_only",
    }),
    "container valkey-ctr: mount directory team/src at /workspace/team (ro)",
  );
  assert.equal(
    summarizeArgs("container_mount_add", {
      container: "valkey-ctr",
      kind: "tmpfs",
      destination: "/dev/shm",
      mode: "read_write",
    }),
    "container valkey-ctr: mount tmpfs at /dev/shm",
  );
  assert.equal(
    summarizeArgs("container_mount_remove", {
      container: "valkey-ctr",
      kind: "volume",
      volume: "valkey-data",
      destination: "/data",
    }),
    "container valkey-ctr: unmount volume valkey-data at /data",
  );
  assert.equal(
    summarizeArgs("container_mount_remove", {
      container: "valkey-ctr",
      kind: "project",
      project: "team",
      path: "src",
    }),
    "container valkey-ctr: unmount directory team/src",
  );
  assert.equal(
    summarizeArgs("secret_remove", { name: "valkey-pass" }),
    "remove secret valkey-pass",
  );
  assert.equal(
    summarizeArgs("container_secret_add", {
      container: "valkey-ctr",
      env: "REDIS_PASSWORD",
      secret: "valkey-pass",
    }),
    "container valkey-ctr: add secret valkey-pass as REDIS_PASSWORD",
  );
  assert.equal(
    summarizeArgs("container_secret_remove", {
      container: "valkey-ctr",
      env: "REDIS_PASSWORD",
    }),
    "container valkey-ctr: remove secret REDIS_PASSWORD",
  );
  assert.equal(
    summarizeArgs("container_mount_add", {
      container: "valkey-ctr",
      kind: "secret",
      secret: "valkey-tls",
      destination: "/run/secrets/tls",
    }),
    "container valkey-ctr: mount secret valkey-tls at /run/secrets/tls",
  );
  assert.equal(
    summarizeArgs("container_mount_remove", {
      container: "valkey-ctr",
      kind: "secret",
      secret: "valkey-tls",
    }),
    "container valkey-ctr: unmount secret valkey-tls",
  );
});

test("summarizeArgs infers the mount target when kind is omitted", () => {
  assert.equal(
    summarizeArgs("container_mount_remove", {
      container: "valkey-ctr",
      secret: "valkey-tls",
    }),
    "container valkey-ctr: unmount secret valkey-tls",
  );
  assert.equal(
    summarizeArgs("container_mount_add", {
      container: "valkey-ctr",
      volume: "valkey-data",
    }),
    "container valkey-ctr: mount volume valkey-data",
  );
});

test("summarizeArgs tolerates missing or malformed arguments", () => {
  assert.equal(summarizeArgs("image_build", {}), "");
  assert.equal(summarizeArgs("container_mount_add", { container: "c" }), "");
  assert.equal(summarizeArgs("image_list", { imageId: "x" }), "");
  assert.equal(summarizeArgs("container_recreate", { container: "c" }), "recreate container c");
  assert.equal(
    summarizeArgs("container_recreate", {
      container: "c",
      image: "img",
      mounts: [{ mode: "read_only" }, "garbage", 42],
    }),
    "recreate container c with img",
  );
});

test("preExecutePolicy asks for gated tools and delegates the rest", async () => {
  const asked = (await preExecutePolicy(
    { name: "image_remove", arguments: { imageId: "valkey" } },
    () => Promise.resolve({ kind: "allow" }),
  )) as { kind: string; reason: string };
  assert.equal(asked.kind, "ask");
  assert.equal(asked.reason, "remove image valkey");

  let delegated = false;
  const allowed = (await preExecutePolicy({ name: "image_list" }, () => {
    delegated = true;
    return Promise.resolve({ kind: "allow" });
  })) as { kind: string };
  assert.equal(delegated, true, "non-gated tools must delegate to next()");
  assert.equal(allowed.kind, "allow");
});

test("preExecutePolicy denies project mounts that carry a destination", async () => {
  const deny = (await preExecutePolicy(
    {
      name: "container_mount_add",
      arguments: { kind: "project", project: "team", path: "src", destination: "/custom" },
    },
    () => Promise.resolve({ kind: "allow" }),
    () => "/projects",
  )) as { kind: string; reason: string };
  assert.equal(deny.kind, "deny", "must deny instead of asking");
  assert.equal(
    deny.reason,
    "project mounts do not accept a destination; the directory will be mounted at /projects/team/src",
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
      agent: {
        session: {
          events: [{ type: "approval/policy", data: { policy: "never" } }],
        },
      },
    },
    () => Promise.resolve({ kind: "allow" }),
    () => "/projects",
  )) as { kind: string };
  assert.equal(underNever.kind, "deny", "full access must not accept an invalid project mount");
});

test("foldSandboxMode and foldApprovalPolicy fold last-wins with defaults", () => {
  assert.equal(foldSandboxMode([]), undefined);
  assert.equal(foldApprovalPolicy([]), undefined);
  assert.equal(
    foldSandboxMode([
      { type: "sandbox/mode", data: { mode: "workspace-write" } },
      { type: "sandbox/mode", data: { mode: "read-only" } },
    ]),
    "read-only",
  );
  assert.equal(
    foldApprovalPolicy([
      { type: "approval/policy", data: { policy: "ask" } },
      { type: "approval/policy", data: { policy: "never" } },
    ]),
    "never",
  );
});

const readOnlyExec = (name: string, events: any[]): any => ({
  name,
  agent: { session: { events } },
});

test("read-only permission allows get/list tools and denies the rest", async () => {
  const readOnly = [{ type: "sandbox/mode", data: { mode: "read-only" } }];

  for (const name of READ_ONLY_TOOLS) {
    let delegated = false;
    const result = (await preExecutePolicy(readOnlyExec(name, readOnly), () => {
      delegated = true;
      return Promise.resolve({ kind: "allow" });
    })) as { kind: string };
    assert.equal(delegated, true, `${name} must be allowed under read-only`);
    assert.equal(result.kind, "allow");
  }

  for (const name of ["image_build", "container_start", "container_remove", "volume_remove"]) {
    const result = (await preExecutePolicy(readOnlyExec(name, readOnly), () =>
      Promise.resolve({ kind: "allow" }),
    )) as { kind: string; reason: string };
    assert.equal(result.kind, "deny", `${name} must be denied under read-only`);
    assert.ok(result.reason.includes("read-only"), `${name} deny reason`);
  }

  let delegated = false;
  const foreign = (await preExecutePolicy(readOnlyExec("write", readOnly), () => {
    delegated = true;
    return Promise.resolve({ kind: "allow" });
  })) as { kind: string };
  assert.equal(delegated, true, "DSH-native tools must delegate under read-only");
  assert.equal(foreign.kind, "allow");
});

test("full-access (approval never) runs tools without asking", async () => {
  const never = [{ type: "approval/policy", data: { policy: "never" } }];
  for (const name of ["image_build", "container_replace", "container_remove"]) {
    let delegated = false;
    const result = (await preExecutePolicy(readOnlyExec(name, never), () => {
      delegated = true;
      return Promise.resolve({ kind: "allow" });
    })) as { kind: string };
    assert.equal(delegated, true, `${name} must not ask under full access`);
    assert.equal(result.kind, "allow");
  }
});

test("workspace-write keeps the ask-based approval", async () => {
  const workspaceWrite = [
    { type: "sandbox/mode", data: { mode: "workspace-write" } },
    { type: "approval/policy", data: { policy: "ask" } },
  ];
  const asked = (await preExecutePolicy(
    {
      name: "image_build",
      arguments: {
        imageId: "valkey",
        parent: "archlinux",
        packages: ["valkey"],
      },
      agent: { session: { events: workspaceWrite } },
    },
    () => Promise.resolve({ kind: "allow" }),
  )) as { kind: string; reason: string };
  assert.equal(asked.kind, "ask");
  assert.equal(asked.reason, "build image valkey from archlinux • packages: valkey");
});

test("read-only wins over a never approval policy", async () => {
  const readOnlyNever = [
    { type: "sandbox/mode", data: { mode: "read-only" } },
    { type: "approval/policy", data: { policy: "never" } },
  ];
  const result = (await preExecutePolicy(readOnlyExec("image_build", readOnlyNever), () =>
    Promise.resolve({ kind: "allow" }),
  )) as { kind: string };
  assert.equal(result.kind, "deny", "read-only must deny mutating tools even under full access");
});

const presetExec = (name: string, preset: string, args?: unknown, events: any[] = []): any => ({
  name,
  arguments: args,
  agent: { session: { header: { agentPreset: preset }, events } },
});

test("podman-ops preset asks for its approval-gated tools only", async () => {
  const workspaceWrite = [
    { type: "sandbox/mode", data: { mode: "workspace-write" } },
    { type: "approval/policy", data: { policy: "ask" } },
  ];
  const asked = (await preExecutePolicy(
    presetExec("container_bash", "podman-ops", { container: "valkey-ctr", command: "valkey-cli ping" }, workspaceWrite),
    () => Promise.resolve({ kind: "allow" }),
  )) as { kind: string; reason: string };
  assert.equal(asked.kind, "ask");
  assert.equal(asked.reason, "run shell in container valkey-ctr: valkey-cli ping");

  const daemon = (await preExecutePolicy(
    presetExec("daemon_start", "podman-ops", { container: "valkey-ctr", name: "v1", argv: ["valkey-server"], uid: 1001 }, workspaceWrite),
    () => Promise.resolve({ kind: "allow" }),
  )) as { kind: string; reason: string };
  assert.equal(daemon.kind, "ask");
  assert.equal(daemon.reason, "start daemon v1 in container valkey-ctr: valkey-server • uid: 1001");
});

test("podman-ops approval does not leak into other presets", async () => {
  const workspaceWrite = [
    { type: "sandbox/mode", data: { mode: "workspace-write" } },
    { type: "approval/policy", data: { policy: "ask" } },
  ];
  for (const preset of ["standard", undefined]) {
    let delegated = false;
    const result = (await preExecutePolicy(
      presetExec("container_bash", preset as string, { container: "c", command: "ls" }, workspaceWrite),
      () => {
        delegated = true;
        return Promise.resolve({ kind: "allow" });
      },
    )) as { kind: string };
    assert.equal(delegated, true, `${preset}: container_bash must delegate`);
    assert.equal(result.kind, "allow");
  }
});

test("podman-ops keeps open tools ungated and respects permissions", async () => {
  const workspaceWrite = [
    { type: "sandbox/mode", data: { mode: "workspace-write" } },
    { type: "approval/policy", data: { policy: "ask" } },
  ];
  let delegated = false;
  const open = (await preExecutePolicy(
    presetExec("image_list", "podman-ops", {}, workspaceWrite),
    () => {
      delegated = true;
      return Promise.resolve({ kind: "allow" });
    },
  )) as { kind: string };
  assert.equal(delegated, true, "image_list must stay open in podman-ops");
  assert.equal(open.kind, "allow");

  const readOnly = [{ type: "sandbox/mode", data: { mode: "read-only" } }];
  const denied = (await preExecutePolicy(
    presetExec("container_bash", "podman-ops", { container: "c", command: "ls" }, readOnly),
    () => Promise.resolve({ kind: "allow" }),
  )) as { kind: string };
  assert.equal(denied.kind, "deny", "read-only wins over podman-ops approval");

  const never = [{ type: "approval/policy", data: { policy: "never" } }];
  let fullDelegated = false;
  const full = (await preExecutePolicy(
    presetExec("daemon_start", "podman-ops", { container: "c", argv: ["x"] }, never),
    () => {
      fullDelegated = true;
      return Promise.resolve({ kind: "allow" });
    },
  )) as { kind: string };
  assert.equal(fullDelegated, true, "full access must not ask");
  assert.equal(full.kind, "allow");
});

test("summarizeArgs renders reasons for the podman-ops gated tools", () => {
  assert.equal(
    summarizeArgs("container_exec", { container: "c", argv: ["python", "run.py", "--x", "1", "--y", "2", "--z", "3", "--w", "4", "--v", "5"] }),
    "run in container c: python run.py --x 1 --y 2 --z 3 …",
  );
  assert.equal(summarizeArgs("container_write", { container: "c", file_path: "/etc/valkey/valkey.conf" }), "write /etc/valkey/valkey.conf in container c");
  assert.equal(summarizeArgs("container_edit", { container: "c", file_path: "/etc/valkey/valkey.conf" }), "edit /etc/valkey/valkey.conf in container c");
  assert.equal(summarizeArgs("container_bash", { container: "c", command: "ping -c 1 8.8.8.8" }), "run shell in container c: ping -c 1 8.8.8.8");
});

test("Podman-ops preset content covers the recent tools", () => {
  for (const tool of [
    "image_rebuild_all",
    "secret_list",
    "secret_create",
    "secret_remove",
    "container_secret_add",
    "container_secret_remove",
  ]) {
    assert.ok(
      PODMAN_OPS_AGENT_CORDIS_YML.includes(tool),
      `podman-ops composition must mention ${tool}`,
    );
  }
  assert.ok(PODMAN_OPS_PRESET_YML.includes("secrets"), "podman-ops metadata must mention secrets");
});

test("Podman-ops preset writer overwrites existing content", () => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-podman-"));
  ensurePodmanOpsPreset(undefined, dir);
  const composition = join(dir, "agent.cordis.yml");
  const metadata = join(dir, "preset.yml");
  assert.equal(readFileSync(composition, "utf8"), PODMAN_OPS_AGENT_CORDIS_YML);
  assert.equal(readFileSync(metadata, "utf8"), PODMAN_OPS_PRESET_YML);

  writeFileSync(composition, "# stale user copy\n");
  ensurePodmanOpsPreset(undefined, dir);
  assert.equal(
    readFileSync(composition, "utf8"),
    PODMAN_OPS_AGENT_CORDIS_YML,
    "a second load must overwrite the stale copy",
  );
});

const MOUNT_TOOLS = [
  "container_mount_list",
  "container_mount_add",
  "container_mount_remove",
];

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
});

const VOLUME_TOOLS = ["volume_list", "volume_create", "volume_remove"];

test("volume tools are registered with the expected schemas", () => {
  for (const name of VOLUME_TOOLS) {
    const tool = TOOLS.find((entry) => entry.name === name);
    assert.ok(tool, `${name} registered`);
    if (name === "volume_remove") {
      assert.equal(tool!.approval, true, "volume_remove must require approval");
    } else {
      assert.notEqual(tool!.approval, true, `${name} must not require approval`);
    }
    assert.equal(tool!.parameters.type, "object", `${name} type`);
    assert.equal(typeof tool!.parameters.properties, "object");
    assert.ok(Array.isArray(tool!.parameters.required));
  }

  const listTool = TOOLS.find((entry) => entry.name === "volume_list");
  assert.deepEqual(listTool!.parameters.required, []);

  const createTool = TOOLS.find((entry) => entry.name === "volume_create");
  assert.deepEqual(createTool!.parameters.required, ["name"]);
  assert.equal(createTool!.parameters.properties.name.type, "string");

  const removeTool = TOOLS.find((entry) => entry.name === "volume_remove");
  assert.deepEqual(removeTool!.parameters.required, ["name"]);
  assert.equal(removeTool!.parameters.properties.name.type, "string");
});

const SECRET_TOOLS = [
  "secret_list",
  "secret_create",
  "secret_remove",
  "container_secret_add",
  "container_secret_remove",
];

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
      resolveByPath: async () => ({ id: "team" }),
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
    workspaceSlug: "team",
    container: "valkey-ctr",
    kind: "MOUNT_KIND_SECRET",
    secret: "valkey-tls",
    destination: "/run/secrets/tls",
  });
  assert.deepEqual(requests[1], {
    workspaceSlug: "team",
    container: "valkey-ctr",
    kind: "MOUNT_KIND_SECRET",
    secret: "valkey-tls",
  });
});

function mountRequestRecorder() {
  const requests: Array<[string, Record<string, unknown>]> = [];
  const resolver = {
    registry: {
      resolveByPath: async () => ({ id: "team" }),
    },
    getConfig: () => ({ projectsRoot: "/projects" }),
    async control(method: string, request: unknown) {
      requests.push([method, request as Record<string, unknown>]);
      return {};
    },
  };
  return { requests, resolver };
}

const MOUNT_EXEC = { agent: { session: { header: { cwd: "/proj" } } } };

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
      workspaceSlug: "team",
      container: "valkey-ctr",
      kind: "MOUNT_KIND_SECRET",
      secret: "valkey-tls",
    },
  ]);
  assert.deepEqual(requests[1], [
    "addContainerMount",
    {
      workspaceSlug: "team",
      container: "valkey-ctr",
      kind: "MOUNT_KIND_VOLUME",
      volume: "valkey-data",
      destination: "/data",
      mode: "MOUNT_MODE_READ_ONLY",
    },
  ]);
});

test("an approval ask omits the reason when no summary can be derived", () => {
  assert.deepEqual(approvalDecision("container_mount_remove", { container: "c" }), {
    kind: "ask",
  });
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
        { container: "web", kind: "project", project: "team", path: "src", destination: "/custom" },
        MOUNT_EXEC,
      ),
    /project mounts do not accept a destination; the directory will be mounted at \/projects\/team\/src/,
  );
  await assert.rejects(
    () =>
      toolHandlers.container_mount_add(
        resolver as never,
        { container: "web", project: "team", destination: "/custom" },
        MOUNT_EXEC,
      ),
    /project mounts do not accept a destination/,
  );
  assert.deepEqual(requests, [], "a rejected mount must not reach the orchestrator");

  await toolHandlers.container_mount_add(
    resolver as never,
    { container: "web", kind: "volume", volume: "data", destination: "/data" },
    MOUNT_EXEC,
  );
  assert.equal(requests.length, 1, "a volume mount with a destination is still accepted");
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
      workspaceSlug: "team",
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
      workspaceSlug: "team",
      container: "web",
      kind: "MOUNT_KIND_PROJECT",
      project: "team",
      mode: "MOUNT_MODE_READ_ONLY",
    }],
    ["addContainerMount", {
      workspaceSlug: "team",
      container: "web",
      kind: "MOUNT_KIND_VOLUME",
      volume: "valkey-data",
      destination: "/data",
      mode: "MOUNT_MODE_READ_ONLY",
    }],
    ["removeContainerMount", {
      workspaceSlug: "team",
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
        { project: "team", path: "src", mode: "read_only" },
        { project: "team", destination: "/custom", mode: "read_write" },
        { kind: "volume", volume: "valkey-data", destination: "/data" },
        { kind: "secret", secret: "valkey-tls", destination: "/run/secrets/tls" },
        { kind: "tmpfs", destination: "/scratch" },
      ],
    },
    MOUNT_EXEC,
  );
  assert.deepEqual(requests, [
    ["startContainer", {
      workspaceSlug: "team",
      container: "web",
      imageId: "img1",
      mounts: [
        {
          projectName: "team",
          kind: "MOUNT_KIND_PROJECT",
          mode: "MOUNT_MODE_READ_ONLY",
          path: "src",
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

test("image_build requires imageId, parent and packages", () => {
  const tool = TOOLS.find((entry) => entry.name === "image_build");
  assert.ok(tool, "image_build registered");
  assert.equal(tool!.approval, true, "image_build must require approval");
  assert.deepEqual(tool!.parameters.required, ["imageId", "parent", "packages"]);
  assert.equal(tool!.parameters.properties.imageId.description, "Image short name.");
  assert.ok(
    tool!.parameters.properties.parent.description.includes(
      "Short name of the parent image",
    ),
    "parent must be documented as a short name",
  );
});

test("image_remove is registered, requires approval and requires imageId", () => {
  const tool = TOOLS.find((entry) => entry.name === "image_remove");
  assert.ok(tool, "image_remove registered");
  assert.equal(tool!.approval, true, "image_remove must require approval");
  assert.equal(tool!.parameters.type, "object", "image_remove type");
  assert.equal(typeof tool!.parameters.properties, "object");
  assert.deepEqual(tool!.parameters.required, ["imageId"]);
  assert.equal(tool!.parameters.properties.imageId.type, "string");
  assert.deepEqual(imageRemoveParameters, tool!.parameters);
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

const DAEMON_TOOLS = [
  "daemon_start",
  "daemon_list",
  "daemon_stop",
  "daemon_restart",
  "daemon_logs",
];

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

test("container start/recreate/bash accept an env map schema", () => {
  for (const name of ["container_start", "container_recreate", "container_bash"]) {
    const tool = TOOLS.find((entry) => entry.name === name);
    assert.ok(tool, `${name} registered`);
    const env = tool!.parameters.properties.env;
    assert.equal(env.type, "object", `${name}.env type`);
    assert.equal(
      env.additionalProperties.type,
      "string",
      `${name}.env values type`,
    );
    assert.ok(
      !Array.isArray(tool!.parameters.required.includes("env")),
      `${name}.env must stay optional`,
    );
  }
});

test("summarizeArgs includes env keys for container start/recreate", () => {
  assert.equal(
    summarizeArgs("container_start", {
      container: "web",
      env: { A: "1", B: "2" },
    }),
    "start container web • env: A, B",
  );
  assert.equal(
    summarizeArgs("container_start", {
      container: "web",
      image: "localhost/dsh-podman/nginx:latest",
      mounts: [{ project: "team", mode: "read_only" }],
      env: { A: "1", B: "2", C: "3" },
    }),
    "start container web with localhost/dsh-podman/nginx:latest • mounts: team (ro) • env: A, B, C",
  );
  assert.equal(
    summarizeArgs("container_start", {
      container: "web",
      env: { A: "1", B: "2", C: "3", D: "4", E: "5", F: "6", G: "7", H: "8", I: "9", J: "10" },
    }),
    "start container web • env: A, B, C, D, E, F, G, H, +2 more",
  );
  assert.equal(
    summarizeArgs("container_recreate", {
      container: "c",
      image: "img",
      env: { A: "1" },
    }),
    "recreate container c with img • env: A",
  );
  assert.equal(
    summarizeArgs("container_recreate", { container: "c", env: {} }),
    "recreate container c",
  );
});

test("container_list returns sanitized container objects with env values", async () => {
  const resolver = {
    registry: {
      resolveByPath: async () => ({ id: "team" }),
    },
    control: async (method: string) => {
      if (method === "listContainers") {
        return {
          containers: [
            {
              workspaceSlug: "team",
              containerName: "default",
              status: "running",
              imageId: "img-1",
              env: { PATH: "/bin", HOME: "/root" },
            },
            {
              workspaceSlug: "team",
              containerName: "db",
              status: "running",
              env: { PORT: "5432", DB: "main", X: "1", Y: "2" },
            },
            {
              workspaceSlug: "team",
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
      env: { PATH: "/bin", HOME: "/root" },
      secretEnv: {},
    },
    {
      containerName: "db",
      status: "running",
      mounts: [],
      env: { PORT: "5432", DB: "main", X: "1", Y: "2" },
      secretEnv: {},
    },
    {
      containerName: "worker",
      status: "stopped",
      mounts: [],
      env: {},
      secretEnv: {},
    },
  ]);
});

test("container_list returns secret_env maps on container rows", async () => {
  const resolver = {
    registry: {
      resolveByPath: async () => ({ id: "team" }),
    },
    control: async (method: string) => {
      if (method === "listContainers") {
        return {
          containers: [
            {
              workspaceSlug: "team",
              containerName: "default",
              status: "running",
              imageId: "img-1",
              secretEnv: { REDIS_PASSWORD: "db-pass" },
            },
            {
              workspaceSlug: "team",
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
              workspaceSlug: "team",
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
      env: {},
      secretEnv: { REDIS_PASSWORD: "db-pass" },
    },
    {
      containerName: "db",
      status: "running",
      mounts: [],
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
      env: {},
      secretEnv: {},
    },
  ]);
});

test("container_list reports an uncreated default container as not started", async () => {
  const resolver = {
    registry: {
      resolveByPath: async () => ({ id: "team" }),
    },
    control: async () => ({ containers: [] }),
  } as never;
  const exec = { agent: { session: { header: { cwd: "/proj" } } } };
  const out = (await toolHandlers.container_list(resolver, {}, exec)) as any[];
  assert.deepEqual(out, [
    { containerName: "default", status: "not started" },
  ]);
});

const SECRET_BEARING_CONTAINER = {
  workspaceSlug: "team",
  containerName: "default",
  imageId: "img-1",
  status: "running",
  createdAt: "2026-01-01T00:00:00Z",
  podmanName: "dsh-workspace-team-default",
  agentSocketPath: "/run/dsh-podman/team-default/guest.sock",
  agentToken: "super-secret-token",
  mounts: [
    { projectName: "team", mode: "MOUNT_MODE_READ_WRITE", kind: "MOUNT_KIND_PROJECT" },
  ],
  env: { PATH: "/bin", DB_PASSWORD: "hunter2" },
  secretEnv: { DB_PASS: "db-pass" },
};

function secretBearingResolver() {
  return {
    registry: {
      resolveByPath: async () => ({ id: "team" }),
    },
    getConfig: () => ({ projectsRoot: "/projects" }),
    control: async () => SECRET_BEARING_CONTAINER,
  };
}

test("container tools never expose internal fields in their results", async () => {
  const exec = { agent: { session: { header: { cwd: "/projects/team" } } } };
  const cases: Array<[any, Record<string, unknown>]> = [
    [toolHandlers.container_start, { container: "default", image: "img-1" }],
    [toolHandlers.container_recreate, { container: "default" }],
    [toolHandlers.container_mount_add, { container: "default", kind: "volume", volume: "v", destination: "/data" }],
    [toolHandlers.container_mount_remove, { container: "default", kind: "volume", volume: "v", destination: "/data" }],
    [toolHandlers.container_secret_add, { container: "default", env: "DB_PASS", secret: "db-pass" }],
    [toolHandlers.container_secret_remove, { container: "default", env: "DB_PASS" }],
  ];
  for (const [handler, input] of cases) {
    const out = await handler(secretBearingResolver(), input, exec);
    const json = JSON.stringify(out);
    assert.ok(!json.includes("agentSocketPath"), "must not expose agentSocketPath");
    assert.ok(!json.includes("agentToken"), "must not expose agentToken");
    assert.ok(!json.includes("podmanName"), "must not expose podmanName");
    assert.ok(!json.includes("workspaceSlug"), "must not expose workspaceSlug");
    assert.ok(!json.includes("createdAt"), "must not expose createdAt");
    assert.ok(json.includes("hunter2"), "env values are returned to the model");
    assert.equal(out.containerName, "default");
    assert.equal(out.status, "running");
    assert.equal(out.imageId, "img-1");
    assert.equal(out.secretEnv.DB_PASS, "db-pass");
  }
});

test("publicContainer rebuilds a safe object from an API row", () => {
  const out = publicContainer(SECRET_BEARING_CONTAINER);
  assert.deepEqual(Object.keys(out).sort(), [
    "containerName",
    "env",
    "imageId",
    "mounts",
    "secretEnv",
    "status",
  ]);
  assert.deepEqual(out.mounts, [
    { projectName: "team", mode: "read_write", kind: "project" },
  ]);
  assert.deepEqual(out.env, { PATH: "/bin", DB_PASSWORD: "hunter2" });
});

test("container_recreate returns the logical container name", async () => {
  const resolver = {
    registry: {
      resolveByPath: async () => ({ id: "team" }),
    },
    getConfig: () => ({ projectsRoot: "/projects" }),
    control: async () => ({
      workspaceSlug: "team",
      containerName: "dsh-workspace-team",
      imageId: "img-1",
      status: "running",
      mounts: [],
    }),
  } as never;
  const exec = { agent: { session: { header: { cwd: "/projects/team" } } } };
  const def = (await toolHandlers.container_recreate(
    resolver,
    { container: "default", image: "img-1" },
    exec,
  )) as any;
  assert.equal(def.containerName, "default");
  const named = (await toolHandlers.container_recreate(
    resolver,
    { container: "db", image: "img-1" },
    exec,
  )) as any;
  assert.equal(named.containerName, "db");
});

test("image_list returns image objects", async () => {
  const resolver = {
    control: async () => ({
      images: [
        {
          imageId: "archlinux",
          isBase: true,
          status: "built",
          primitive: "docker.io/library/archlinux:latest",
          packageManager: "pacman",
          basePublic: false,
        },
        {
          imageId: "dev",
          parent: "ubuntu",
          status: "built",
          packages: ["git"],
          packageManager: "apt",
        },
      ],
    }),
  } as never;
  const out = await toolHandlers.image_list(resolver, {}, {});
  assert.deepEqual(out, [
    {
      imageId: "archlinux",
      isBase: true,
      status: "built",
      primitive: "docker.io/library/archlinux:latest",
      packageManager: "pacman",
      basePublic: false,
      packages: [],
    },
    {
      imageId: "dev",
      parent: "ubuntu",
      isBase: false,
      status: "built",
      packageManager: "apt",
      basePublic: false,
      packages: ["git"],
    },
  ]);
});

test("volume_list and secret_list return name objects", async () => {
  const volumeResolver = {
    control: async () => ({ volumes: [{ name: "myvol" }] }),
  } as never;
  assert.deepEqual(
    await toolHandlers.volume_list(volumeResolver, {}, {}),
    [{ name: "myvol" }],
  );
  const secretResolver = {
    control: async () => ({ secrets: [{ name: "dbpass" }] }),
  } as never;
  assert.deepEqual(
    await toolHandlers.secret_list(secretResolver, {}, {}),
    [{ name: "dbpass" }],
  );
});

test("container_mount_list returns mount objects", async () => {
  const resolver = {
    registry: {
      resolveByPath: async () => ({ id: "team" }),
    },
    control: async () => ({
      containers: [
        {
          workspaceSlug: "team",
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

test("image_rebuild_all returns rebuilt and skipped arrays", async () => {
  const resolver = {
    control: async () => ({ rebuilt: ["archlinux", "dev"], skipped: ["broken"] }),
  } as never;
  const out = await toolHandlers.image_rebuild_all(resolver, {}, {});
  assert.deepEqual(out, { rebuilt: ["archlinux", "dev"], skipped: ["broken"] });
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

test("resolveGuestPath resolves relative paths and refuses traversal", () => {
  assert.equal(resolveGuestPath("/abs/file", "/projects/team"), "/abs/file");
  assert.equal(resolveGuestPath("README.md", "/projects/team"), "/projects/team/README.md");
  assert.equal(resolveGuestPath("src/main.go", "/projects/team"), "/projects/team/src/main.go");
  assert.equal(resolveGuestPath("./a", "/projects/team"), "/projects/team/a");
  // ".." is refused before resolution, where it would be normalised away.
  assert.throws(() => resolveGuestPath("../escape", "/projects/team"), /must not escape/);
  assert.throws(() => resolveGuestPath("a/../b", "/projects/team"), /must not escape/);
  assert.throws(() => resolveGuestPath("/a/../b", "/projects/team"), /must not escape/);
  // A relative path is meaningless without a session working directory.
  assert.throws(() => resolveGuestPath("rel", undefined), /session working directory/);
  assert.throws(() => resolveGuestPath("rel", ""), /session working directory/);
  assert.equal(resolveGuestPath("/abs", undefined), "/abs");
});

test("resolveGuestCwd resolves working directories but keeps traversal", () => {
  assert.equal(resolveGuestCwd(undefined, "/projects/team"), undefined);
  assert.equal(resolveGuestCwd("", "/projects/team"), undefined);
  assert.equal(resolveGuestCwd("/abs", "/projects/team"), "/abs");
  assert.equal(resolveGuestCwd("sub", "/projects/team"), "/projects/team/sub");
  // Commands are not confined to the projects root, so ".." is allowed here.
  assert.equal(resolveGuestCwd("../sibling", "/projects/team"), "/projects/sibling");
});

// Stubs the guest agent's streaming ReadFile/WriteFile calls, recording the
// paths the tools ask for.
function guestFileRecorder(content = "hello") {
  const reads: string[] = [];
  const writes: { path: string; content: string }[] = [];
  const guest = {
    readFile: (request: any) => {
      reads.push(request.path);
      const handlers: Record<string, ((value?: unknown) => void)[]> = {};
      queueMicrotask(() => {
        for (const handler of handlers.data ?? []) {
          handler({ data: Buffer.from(content) });
        }
        for (const handler of handlers.end ?? []) handler();
      });
      return {
        on(event: string, handler: (value?: unknown) => void) {
          (handlers[event] ??= []).push(handler);
        },
      };
    },
    writeFile: (
      _metadata: unknown,
      _options: unknown,
      callback: (error: Error | null, result: unknown) => void,
    ) => {
      let path = "";
      let body = "";
      return {
        write(message: any) {
          if (message.start !== undefined) path = message.start.path;
          if (message.dataChunk !== undefined) body += String(message.dataChunk);
        },
        end() {
          writes.push({ path, content: body });
          callback(null, { bytesWritten: body.length });
        },
      };
    },
  };
  const resolver = {
    resolve: async () => ({ guest, token: "t", socket: "/run/x.sock" }),
    containerBinding: async () => ({ guest, token: "t", socket: "/run/x.sock" }),
  };
  return { reads, writes, resolver };
}

test("file tools resolve relative paths against the session cwd", async () => {
  const exec = { agent: { session: { header: { cwd: "/projects/team" } } } };

  const read = guestFileRecorder();
  await toolHandlers.container_read(
    read.resolver as never,
    { container: "default", file_path: "README.md" },
    exec,
  );
  assert.deepEqual(read.reads, ["/projects/team/README.md"]);

  const absolute = guestFileRecorder();
  await toolHandlers.container_read(
    absolute.resolver as never,
    { container: "default", file_path: "/etc/hosts" },
    exec,
  );
  assert.deepEqual(absolute.reads, ["/etc/hosts"], "absolute paths pass through");

  const write = guestFileRecorder();
  await toolHandlers.container_write(
    write.resolver as never,
    { container: "default", file_path: "out.txt", content: "x" },
    exec,
  );
  assert.deepEqual(write.writes.map((entry) => entry.path), ["/projects/team/out.txt"]);

  const edit = guestFileRecorder("hello");
  await toolHandlers.container_edit(
    edit.resolver as never,
    { container: "default", file_path: "a.txt", old_string: "hello", new_string: "bye" },
    exec,
  );
  assert.deepEqual(edit.reads, ["/projects/team/a.txt"]);
  assert.deepEqual(edit.writes.map((entry) => entry.path), ["/projects/team/a.txt"]);
});

test("file tools refuse traversal before reaching the guest", async () => {
  const exec = { agent: { session: { header: { cwd: "/projects/team" } } } };
  const { reads, writes, resolver } = guestFileRecorder();
  for (const path of ["../escape", "a/../../b"]) {
    await assert.rejects(
      () => toolHandlers.container_read(resolver as never, { container: "default", file_path: path }, exec),
      /must not escape/,
    );
  }
  await assert.rejects(
    () =>
      toolHandlers.container_write(
        resolver as never,
        { container: "default", file_path: "../escape", content: "x" },
        exec,
      ),
    /must not escape/,
  );
  assert.deepEqual(reads, [], "a refused path must not reach the guest");
  assert.deepEqual(writes, []);
});

test("container_read applies offset and limit like the built-in read tool", async () => {
  const exec = { agent: { session: { header: { cwd: "/projects/team" } } } };
  const { resolver } = guestFileRecorder("l1\nl2\nl3\nl4\n");
  assert.equal(
    await toolHandlers.container_read(
      resolver as never,
      { container: "default", file_path: "f" },
      exec,
    ),
    "l1\nl2\nl3\nl4\n",
    "no offset/limit returns the whole content",
  );
  assert.equal(
    await toolHandlers.container_read(
      resolver as never,
      { container: "default", file_path: "f", offset: 2, limit: 2 },
      exec,
    ),
    "l2\nl3",
  );
});

test("container_edit requires a unique match unless replace_all is set", async () => {
  const exec = { agent: { session: { header: { cwd: "/projects/team" } } } };

  const duplicate = guestFileRecorder("a a a");
  await assert.rejects(
    () =>
      toolHandlers.container_edit(
        duplicate.resolver as never,
        { container: "default", file_path: "f", old_string: "a", new_string: "b" },
        exec,
      ),
    /more than once/,
  );
  assert.deepEqual(duplicate.writes, [], "a non-unique match must not be written");

  const all = guestFileRecorder("a a a");
  await toolHandlers.container_edit(
    all.resolver as never,
    { container: "default", file_path: "f", old_string: "a", new_string: "b", replace_all: true },
    exec,
  );
  assert.equal(all.writes[0].content, "b b b");
});

test("container command and file tools mirror the built-in arguments", () => {
  const parameters = (name: string): any =>
    TOOLS.find((entry) => entry.name === name)!.parameters;

  const bash = parameters("container_bash");
  assert.ok(bash.required.includes("command"));
  assert.ok(bash.required.includes("description"));
  assert.equal(bash.properties.timeoutMs.type, "number");

  const exec = parameters("container_exec");
  assert.ok(exec.required.includes("description"));
  assert.equal(exec.properties.workdir.type, "string");
  assert.equal(exec.properties.cwd, undefined);

  const read = parameters("container_read");
  assert.equal(read.properties.file_path.type, "string");
  assert.equal(read.properties.offset.type, "integer");
  assert.equal(read.properties.limit.type, "integer");

  const write = parameters("container_write");
  assert.equal(write.properties.file_path.type, "string");

  const edit = parameters("container_edit");
  assert.equal(edit.properties.old_string.type, "string");
  assert.equal(edit.properties.new_string.type, "string");
  assert.equal(edit.properties.replace_all.type, "boolean");

  const glob = parameters("container_glob");
  assert.equal(glob.properties.path.type, "string");
  assert.equal(glob.properties.cwd, undefined);

  const grep = parameters("container_grep");
  assert.equal(grep.properties.include.type, "string");
  assert.equal(grep.properties.cwd, undefined);
});

test("tool presenters label every tool and render terminal commands", () => {
  for (const tool of TOOLS) {
    assert.notEqual(
      toolCallView(tool.name, {}),
      undefined,
      `${tool.name} has a call view`,
    );
  }
  assert.deepEqual(
    toolCallView("container_bash", { command: "ls", description: "List files" }),
    { card: "terminal", title: "ls", description: "List files" },
  );
  assert.deepEqual(
    toolCallView("container_exec", { argv: ["ls", "-la"], description: "List all" }),
    { card: "terminal", title: "ls -la", description: "List all" },
  );
  assert.deepEqual(
    toolCallView("image_list", {}),
    { card: "generic", title: "List images", kind: "search" },
  );
  assert.deepEqual(
    toolCallView("container_read", {}),
    { card: "generic", title: "Container read", kind: "read" },
  );
  assert.deepEqual(
    toolCallView("container_write", {}),
    { card: "generic", title: "Container write", kind: "edit" },
  );
  assert.deepEqual(
    toolCallView("container_edit", {}),
    { card: "generic", title: "Container edit", kind: "edit" },
  );
  assert.deepEqual(
    toolCallView("container_glob", {}),
    { card: "generic", title: "Container glob", kind: "search" },
  );
  assert.deepEqual(
    toolCallView("container_grep", {}),
    { card: "generic", title: "Container grep", kind: "search" },
  );
});

test("tool presenters render command results as terminal output", () => {
  const result = (value: unknown) => ({
    content: [{ type: "text", text: JSON.stringify(value) }],
    isError: false,
  });
  assert.deepEqual(
    toolResultView("container_bash", {}, result({ exitCode: 0, signal: null, stdout: "hi\n", stderr: "" })),
    { card: "terminal", output: "hi\n", exitCode: 0 },
  );
  assert.deepEqual(
    toolResultView("container_bash", {}, result({ exitCode: 0, signal: "SIGTERM", stdout: "", stderr: "" })),
    { card: "terminal", output: "", signal: "SIGTERM" },
  );
  assert.equal(
    toolResultView("container_bash", {}, { content: [{ type: "text", text: "boom" }], isError: true }),
    undefined,
  );
  assert.equal(toolResultView("image_list", {}, result({})), undefined);
});

test("container_bash enforces timeoutMs", async () => {
  const exec = { agent: { session: { header: { cwd: "/projects/team" } } } };
  let signaled: any;
  const guest = {
    exec: () => {
      const handlers: Record<string, ((value?: unknown) => void)[]> = {};
      return {
        on(event: string, handler: (value?: unknown) => void) {
          (handlers[event] ??= []).push(handler);
          if (event === "data") queueMicrotask(() => handler({ processId: "42" }));
        },
        write() {},
        end() {},
      };
    },
    signal: (
      request: any,
      _metadata: unknown,
      callback: (error: Error | null, result: unknown) => void,
    ) => {
      signaled = request;
      callback(null, {});
    },
  };
  const resolver = {
    resolve: async () => ({
      guest,
      token: "t",
      socket: "/run/x.sock",
      defaultCwd: "/projects/team",
    }),
  };
  await assert.rejects(
    () =>
      toolHandlers.container_bash(
        resolver as never,
        { container: "default", command: "sleep", description: "x", timeoutMs: 10 },
        exec,
      ),
    /timed out/,
  );
  assert.equal(signaled.processId, "42");
  assert.equal(signaled.signal, "SIGTERM");
});

test("approval prompts name the resolved path", () => {
  assert.equal(
    summarizeArgs("container_write", { container: "c", file_path: "notes.md" }, "/projects/team"),
    "write /projects/team/notes.md in container c",
  );
  assert.equal(
    summarizeArgs("container_edit", { container: "c", file_path: "notes.md" }, "/projects/team"),
    "edit /projects/team/notes.md in container c",
  );
  // Without a session cwd, or for a path that cannot resolve, the prompt still
  // renders with the value as given.
  assert.equal(
    summarizeArgs("container_write", { container: "c", file_path: "notes.md" }),
    "write notes.md in container c",
  );
  assert.equal(
    summarizeArgs("container_write", { container: "c", file_path: "../x" }, "/projects/team"),
    "write ../x in container c",
  );
});

// Stubs the guest agent's streaming Exec call, recording the start message.
function guestExecRecorder(defaultCwd?: string, stdout?: string) {
  const starts: { argv: string[]; cwd?: string }[] = [];
  const guest = {
    exec: () => {
      const handlers: Record<string, ((value?: unknown) => void)[]> = {};
      return {
        on(event: string, handler: (value?: unknown) => void) {
          (handlers[event] ??= []).push(handler);
        },
        write(message: any) {
          starts.push({ argv: message.start.argv, cwd: message.start.cwd });
        },
        end() {
          for (const handler of handlers.data ?? []) {
            if (stdout !== undefined) handler({ stdoutChunk: Buffer.from(stdout) });
            handler({ exit: { exitCode: 0, signaled: false } });
          }
        },
      };
    },
  };
  const binding = {
    guest,
    token: "t",
    socket: "/run/x.sock",
    ...(defaultCwd === undefined ? {} : { defaultCwd }),
  };
  const resolver = {
    resolve: async () => binding,
    containerBinding: async () => binding,
  };
  return { starts, resolver };
}

test("command tools resolve a relative working directory", async () => {
  const exec = { agent: { session: { header: { cwd: "/projects/team" } } } };

  const bash = guestExecRecorder("/projects/team");
  await toolHandlers.container_bash(
    bash.resolver as never,
    { container: "default", command: "ls", workdir: "sub" },
    exec,
  );
  assert.equal(bash.starts[0].cwd, "/projects/team/sub");

  const run = guestExecRecorder("/projects/team");
  await toolHandlers.container_exec(
    run.resolver as never,
    { container: "default", argv: ["ls"], workdir: "/abs" },
    exec,
  );
  assert.equal(run.starts[0].cwd, "/abs", "absolute working directories pass through");

  // An unset working directory defaults to the session's (when mounted).
  const bare = guestExecRecorder("/projects/team");
  await toolHandlers.container_exec(
    bare.resolver as never,
    { container: "default", argv: ["ls"] },
    exec,
  );
  assert.equal(bare.starts[0].cwd, "/projects/team");

  // Commands are not confined to the projects root, so ".." is allowed.
  const up = guestExecRecorder("/projects/team");
  await toolHandlers.container_bash(
    up.resolver as never,
    { container: "default", command: "ls", workdir: "../sibling" },
    exec,
  );
  assert.equal(up.starts[0].cwd, "/projects/sibling");
});

test("container_grep resolves its search path like a shell would", async () => {
  const exec = { agent: { session: { header: { cwd: "/projects/team" } } } };

  // With a search path, it is relative to the session directory.
  const plain = guestExecRecorder("/projects/team");
  await toolHandlers.container_grep(
    plain.resolver as never,
    { container: "default", pattern: "TODO", path: "src" },
    exec,
  );
  assert.deepEqual(plain.starts[0].argv, ["/usr/bin/rg", "-n", "TODO", "/projects/team/src"]);

  // An include filter maps to ripgrep's --glob.
  const filtered = guestExecRecorder("/projects/team");
  await toolHandlers.container_grep(
    filtered.resolver as never,
    { container: "default", pattern: "TODO", path: "src", include: "*.ts" },
    exec,
  );
  assert.deepEqual(filtered.starts[0].argv, ["/usr/bin/rg", "-n", "--glob", "*.ts", "TODO", "/projects/team/src"]);
  assert.equal(filtered.starts[0].cwd, "/projects/team");

  const none = guestExecRecorder("/projects/team");
  await toolHandlers.container_grep(
    none.resolver as never,
    { container: "default", pattern: "TODO" },
    exec,
  );
  assert.deepEqual(none.starts[0].argv, ["/usr/bin/rg", "-n", "TODO"]);
});

test("container_glob passes the pattern as a glob and scopes the search", async () => {
  const exec = { agent: { session: { header: { cwd: "/projects/team" } } } };

  const plain = guestExecRecorder("/projects/team");
  await toolHandlers.container_glob(
    plain.resolver as never,
    { container: "default", pattern: "*.ts" },
    exec,
  );
  assert.deepEqual(plain.starts[0].argv, [
    "/usr/bin/rg",
    "--files",
    "--glob=*.ts",
    "--sort=modified",
    "--no-ignore",
    "--hidden",
    "--glob=!**/.git",
    "--glob=!**/.git/**",
    "--glob=!**/.svn",
    "--glob=!**/.svn/**",
    "--glob=!**/.hg",
    "--glob=!**/.hg/**",
    "--glob=!**/.bzr",
    "--glob=!**/.bzr/**",
    "--glob=!**/.jj",
    "--glob=!**/.jj/**",
    "--glob=!**/.sl",
    "--glob=!**/.sl/**",
  ]);
  assert.equal(plain.starts[0].cwd, "/projects/team");

  // An explicit search path becomes the working directory.
  const scoped = guestExecRecorder("/projects/team");
  await toolHandlers.container_glob(
    scoped.resolver as never,
    { container: "default", pattern: "*", path: "/volumes/data" },
    exec,
  );
  assert.equal(scoped.starts[0].cwd, "/volumes/data");
  assert.ok(scoped.starts[0].argv.includes("--glob=*"));
});

test("container_glob caps its result at 100 files", async () => {
  const exec = { agent: { session: { header: { cwd: "/projects/team" } } } };
  const lines = (count: number) =>
    Array.from({ length: count }, (_, index) => `file-${index}.ts`).join("\n") + "\n";

  const small = guestExecRecorder("/projects/team", lines(3));
  const few = (await toolHandlers.container_glob(
    small.resolver as never,
    { container: "default", pattern: "*" },
    exec,
  )) as { files: string[]; note?: string };
  assert.equal(few.files.length, 3);
  assert.equal(few.note, undefined);

  const big = guestExecRecorder("/projects/team", lines(101));
  const many = (await toolHandlers.container_glob(
    big.resolver as never,
    { container: "default", pattern: "*" },
    exec,
  )) as { files: string[]; note?: string };
  assert.equal(many.files.length, 100);
  assert.match(many.note ?? "", /showing 100 of 101 files/);
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

test("withoutHarnessSourceSection drops only the harness checkout section", () => {
  const assembly = {
    sections: [
      { name: "harness:identity", text: "identity" },
      { name: HARNESS_SOURCE_SECTION, text: "checkout at /src" },
      { name: "deployment:persona", text: "persona" },
    ],
    contexts: [{ name: "c", text: "t" }],
    tools: [{ name: "t" }],
    variables: { model: "m" },
  };
  const result = withoutHarnessSourceSection(assembly);
  assert.deepEqual(
    result.sections.map((section: { name: string }) => section.name),
    ["harness:identity", "deployment:persona"],
  );
  assert.deepEqual(result.contexts, assembly.contexts);
  assert.deepEqual(result.tools, assembly.tools);
  assert.deepEqual(result.variables, assembly.variables);
  // The input assembly is not mutated.
  assert.equal(assembly.sections.length, 3);
});

test("withoutHarnessSourceSection leaves an assembly without the section intact", () => {
  const assembly = { sections: [{ name: "harness:identity", text: "i" }] };
  const result = withoutHarnessSourceSection(assembly);
  assert.deepEqual(result, assembly);
});

test("podmanRuntimeSection clarifies that the built-in tools run in the container", () => {
  const section = podmanRuntimeSection();
  assert.equal(section.name, "podman:runtime");
  assert.equal(section.order, 90);
  for (const tool of ["bash", "read", "write", "edit", "glob", "grep"]) {
    assert.match(section.text, new RegExp("`" + tool + "`"));
  }
  assert.match(section.text, /container-backed/);
  assert.match(section.text, /There is no host shell/);
  assert.match(section.text, /container_\*/);
});

// A fake guest whose readFile honors offset/length, so the provider's byte
// windowing and text decoding can be exercised without a container.
function fakeGuest(source: Buffer) {
  const requests: Record<string, unknown>[] = [];
  return {
    requests,
    guest: {
      readFile: (request: Record<string, unknown>) => {
        requests.push(request);
        return {
          async *[Symbol.asyncIterator]() {
            const offset = Number(request.offset ?? 0);
            const length = Number(request.length ?? 0);
            const slice =
              length > 0
                ? source.subarray(offset, offset + length)
                : source.subarray(offset);
            yield { data: slice };
          },
        };
      },
    },
  };
}

function providerFor(guest: unknown) {
  return createFilesystemProvider({
    resolveForPath: async () => ({ guest, token: "t" }),
  } as any);
}

test("filesystem provider lstat maps entry types without following links", async () => {
  const requests: Record<string, unknown>[] = [];
  const provider = createFilesystemProvider({
    resolveForPath: async () => ({
      guest: {
        stat: (request: Record<string, unknown>, _metadata: unknown, callback: Function) => {
          requests.push(request);
          callback(null, {
            exists: true,
            isDir: false,
            isSymlink: true,
            size: "3",
            mode: "Lrwxrwxrwx",
            modifiedAt: "t",
          });
        },
      },
      token: "t",
    }),
  } as any);
  const info = await provider.lstat("/projects/team/link", { cwd: "/projects/team" });
  assert.equal(info.type, "symlink");
  assert.equal(info.size, 3);
  assert.deepEqual(requests, [{ path: "/projects/team/link", noFollow: true }]);
});

test("filesystem provider lstat reports an absent entry as undefined", async () => {
  const provider = createFilesystemProvider({
    resolveForPath: async () => ({
      guest: {
        stat: (_request: unknown, _metadata: unknown, callback: Function) =>
          callback(null, { exists: false }),
      },
      token: "t",
    }),
  } as any);
  assert.equal(await provider.lstat("/projects/team/missing", { cwd: "/x" }), undefined);
});

test("filesystem provider streamText decodes UTF-8 and rejects binary", async () => {
  const text = providerFor(fakeGuest(Buffer.from("héllo")).guest);
  const textTarget = await text.resolve("/a", { cwd: "/x" });
  let decoded = "";
  for await (const chunk of await text.streamText(textTarget)) decoded += chunk;
  assert.equal(decoded, "héllo");

  const binary = providerFor(fakeGuest(Buffer.from([0x68, 0x00, 0x69])).guest);
  const binaryTarget = await binary.resolve("/a", { cwd: "/x" });
  await assert.rejects(
    async () => {
      for await (const _chunk of await binary.streamText(binaryTarget)) {
        // Drain the stream so the binary sample is inspected.
      }
    },
    (error: unknown) =>
      error instanceof Error && (error as { code?: string }).code === "FS_NOT_TEXT",
  );
});

test("filesystem provider readBytes returns content and caps at maxBytes", async () => {
  const fake = fakeGuest(Buffer.from("hello"));
  const provider = providerFor(fake.guest);
  const target = await provider.resolve("/a", { cwd: "/x" });

  const bytes = await provider.readBytes(target, undefined, 10);
  assert.equal(Buffer.from(bytes).toString(), "hello");
  assert.equal(fake.requests[0].length, 11);

  await assert.rejects(
    () => provider.readBytes(target, undefined, 3),
    (error: unknown) =>
      error instanceof Error && (error as { code?: string }).code === "FS_TOO_LARGE",
  );
});

test("filesystem provider readByteRange returns the window and empty for zero length", async () => {
  const fake = fakeGuest(Buffer.from("abcdef"));
  const provider = providerFor(fake.guest);
  const target = await provider.resolve("/a", { cwd: "/x" });

  const empty = await provider.readByteRange(target, { offset: 0, length: 0 });
  assert.equal(empty.length, 0);
  assert.equal(fake.requests.length, 0);

  const window = await provider.readByteRange(target, { offset: 1, length: 3 });
  assert.equal(Buffer.from(window).toString(), "bcd");
  assert.deepEqual(fake.requests[0], { path: "/a", offset: 1, length: 3 });
});

// A fake guest for the text/byte provider methods: a stat result, a one-chunk
// readFile, and a no-op writeFile.
function editGuest(stat: Record<string, unknown>, content = Buffer.alloc(0)) {
  const writes: Buffer[] = [];
  return {
    writes,
    guest: {
      stat: (_request: unknown, _metadata: unknown, callback: Function) =>
        callback(null, {
          exists: true,
          isDir: false,
          isSymlink: false,
          size: String(content.length),
          mode: "-rw-r--r--",
          modifiedAt: "t",
          ...stat,
        }),
      readFile: () => ({
        async *[Symbol.asyncIterator]() {
          yield { data: content };
        },
      }),
      writeFile: (_metadata: unknown, _options: unknown, callback: Function) => {
        const call = {
          write(message: { dataChunk?: Uint8Array }) {
            if (message?.dataChunk) writes.push(Buffer.from(message.dataChunk));
          },
          end() {},
        };
        callback(null, { bytesWritten: 0 });
        return call;
      },
    },
    token: "t",
  };
}

function editProvider(binding: unknown) {
  return createFilesystemProvider({
    resolveForPath: async () => binding,
  } as any);
}

test("filesystem provider editText reports the harness error codes", async () => {
  const binary = editProvider(editGuest({}, Buffer.from([0x68, 0x00, 0x69])));
  const binaryTarget = await binary.resolve("/a", { cwd: "/x" });
  await assert.rejects(
    () => binary.editText(binaryTarget, {
      oldString: "h",
      newString: "H",
      replaceAll: false,
    }),
    (error: unknown) => (error as { code?: string }).code === "FS_NOT_TEXT",
  );

  const notFound = editProvider(editGuest({}, Buffer.from("hello")));
  const notFoundTarget = await notFound.resolve("/a", { cwd: "/x" });
  await assert.rejects(
    () => notFound.editText(notFoundTarget, {
      oldString: "zzz",
      newString: "x",
      replaceAll: false,
    }),
    (error: unknown) => (error as { code?: string }).code === "FS_EDIT_NOT_FOUND",
  );

  const ambiguous = editProvider(editGuest({}, Buffer.from("aa")));
  const ambiguousTarget = await ambiguous.resolve("/a", { cwd: "/x" });
  await assert.rejects(
    () => ambiguous.editText(ambiguousTarget, {
      oldString: "a",
      newString: "b",
      replaceAll: false,
    }),
    (error: unknown) => (error as { code?: string }).code === "FS_AMBIGUOUS_EDIT",
  );

  const stale = editProvider(editGuest({}, Buffer.from("hello")));
  const staleTarget = await stale.resolve("/a", { cwd: "/x" });
  await assert.rejects(
    () => stale.editText(
      staleTarget,
      { oldString: "h", newString: "H", replaceAll: false },
      { version: "other" },
    ),
    (error: unknown) => (error as { code?: string }).code === "FS_STALE_VERSION",
  );
});

test("filesystem provider writeText reports the harness error codes", async () => {
  const existing = editProvider(editGuest({}, Buffer.from("hello")));
  const target = await existing.resolve("/a", { cwd: "/x" });

  await assert.rejects(
    () => existing.writeText(target, "x", { kind: "createIfAbsent" }),
    (error: unknown) => (error as { code?: string }).code === "FS_NOT_OBSERVED",
  );
  await assert.rejects(
    () => existing.writeText(target, "x", { kind: "replaceIfVersion", version: "other" }),
    (error: unknown) => (error as { code?: string }).code === "FS_STALE_VERSION",
  );

  const dir = editProvider(editGuest({ isDir: true }));
  const dirTarget = await dir.resolve("/a", { cwd: "/x" });
  await assert.rejects(
    () => dir.writeText(dirTarget, "x"),
    (error: unknown) => (error as { code?: string }).code === "FS_NOT_REGULAR_FILE",
  );
});

test("filesystem provider rejects a pre-aborted signal with FS_ABORTED", async () => {
  const provider = editProvider(editGuest({}, Buffer.from("hello")));
  const target = await provider.resolve("/a", { cwd: "/x" });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => provider.readText(target, controller.signal),
    (error: unknown) => (error as { code?: string }).code === "FS_ABORTED",
  );
});

test("filesystem provider editText normalizes line endings for matching", async () => {
  const binding = editGuest({}, Buffer.from("a\r\nb\r\n"));
  const provider = editProvider(binding);
  const target = await provider.resolve("/a", { cwd: "/x" });
  const outcome = await provider.editText(target, {
    oldString: "b",
    newString: "B",
    replaceAll: false,
  });
  // The diff basis is LF-normalized, and the file keeps its CRLF style.
  assert.equal(outcome.before, "a\nb\n");
  assert.equal(outcome.after, "a\nB\n");
  assert.equal(Buffer.concat(binding.writes).toString(), "a\r\nB\r\n");
});

test("filesystem provider maps absolute host paths into the execution world", () => {
  const provider = createFilesystemProvider({} as any);
  assert.equal(
    provider.processPathFromHostPath("/home/u/project/f"),
    "/home/u/project/f",
  );
  assert.equal(provider.processPathFromHostPath("rel/f"), undefined);
});
