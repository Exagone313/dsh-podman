// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { presetExec, readOnlyExec } from "./test-support.js";
import {
  PODMAN_OPS_AGENT_CORDIS_YML,
  PODMAN_OPS_PRESET_YML,
  READ_ONLY_TOOLS,
  TOOLS,
  approvalDecision,
  ensurePodmanOpsPreset,
  foldApprovalPolicy,
  foldSandboxMode,
  preExecutePolicy,
  summarizeArgs,
} from "./index.js";

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

test("an approval ask omits the reason when no summary can be derived", () => {
  assert.deepEqual(approvalDecision("container_mount_remove", { container: "c" }), {
    kind: "ask",
  });
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
