// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { presetExec, sessionExec, testReadSession } from "./test-support.js";
import {
  approvalDecision,
  isSandboxEscalation,
  preExecutePolicy,
  READ_ONLY_TOOLS,
  SANDBOX_ESCALATION_REASON_PREFIX,
  summarizeArgs,
  TOOLS,
} from "./index.js";

// The bundle patch that declares the Podman operator preset.
function podmanOpsPatch(): string {
  return readFileSync(new URL("../cordis.patch.yml", import.meta.url), "utf8");
}

test("isSandboxEscalation claims only the harness's sandbox escalation", () => {
  assert.equal(SANDBOX_ESCALATION_REASON_PREFIX, "escalate sandbox to ");
  assert.equal(
    isSandboxEscalation({
      toolName: "bash",
      reason: "escalate sandbox to workspace-write: the user asked to write",
    }),
    true,
  );
  assert.equal(
    isSandboxEscalation({
      toolName: "pwsh",
      reason: "escalate sandbox to danger-full-access: install a package",
    }),
    true,
  );
  // The plugin's own prompts never match, so they keep prompting.
  assert.equal(
    isSandboxEscalation({
      toolName: "container_bash",
      reason: 'Run a shell command in container "c": ls',
    }),
    false,
  );
  assert.equal(
    isSandboxEscalation({
      toolName: "dsh_podman_builtin_remount_read_only",
      reason: 'Read-only mode blocks "bash" while a mount is read-write.',
    }),
    false,
  );
  // A real approval for the same tool must not be claimed.
  assert.equal(isSandboxEscalation({ toolName: "bash" }), false);
  assert.equal(isSandboxEscalation({ toolName: "bash", reason: 42 }), false);
  assert.equal(isSandboxEscalation(undefined), false);
});

