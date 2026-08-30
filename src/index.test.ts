// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
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
  foldSandboxMode,
  foldApprovalPolicy,
  READ_ONLY_TOOLS,
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

const stubResolver = {
  resolve: async () => ({ kind: "binding" }),
} as any;

test("filesystem provider resolves absolute safe paths", async () => {
  const provider = createFilesystemProvider(stubResolver);
  const target = await provider.resolve("/projects/team/app", { cwd: "/x" });
  assert.equal(target.targetKey, "/projects/team/app");
  assert.equal(target.displayPath, "/projects/team/app");
  assert.deepEqual(target.binding, { kind: "binding" });
});

test("filesystem provider rejects unsafe paths", async () => {
  const provider = createFilesystemProvider(stubResolver);
  await assert.rejects(() => provider.resolve("relative"));
  await assert.rejects(() => provider.resolve("/a/../b"));
  await assert.rejects(() => provider.resolve("/a/b/../../etc"));
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
      baseImage: "localhost/dsh-podman/arch-base:latest",
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
      assert.ok(decision!.reason.length > 0, `${tool.name} ask reason`);
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
      baseImage: "localhost/dsh-podman/arch-base:latest",
      packages: ["valkey"],
    }),
    "build image valkey from localhost/dsh-podman/arch-base:latest • packages: valkey",
  );
  assert.equal(
    summarizeArgs("image_build", {
      imageId: "dev",
      baseImage: "localhost/dsh-podman/arch-base:latest",
      packages: ["git", "curl", "tmux", "vim", "zsh", "openssh", "jq", "ripgrep", "make", "cc", "go"],
    }),
    "build image dev from localhost/dsh-podman/arch-base:latest • packages: git, curl, tmux, vim, zsh, openssh, jq, ripgrep, +3 more",
  );
  assert.equal(summarizeArgs("image_rebuild", { imageId: "valkey" }), "rebuild image valkey");
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
        baseImage: "localhost/dsh-podman/arch-base:latest",
        packages: ["valkey"],
      },
      agent: { session: { events: workspaceWrite } },
    },
    () => Promise.resolve({ kind: "allow" }),
  )) as { kind: string; reason: string };
  assert.equal(asked.kind, "ask");
  assert.equal(asked.reason, "build image valkey from localhost/dsh-podman/arch-base:latest • packages: valkey");
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
  assert.equal(summarizeArgs("container_write", { container: "c", path: "/etc/valkey/valkey.conf" }), "write /etc/valkey/valkey.conf in container c");
  assert.equal(summarizeArgs("container_edit", { container: "c", path: "/etc/valkey/valkey.conf" }), "edit /etc/valkey/valkey.conf in container c");
  assert.equal(summarizeArgs("container_bash", { container: "c", command: "ping -c 1 8.8.8.8" }), "run shell in container c: ping -c 1 8.8.8.8");
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
      const property = tool!.parameters.properties[key];
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
    assert.deepEqual(mounts.items.required, ["project", "mode"]);
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
  assert.equal(properties.uid.type, "integer");
  assert.equal(properties.uid.minimum, 0);
  assert.equal(properties.gid.type, "integer");
  assert.equal(properties.gid.minimum, 0);
  assert.equal(properties.groups.type, "array");
  assert.equal(properties.groups.items.type, "integer");
  assert.equal(properties.groups.items.minimum, 0);
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

  captured = undefined;
  await toolHandlers.daemon_start(
    resolver as never,
    { container: "valkey-ctr", argv: ["valkey-server"] },
    exec,
  );
  assert.equal(captured!.uid, undefined);
  assert.equal(captured!.gid, undefined);
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

test("container_list renders env keys on container rows", async () => {
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
      return { workspaces: [] };
    },
  } as never;
  const exec = { agent: { session: { header: { cwd: "/proj" } } } };
  const out = (await toolHandlers.container_list(resolver, {}, exec)) as string;
  assert.ok(
    out.includes("default: running (image img-1)  env=PATH, HOME"),
    out,
  );
  assert.ok(out.includes("  db: running  env=PORT, DB, X, Y"), out);
  assert.ok(out.includes("  worker: stopped"), out);
});

test("container_list renders secret_env pairs on container rows", async () => {
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
      return { workspaces: [] };
    },
  } as never;
  const exec = { agent: { session: { header: { cwd: "/proj" } } } };
  const out = (await toolHandlers.container_list(resolver, {}, exec)) as string;
  assert.ok(
    out.includes("default: running (image img-1)  secret_env=REDIS_PASSWORD=db-pass"),
    out,
  );
  assert.ok(
    out.includes(
      "  db: running  secret_env=A=a, B=b, C=c, D=d, E=e, F=f, G=g, H=h, +2 more",
    ),
    out,
  );
  assert.ok(out.includes("  worker: stopped"), out);
});