test("the destructive mutations require approval", () => {
  const approval = TOOLS.filter((tool) => tool.approval)
    .map((tool) => tool.name)
    .sort();
  assert.deepEqual(approval, [
    "container_mount_add",
    "container_mount_remove",
    "container_mount_update",
    "container_path_add",
    "container_path_remove",
    "container_path_set",
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
    container_mount_update: {
      container: "valkey-ctr",
      kind: "volume",
      volume: "valkey-data",
      destination: "/data",
      mode: "read_only",
    },
    container_path_set: {
      container: "valkey-ctr",
      paths: ["/opt/bin", "/usr/local/bin"],
    },
    container_path_add: { container: "valkey-ctr", path: "/opt/bin" },
    container_path_remove: { container: "valkey-ctr", path: "/opt/bin" },
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
    'Build image "valkey" from "archlinux" with packages: valkey.',
  );
  assert.equal(
    summarizeArgs("image_build", {
      imageId: "dev",
      parent: "archlinux",
      packages: [
        "git",
        "curl",
        "tmux",
        "vim",
        "zsh",
        "openssh",
        "jq",
        "ripgrep",
        "make",
        "cc",
        "go",
      ],
    }),
    'Build image "dev" from "archlinux" with packages: git, curl, tmux, vim, zsh, openssh, jq, ripgrep, +3 more.',
  );
  assert.equal(summarizeArgs("image_rebuild", { imageId: "valkey" }), 'Rebuild image "valkey".');
  assert.equal(summarizeArgs("image_rebuild_all", {}), "Rebuild all images.");
  assert.equal(summarizeArgs("image_remove", { imageId: "valkey" }), 'Remove image "valkey".');
  assert.equal(
    summarizeArgs("container_recreate", { container: "valkey-ctr" }),
    'Recreate container "valkey-ctr".',
  );
  assert.equal(
    summarizeArgs("container_remove", { container: "valkey-ctr" }),
    'Remove container "valkey-ctr".',
  );
  assert.equal(
    summarizeArgs("volume_remove", { name: "valkey-data" }),
    'Remove volume "valkey-data".',
  );
  assert.equal(
    summarizeArgs("container_start", {
      container: "web",
      image: "localhost/dsh-podman/nginx:latest",
      mounts: [
        { project: "team/src", mode: "read_only" },
        { project: "team", destination: "/workspace/team", mode: "read_write" },
      ],
    }),
    'Start container "web" from image "localhost/dsh-podman/nginx:latest" with mounts: project "team/src" (read-only), project "team" at "/workspace/team" (read-write).',
  );
  assert.equal(
    summarizeArgs("container_recreate", {
      container: "valkey-ctr",
      image: "localhost/dsh-podman/nginx:latest",
      mounts: [
        { project: "team/src", mode: "read_only" },
        { project: "team", destination: "/workspace/team", mode: "read_write" },
      ],
    }),
    'Recreate container "valkey-ctr" from image "localhost/dsh-podman/nginx:latest" with mounts: project "team/src" (read-only), project "team" at "/workspace/team" (read-write).',
  );
  assert.equal(
    summarizeArgs("container_mount_add", {
      container: "valkey-ctr",
      kind: "volume",
      volume: "valkey-data",
      destination: "/data",
      mode: "read_write",
    }),
    'Add mount to container "valkey-ctr": volume "valkey-data" at "/data" (read-write).',
  );
  assert.equal(
    summarizeArgs("container_mount_update", {
      container: "valkey-ctr",
      kind: "volume",
      volume: "valkey-data",
      destination: "/data",
      mode: "read_write",
    }),
    'Update mount in container "valkey-ctr": remount volume "valkey-data" at "/data" to read-write.',
  );
  assert.equal(
    summarizeArgs("container_mount_add", {
      container: "valkey-ctr",
      kind: "project",
      project: "team/src",
      destination: "/workspace/team",
      mode: "read_only",
    }),
    'Add mount to container "valkey-ctr": project "team/src" at "/workspace/team" (read-only).',
  );
  assert.equal(
    summarizeArgs("container_mount_add", {
      container: "valkey-ctr",
      kind: "tmpfs",
      destination: "/dev/shm",
      mode: "read_write",
    }),
    'Add mount to container "valkey-ctr": tmpfs at "/dev/shm".',
  );
  assert.equal(
    summarizeArgs("container_mount_remove", {
      container: "valkey-ctr",
      kind: "volume",
      volume: "valkey-data",
      destination: "/data",
    }),
    'Remove mount from container "valkey-ctr": volume "valkey-data" at "/data".',
  );
  assert.equal(
    summarizeArgs("container_mount_remove", {
      container: "valkey-ctr",
      kind: "project",
      project: "team/src",
    }),
    'Remove mount from container "valkey-ctr": project "team/src".',
  );
  assert.equal(
    summarizeArgs("secret_remove", { name: "valkey-pass" }),
    'Remove secret "valkey-pass".',
  );
  assert.equal(
    summarizeArgs("container_secret_add", {
      container: "valkey-ctr",
      env: "REDIS_PASSWORD",
      secret: "valkey-pass",
    }),
    'Attach secret "valkey-pass" to container "valkey-ctr" as "REDIS_PASSWORD".',
  );
  assert.equal(
    summarizeArgs("container_secret_remove", {
      container: "valkey-ctr",
      env: "REDIS_PASSWORD",
    }),
    'Detach secret env var "REDIS_PASSWORD" from container "valkey-ctr".',
  );
  assert.equal(
    summarizeArgs("container_mount_add", {
      container: "valkey-ctr",
      kind: "secret",
      secret: "valkey-tls",
      destination: "/run/secrets/tls",
    }),
    'Add mount to container "valkey-ctr": secret "valkey-tls" at "/run/secrets/tls".',
  );
  assert.equal(
    summarizeArgs("container_mount_remove", {
      container: "valkey-ctr",
      kind: "secret",
      secret: "valkey-tls",
    }),
    'Remove mount from container "valkey-ctr": secret "valkey-tls".',
  );
});

test("summarizeArgs tolerates missing or malformed arguments", () => {
  assert.equal(summarizeArgs("image_build", {}), "");
  assert.equal(summarizeArgs("container_mount_add", { container: "c" }), "");
  assert.equal(summarizeArgs("image_list", { imageId: "x" }), "");
  assert.equal(summarizeArgs("container_recreate", { container: "c" }), 'Recreate container "c".');
  assert.equal(
    summarizeArgs("container_recreate", {
      container: "c",
      image: "img",
      mounts: [{ mode: "read_only" }, "garbage", 42],
    }),
    'Recreate container "c" from image "img".',
  );
});

test("preExecutePolicy asks for gated tools and delegates the rest", async () => {
  const asked = (await preExecutePolicy(
    { name: "image_remove", arguments: { imageId: "valkey" } },
    () => Promise.resolve({ kind: "allow" }),
  )) as { kind: string; reason: string };
  assert.equal(asked.kind, "ask");
  assert.equal(asked.reason, 'Remove image "valkey".');

  let delegated = false;
  const allowed = (await preExecutePolicy({ name: "image_list" }, () => {
    delegated = true;
    return Promise.resolve({ kind: "allow" });
  })) as { kind: string };
  assert.equal(delegated, true, "non-gated tools must delegate to next()");
  assert.equal(allowed.kind, "allow");
});

test("read-only permission allows get/list tools and denies the rest", async () => {
  for (const name of READ_ONLY_TOOLS) {
    let delegated = false;
    const result = (await preExecutePolicy(
      sessionExec(name),
      () => {
        delegated = true;
        return Promise.resolve({ kind: "allow" });
      },
      undefined,
      undefined,
      testReadSession,
    )) as { kind: string };
    assert.equal(delegated, true, `${name} must be allowed under read-only`);
    assert.equal(result.kind, "allow");
  }

  for (const name of ["image_build", "container_start", "container_remove", "volume_remove"]) {
    const result = (await preExecutePolicy(
      sessionExec(name),
      () => Promise.resolve({ kind: "allow" }),
      undefined,
      undefined,
      testReadSession,
    )) as { kind: string; reason: string };
    assert.equal(result.kind, "deny", `${name} must be denied under read-only`);
    assert.ok(result.reason.includes("read-only"), `${name} deny reason`);
  }

  for (const name of ["read", "glob", "grep", "job_output"]) {
    let delegated = false;
    const result = (await preExecutePolicy(
      sessionExec(name),
      () => {
        delegated = true;
        return Promise.resolve({ kind: "allow" });
      },
      undefined,
      undefined,
      testReadSession,
    )) as { kind: string };
    assert.equal(delegated, true, `${name} must delegate under read-only`);
    assert.equal(result.kind, "allow");
  }
});

test("read-only denies the built-in file and shell tools", async () => {
  for (const name of ["write", "edit", "bash", "pwsh"]) {
    const result = (await preExecutePolicy(
      sessionExec(name),
      () => Promise.resolve({ kind: "allow" }),
      undefined,
      undefined,
      testReadSession,
    )) as { kind: string; reason: string };
    assert.equal(result.kind, "deny", `${name} must be denied under read-only`);
    assert.equal(
      result.reason,
      `Denied: the session is read-only, but "${name}" can modify files.`,
    );
  }
});

test("workspace-write and full access delegate the built-in file and shell tools", async () => {
  for (const facts of [{ mode: "workspace-write", policy: "ask" }, { policy: "never" }]) {
    for (const name of ["write", "edit", "bash", "pwsh"]) {
      let delegated = false;
      const result = (await preExecutePolicy(
        sessionExec(name, facts),
        () => {
          delegated = true;
          return Promise.resolve({ kind: "allow" });
        },
        undefined,
        undefined,
        testReadSession,
      )) as { kind: string };
      assert.equal(delegated, true, `${name} must delegate`);
      assert.equal(result.kind, "allow");
    }
  }
});

test("the built-in file and shell tools delegate without a session", async () => {
  for (const name of ["write", "edit", "bash", "pwsh"]) {
    let delegated = false;
    await preExecutePolicy(
      { name },
      () => {
        delegated = true;
        return Promise.resolve({ kind: "allow" });
      },
      undefined,
      undefined,
      testReadSession,
    );
    assert.equal(delegated, true, `${name} must delegate without a session`);
  }
});

test("full-access (approval never) runs tools without asking", async () => {
  for (const name of ["image_build", "container_replace", "container_remove"]) {
    let delegated = false;
    const result = (await preExecutePolicy(
      sessionExec(name, { policy: "never" }),
      () => {
        delegated = true;
        return Promise.resolve({ kind: "allow" });
      },
      undefined,
      undefined,
      testReadSession,
    )) as { kind: string };
    assert.equal(delegated, true, `${name} must not ask under full access`);
    assert.equal(result.kind, "allow");
  }
});

test("workspace-write keeps the ask-based approval", async () => {
  const asked = (await preExecutePolicy(
    {
      name: "image_build",
      arguments: {
        imageId: "valkey",
        parent: "archlinux",
        packages: ["valkey"],
      },
      agent: { session: { facts: { mode: "workspace-write", policy: "ask" } } },
    },
    () => Promise.resolve({ kind: "allow" }),
    undefined,
    undefined,
    testReadSession,
  )) as { kind: string; reason: string };
  assert.equal(asked.kind, "ask");
  assert.equal(asked.reason, 'Build image "valkey" from "archlinux" with packages: valkey.');
});

test("read-only wins over a never approval policy", async () => {
  const result = (await preExecutePolicy(
    sessionExec("image_build", { mode: "read-only", policy: "never" }),
    () => Promise.resolve({ kind: "allow" }),
    undefined,
    undefined,
    testReadSession,
  )) as { kind: string };
  assert.equal(result.kind, "deny", "read-only must deny mutating tools even under full access");
});

test("podman-ops preset asks for its approval-gated tools only", async () => {
  const workspaceWrite = { mode: "workspace-write", policy: "ask" };
  const asked = (await preExecutePolicy(
    presetExec("container_bash", "podman-ops", {
      container: "valkey-ctr",
      command: "valkey-cli ping",
    }, workspaceWrite),
    () => Promise.resolve({ kind: "allow" }),
    undefined,
    undefined,
    testReadSession,
  )) as { kind: string; reason: string };
  assert.equal(asked.kind, "ask");
  assert.equal(asked.reason, 'Run a shell command in container "valkey-ctr": valkey-cli ping');

  const daemon = (await preExecutePolicy(
    presetExec("daemon_start", "podman-ops", {
      container: "valkey-ctr",
      name: "v1",
      argv: ["valkey-server"],
      uid: 1001,
    }, workspaceWrite),
    () => Promise.resolve({ kind: "allow" }),
    undefined,
    undefined,
    testReadSession,
  )) as { kind: string; reason: string };
  assert.equal(daemon.kind, "ask");
  assert.equal(
    daemon.reason,
    'Start daemon "v1" in container "valkey-ctr": valkey-server (uid 1001)',
  );
});

test("podman-ops approval does not leak into other presets", async () => {
  const workspaceWrite = { mode: "workspace-write", policy: "ask" };
  for (const preset of ["standard", undefined]) {
    let delegated = false;
    const result = (await preExecutePolicy(
      presetExec(
        "container_bash",
        preset as string,
        { container: "c", command: "ls" },
        workspaceWrite,
      ),
      () => {
        delegated = true;
        return Promise.resolve({ kind: "allow" });
      },
      undefined,
      undefined,
      testReadSession,
    )) as { kind: string };
    assert.equal(delegated, true, `${preset}: container_bash must delegate`);
    assert.equal(result.kind, "allow");
  }
});

test("podman-ops keeps open tools ungated and respects permissions", async () => {
  const workspaceWrite = { mode: "workspace-write", policy: "ask" };
  let delegated = false;
  const open = (await preExecutePolicy(
    presetExec("image_list", "podman-ops", {}, workspaceWrite),
    () => {
      delegated = true;
      return Promise.resolve({ kind: "allow" });
    },
    undefined,
    undefined,
    testReadSession,
  )) as { kind: string };
  assert.equal(delegated, true, "image_list must stay open in podman-ops");
  assert.equal(open.kind, "allow");

  const denied = (await preExecutePolicy(
    presetExec("container_bash", "podman-ops", { container: "c", command: "ls" }, {
      mode: "read-only",
    }),
    () => Promise.resolve({ kind: "allow" }),
    undefined,
    undefined,
    testReadSession,
  )) as { kind: string };
  assert.equal(denied.kind, "deny", "read-only wins over podman-ops approval");

  let fullDelegated = false;
  const full = (await preExecutePolicy(
    presetExec("daemon_start", "podman-ops", { container: "c", argv: ["x"] }, { policy: "never" }),
    () => {
      fullDelegated = true;
      return Promise.resolve({ kind: "allow" });
    },
    undefined,
    undefined,
    testReadSession,
  )) as { kind: string };
  assert.equal(fullDelegated, true, "full access must not ask");
  assert.equal(full.kind, "allow");
});

test("summarizeArgs renders reasons for the podman-ops gated tools", () => {
  assert.equal(
    summarizeArgs("container_exec", {
      container: "c",
      argv: ["python", "run.py", "--x", "1", "--y", "2", "--z", "3", "--w", "4", "--v", "5"],
    }),
    'Run a command in container "c": python run.py --x 1 --y 2 --z 3 …',
  );
  assert.equal(
    summarizeArgs("container_write", { container: "c", file_path: "/etc/valkey/valkey.conf" }),
    'Write "/etc/valkey/valkey.conf" in container "c".',
  );
  assert.equal(
    summarizeArgs("container_edit", { container: "c", file_path: "/etc/valkey/valkey.conf" }),
    'Edit "/etc/valkey/valkey.conf" in container "c".',
  );
  assert.equal(
    summarizeArgs("container_bash", { container: "c", command: "ping -c 1 8.8.8.8" }),
    'Run a shell command in container "c": ping -c 1 8.8.8.8',
  );
  assert.equal(
    summarizeArgs("container_bash", { container: "c", command: "ls", workdir: "/srv" }),
    'Run a shell command in container "c" (cwd "/srv"): ls',
  );
  assert.equal(
    summarizeArgs("container_exec", { container: "c", argv: ["ls"], workdir: "/srv" }),
    'Run a command in container "c" (cwd "/srv"): ls',
  );
});

test("summarizeArgs names the process identity and groups", () => {
  assert.equal(
    summarizeArgs("container_bash", {
      container: "c",
      command: "id",
      uid: 1000,
      gid: 1000,
      groups: [3000, 4000],
    }),
    'Run a shell command in container "c": id (uid 1000, gid 1000, groups 3000, 4000)',
  );
  assert.equal(
    summarizeArgs("container_exec", { container: "c", argv: ["id"], gid: 2000 }),
    'Run a command in container "c": id (gid 2000)',
  );
  assert.equal(
    summarizeArgs("daemon_start", {
      container: "c",
      name: "web",
      argv: ["nginx"],
      uid: 1000,
      groups: [3000],
    }),
    'Start daemon "web" in container "c": nginx (uid 1000, groups 3000)',
  );
  // An empty groups list is not worth naming.
  assert.equal(
    summarizeArgs("container_exec", { container: "c", argv: ["id"], groups: [] }),
    'Run a command in container "c": id',
  );
});

test("Podman-ops preset content covers the recent tools", () => {
  const patch = podmanOpsPatch();
  for (
    const tool of [
      "image_rebuild_all",
      "secret_list",
      "secret_create",
      "secret_remove",
      "container_secret_add",
      "container_secret_remove",
    ]
  ) {
    assert.ok(
      patch.includes(tool),
      `podman-ops composition must mention ${tool}`,
    );
  }
  assert.match(patch, /id: podman-ops/, "the preset row must carry the policy's preset id");
  assert.ok(patch.includes("secrets"), "podman-ops metadata must mention secrets");
  // The persona plugin takes its prose as `prefix` (a required field); `text`
  // is not part of its schema and would make the preset fail to load.
  assert.match(patch, /prefix:/);
  assert.doesNotMatch(patch, /\btext:/);
});

test("Podman-ops preset declares its composition as plugin rows", () => {
  const patch = podmanOpsPatch();
  for (
    const plugin of [
      "@deepseek-ai/dsh-persona",
      "@deepseek-ai/dsh-tool-ask-user",
      "@deepseek-ai/dsh-tool-todo",
      "@deepseek-ai/dsh-tool-web",
    ]
  ) {
    assert.ok(
      patch.includes(plugin),
      `podman-ops composition must declare ${plugin}`,
    );
  }
  assert.ok(
    patch.includes("@deepseek-ai/dsh-agent-preset"),
    "the preset must be declared through the agent-preset row",
  );
});

test("summarizeArgs includes PATH additions for container start/recreate", () => {
  assert.equal(
    summarizeArgs("container_start", { container: "web", paths: ["/opt/bin"] }),
    'Start container "web" with PATH additions: "/opt/bin".',
  );
  assert.equal(
    summarizeArgs("container_recreate", {
      container: "c",
      image: "img",
      paths: ["/opt/bin", "/usr/local/bin"],
    }),
    'Recreate container "c" from image "img" with PATH additions: "/opt/bin", "/usr/local/bin".',
  );
  // An empty list is not worth naming.
  assert.equal(
    summarizeArgs("container_start", { container: "web", paths: [] }),
    'Start container "web".',
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
    'Start container "web" with env: A, B.',
  );
  assert.equal(
    summarizeArgs("container_start", {
      container: "web",
      image: "localhost/dsh-podman/nginx:latest",
      mounts: [{ project: "team", mode: "read_only" }],
      env: { A: "1", B: "2", C: "3" },
    }),
    'Start container "web" from image "localhost/dsh-podman/nginx:latest" with mounts: project "team" (read-only) with env: A, B, C.',
  );
  assert.equal(
    summarizeArgs("container_start", {
      container: "web",
      env: { A: "1", B: "2", C: "3", D: "4", E: "5", F: "6", G: "7", H: "8", I: "9", J: "10" },
    }),
    'Start container "web" with env: A, B, C, D, E, F, G, H, +2 more.',
  );
  assert.equal(
    summarizeArgs("container_recreate", {
      container: "c",
      image: "img",
      env: { A: "1" },
    }),
    'Recreate container "c" from image "img" with env: A.',
  );
  assert.equal(
    summarizeArgs("container_recreate", { container: "c", env: {} }),
    'Recreate container "c".',
  );
});

test("approval prompts name the resolved path", () => {
  assert.equal(
    summarizeArgs("container_write", { container: "c", file_path: "notes.md" }, "/projects/team"),
    'Write "/projects/team/notes.md" in container "c".',
  );
  assert.equal(
    summarizeArgs("container_edit", { container: "c", file_path: "notes.md" }, "/projects/team"),
    'Edit "/projects/team/notes.md" in container "c".',
  );
  // Without a session cwd, or for a path that cannot resolve, the prompt still
  // renders with the value as given.
  assert.equal(
    summarizeArgs("container_write", { container: "c", file_path: "notes.md" }),
    'Write "notes.md" in container "c".',
  );
  assert.equal(
    summarizeArgs("container_write", { container: "c", file_path: "../x" }, "/projects/team"),
    'Write "../x" in container "c".',
  );
});

test("summarizeArgs includes secret env names for container start/recreate", () => {
  assert.equal(
    summarizeArgs("container_start", {
      container: "web",
      secretEnv: { TOKEN: "api-token" },
    }),
    'Start container "web" with secret env: TOKEN.',
  );
  assert.equal(
    summarizeArgs("container_recreate", {
      container: "c",
      env: { A: "1" },
      secretEnv: { TOKEN: "api-token" },
    }),
    'Recreate container "c" with env: A with secret env: TOKEN.',
  );
  // An empty map is not an attachment and is not named.
  assert.equal(
    summarizeArgs("container_start", { container: "web", secretEnv: {} }),
    'Start container "web".',
  );
});

test("container_start asks for approval when it attaches secrets", () => {
  // Plain env, paths, and a bare start stay prompt-free by design: the caller
  // already knows those values, unlike a secret the container injects.
  assert.equal(
    approvalDecision("container_start", { container: "web" }),
    undefined,
  );
  assert.equal(
    approvalDecision("container_start", { container: "web", paths: ["/opt/bin"] }),
    undefined,
  );
  assert.equal(
    approvalDecision("container_start", { container: "web", env: { A: "1" } }),
    undefined,
  );
  assert.equal(
    approvalDecision("container_start", { container: "web", secretEnv: {} }),
    undefined,
  );
  // Mounts and secret attachments both change what the container can reach.
  assert.equal(
    approvalDecision("container_start", {
      container: "web",
      mounts: [{ project: "team" }],
    })?.kind,
    "ask",
  );
  const withSecret = approvalDecision("container_start", {
    container: "web",
    secretEnv: { TOKEN: "api-token" },
  });
  assert.equal(withSecret?.kind, "ask");
  assert.match(withSecret?.reason ?? "", /secret env: TOKEN/);
});

test("the bundle patch disables the built-in terminal UI", () => {
  // The Podman terminal replaces the built-in one; its client row must stay off
  // so the guide offers a single terminal card and Ctrl+` is free.
  assert.match(podmanOpsPatch(), /- id: ui-sidebar-terminal\n\s+disabled: true/);
});
