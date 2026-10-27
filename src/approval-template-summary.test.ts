// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preExecutePolicy, summarizeArgs } from "./index.js";
import { readTemplateLoadSummary } from "./approval-template-summary.js";
import { testReadSession } from "./test-support.js";

const WORKSPACE_ID = "33333333-3333-4333-8333-333333333333";

const DEVELOP = `version: 1
kind: dsh-podman/container-template
spec:
  imageTemplate:
    base: archlinux
    packages: [go, nodejs, npm, python-chardet, reuse]
  env:
    A: "1"
    B: "2"
    C: "3"
    D: "4"
    E: "5"
    F: "6"
    G: "7"
  mounts:
    - {kind: project, project: dsh-podman, mode: read_write}
    - {kind: project, project: deepseek-harness, mode: read_only}
    - {kind: volume, volume: dsh-podman-toolchain, destination: /opt/toolchain, mode: read_write}
  paths:
    - /usr/local/go/bin
    - /usr/local/bin
    - /opt/toolchain/bin
`;

const WEB = `version: 1
kind: dsh-podman/container-template
spec:
  imageTemplate:
    base: ubuntu
    packages: [neovim]
  env: {NODE_ENV: development, PORT: "8080"}
  secretEnv: {TOKEN: npm-token}
  mounts:
    - {kind: project, project: app}
    - {kind: volume, volume: cache, destination: /cache}
    - {kind: secret, secret: npm-token, destination: /run/secrets/npm}
    - {kind: tmpfs, destination: /scratch}
  paths: [/usr/local/bin]
  ports:
    - {container: 8080, host: 9090, protocol: tcp}
`;

const BASE_ONLY = `version: 1
kind: dsh-podman/container-template
spec:
  image: alpine
  mounts:
    - {kind: project, project: app}
`;

const NO_GROUPS = `version: 1
kind: dsh-podman/container-template
spec:
  image: alpine
  mounts:
    - {kind: project, project: app}
  env: {}
  secretEnv: {}
  paths: []
`;

interface Harness {
  root: string;
  project: string;
  resolver: any;
  calls: Array<[string, any]>;
}

async function harness(
  options: {
    projectName?: string;
    template?: string;
    containers?: unknown[];
    workspaces?: unknown[];
    workspace?: unknown;
    failControl?: string;
  } = {},
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "dsh-template-summary-"));
  const project = join(root, options.projectName ?? "app");
  await mkdir(join(project, ".dsh-podman"), { recursive: true });
  await writeFile(
    join(project, ".dsh-podman", "develop.yml"),
    options.template ?? DEVELOP,
  );
  await writeFile(join(project, ".dsh-podman", "web.yml"), WEB);
  await writeFile(join(project, ".dsh-podman", "base.yml"), BASE_ONLY);
  await writeFile(join(project, ".dsh-podman", "empty.yml"), NO_GROUPS);
  const calls: Array<[string, any]> = [];
  const resolver: any = {
    registry: {
      resolveByPath: async () =>
        options.workspace === undefined
          ? { id: WORKSPACE_ID, path: project }
          : options.workspace,
    },
    getConfig: () => ({ projectsRoot: root }),
    async control(method: string, request: any) {
      calls.push([method, request]);
      if (method === options.failControl) throw new Error("control failed");
      if (method === "listContainers") {
        return { containers: options.containers ?? [] };
      }
      if (method === "listWorkspaces") {
        return { workspaces: options.workspaces ?? [] };
      }
      return {};
    },
  };
  return { root, project, resolver, calls };
}

async function cleanup(t: Harness): Promise<void> {
  await rm(t.root, { recursive: true, force: true });
}

function currentDevelop(): any {
  return {
    workspaceSlug: WORKSPACE_ID,
    containerName: "default",
    mounts: [
      {
        projectName: "dsh-podman",
        kind: "MOUNT_KIND_PROJECT",
        mode: "MOUNT_MODE_READ_WRITE",
      },
      {
        projectName: "deepseek-harness",
        kind: "MOUNT_KIND_PROJECT",
        mode: "MOUNT_MODE_READ_ONLY",
      },
      {
        volume: "dsh-podman-toolchain",
        destination: "/opt/toolchain",
        kind: "MOUNT_KIND_VOLUME",
        mode: "MOUNT_MODE_READ_WRITE",
      },
    ],
    env: { A: "1", B: "2", C: "3", D: "4", E: "5", F: "6", G: "7" },
    secretEnv: {},
    paths: ["/usr/local/go/bin", "/usr/local/bin", "/opt/toolchain/bin"],
  };
}

test("the provider summarizes a develop-like template and its zero removals", async () => {
  const t = await harness({
    projectName: "dsh-podman",
    containers: [currentDevelop()],
  });
  try {
    const summary = await readTemplateLoadSummary(t.resolver, t.root, {
      template: "develop",
      container: "default",
      cwd: t.project,
    });
    assert.deepEqual(summary, {
      image: {
        base: "archlinux",
        packages: ["go", "nodejs", "npm", "python-chardet", "reuse"],
      },
      mounts: [
        { kind: "project", source: "dsh-podman", readOnly: false },
        { kind: "project", source: "deepseek-harness", readOnly: true },
        {
          kind: "volume",
          source: "dsh-podman-toolchain",
          destination: "/opt/toolchain",
          readOnly: false,
        },
      ],
      secretEnv: [],
      ports: [],
      envCount: 7,
      pathCount: 3,
      removals: { mounts: 0, env: 0, secretEnv: 0, paths: 0 },
    });
    assert.equal(
      summarizeArgs(
        "container_template_load",
        { template: "develop", container: "default" },
        t.project,
        "en",
        summary,
      ),
      'Apply container template "develop" to container "default". Image: archlinux plus 5 packages (go, nodejs, npm, python-chardet, reuse). Mounts: project "dsh-podman" (read-write); project "deepseek-harness" (read-only); volume "dsh-podman-toolchain" at "/opt/toolchain" (read-write). Secret environment: none. Ports: none. Environment: 7 variables. PATH: 3 additions.',
    );
    assert.ok(
      t.calls.some(([method]) => method === "listContainers"),
      "the existing container is read from listContainers",
    );
  } finally {
    await cleanup(t);
  }
});

test("the provider summarizes secrets, ports and a base-only image", async () => {
  const t = await harness();
  try {
    const web = await readTemplateLoadSummary(t.resolver, t.root, {
      template: "web",
      container: "default",
      cwd: t.project,
    });
    assert.deepEqual(web?.image, {
      base: "ubuntu",
      packages: ["neovim"],
    });
    assert.deepEqual(web?.secretEnv, [{ env: "TOKEN", secret: "npm-token" }]);
    assert.deepEqual(web?.ports, [{ container: 8080, host: 9090 }]);
    assert.equal(web?.envCount, 2);
    assert.equal(web?.pathCount, 1);

    const base = await readTemplateLoadSummary(t.resolver, t.root, {
      template: "base",
      container: "default",
      cwd: t.project,
    });
    assert.deepEqual(base?.image, { base: "alpine" });
    assert.deepEqual(base?.secretEnv, []);
    assert.deepEqual(base?.ports, []);
  } finally {
    await cleanup(t);
  }
});

test("removals count each group the template replaces", async () => {
  const t = await harness({
    containers: [{
      workspaceSlug: WORKSPACE_ID,
      containerName: "default",
      mounts: [
        {
          projectName: "app",
          kind: "MOUNT_KIND_PROJECT",
          mode: "MOUNT_MODE_READ_ONLY",
        },
        {
          volume: "cache",
          destination: "/cache",
          kind: "MOUNT_KIND_VOLUME",
          mode: "MOUNT_MODE_READ_ONLY",
        },
        {
          projectName: "extra",
          kind: "MOUNT_KIND_PROJECT",
          mode: "MOUNT_MODE_READ_ONLY",
        },
      ],
      env: { NODE_ENV: "production", EXTRA: "1" },
      secretEnv: { TOKEN: "npm-token", OLD: "old-token" },
      paths: ["/usr/local/bin", "/old/bin"],
    }],
  });
  try {
    const summary = await readTemplateLoadSummary(t.resolver, t.root, {
      template: "web",
      container: "default",
      cwd: t.project,
    });
    assert.deepEqual(summary?.removals, {
      mounts: 1,
      env: 1,
      secretEnv: 1,
      paths: 1,
    });
  } finally {
    await cleanup(t);
  }
});

test("a template that declares no group removes only mounts", async () => {
  const t = await harness({
    containers: [{
      workspaceSlug: WORKSPACE_ID,
      containerName: "default",
      mounts: [
        {
          projectName: "app",
          kind: "MOUNT_KIND_PROJECT",
          mode: "MOUNT_MODE_READ_WRITE",
        },
        {
          volume: "data",
          destination: "/data",
          kind: "MOUNT_KIND_VOLUME",
          mode: "MOUNT_MODE_READ_ONLY",
        },
      ],
      env: { KEEP: "1" },
      secretEnv: { KEEP: "secret" },
      paths: ["/keep/bin"],
    }],
  });
  try {
    const summary = await readTemplateLoadSummary(t.resolver, t.root, {
      template: "empty",
      container: "default",
      cwd: t.project,
    });
    assert.deepEqual(summary?.removals, {
      mounts: 1,
      env: 0,
      secretEnv: 0,
      paths: 0,
    });
  } finally {
    await cleanup(t);
  }
});

test("the workspace listing supplies a default container listContainers hides", async () => {
  const t = await harness({
    workspaces: [{
      workspaceSlug: WORKSPACE_ID,
      mounts: [
        {
          projectName: "app",
          kind: "MOUNT_KIND_PROJECT",
          mode: "MOUNT_MODE_READ_ONLY",
        },
        {
          volume: "data",
          destination: "/data",
          kind: "MOUNT_KIND_VOLUME",
          mode: "MOUNT_MODE_READ_ONLY",
        },
      ],
      env: { KEEP: "1" },
      secretEnv: {},
    }],
  });
  try {
    const summary = await readTemplateLoadSummary(t.resolver, t.root, {
      template: "empty",
      container: "default",
      cwd: t.project,
    });
    assert.deepEqual(summary?.removals, {
      mounts: 1,
      env: 0,
      secretEnv: 0,
      paths: 0,
    });
    assert.ok(
      t.calls.some(([method]) => method === "listWorkspaces"),
      "the workspace fallback is read",
    );
  } finally {
    await cleanup(t);
  }
});

test("the provider returns undefined when any fact cannot be read", async () => {
  const missingWorkspace = await harness({ workspace: null });
  try {
    assert.equal(
      await readTemplateLoadSummary(
        missingWorkspace.resolver,
        missingWorkspace.root,
        {
          template: "develop",
          container: "default",
          cwd: missingWorkspace.project,
        },
      ),
      undefined,
    );
  } finally {
    await cleanup(missingWorkspace);
  }

  const invalidTemplate = await harness({ template: ": not yaml: [" });
  try {
    assert.equal(
      await readTemplateLoadSummary(
        invalidTemplate.resolver,
        invalidTemplate.root,
        {
          template: "develop",
          container: "default",
          cwd: invalidTemplate.project,
        },
      ),
      undefined,
    );
  } finally {
    await cleanup(invalidTemplate);
  }

  const controlFailure = await harness({ failControl: "listContainers" });
  try {
    assert.equal(
      await readTemplateLoadSummary(
        controlFailure.resolver,
        controlFailure.root,
        {
          template: "develop",
          container: "default",
          cwd: controlFailure.project,
        },
      ),
      undefined,
    );
  } finally {
    await cleanup(controlFailure);
  }
});

test("preExecutePolicy appends the provider's summary to the ask", async () => {
  const t = await harness({
    projectName: "dsh-podman",
    containers: [currentDevelop()],
  });
  try {
    const requests: unknown[] = [];
    const exec = {
      name: "container_template_load",
      arguments: { template: "develop" },
      agent: {
        session: {
          header: { cwd: t.project },
          facts: { mode: "workspace-write", policy: "ask" },
        },
      },
    };
    const asked = (await preExecutePolicy(
      exec,
      () => Promise.resolve({ kind: "allow" }),
      () => t.root,
      () => "en",
      testReadSession,
      undefined,
      async (request) => {
        requests.push(request);
        return await readTemplateLoadSummary(t.resolver, t.root, request);
      },
    )) as { kind: string; reason: string };
    assert.equal(asked.kind, "ask");
    assert.deepEqual(requests, [{
      template: "develop",
      container: "default",
      cwd: t.project,
    }]);
    assert.equal(
      asked.reason,
      'Apply container template "develop" to the default container. Image: archlinux plus 5 packages (go, nodejs, npm, python-chardet, reuse). Mounts: project "dsh-podman" (read-write); project "deepseek-harness" (read-only); volume "dsh-podman-toolchain" at "/opt/toolchain" (read-write). Secret environment: none. Ports: none. Environment: 7 variables. PATH: 3 additions.',
    );
  } finally {
    await cleanup(t);
  }
});

test("preExecutePolicy falls back to the base sentence on provider failure", async () => {
  const exec = {
    name: "container_template_load",
    arguments: { template: "develop", container: "dev" },
    agent: {
      session: {
        header: { cwd: "/projects/app" },
        facts: { mode: "workspace-write", policy: "ask" },
      },
    },
  };
  const rejected = (await preExecutePolicy(
    exec,
    () => Promise.resolve({ kind: "allow" }),
    () => "/projects",
    () => "en",
    testReadSession,
    undefined,
    () => Promise.reject(new Error("unreadable")),
  )) as { kind: string; reason: string };
  assert.equal(rejected.kind, "ask");
  assert.equal(
    rejected.reason,
    'Apply container template "develop" to container "dev".',
  );

  const ignored = (await preExecutePolicy(
    exec,
    () => Promise.resolve({ kind: "allow" }),
    () => "/projects",
    () => "en",
    testReadSession,
    undefined,
    async () => undefined,
  )) as { kind: string; reason: string };
  assert.equal(
    ignored.reason,
    'Apply container template "develop" to container "dev".',
  );
});

test("preExecutePolicy keeps the base sentence without a provider", async () => {
  const t = await harness();
  try {
    const asked = (await preExecutePolicy(
      {
        name: "container_template_load",
        arguments: { template: "web" },
        agent: {
          session: {
            header: { cwd: t.project },
            facts: { mode: "workspace-write", policy: "ask" },
          },
        },
      },
      () => Promise.resolve({ kind: "allow" }),
      () => t.root,
      () => "zh",
      testReadSession,
    )) as { kind: string; reason: string };
    assert.equal(asked.kind, "ask");
    assert.equal(
      asked.reason,
      "将容器模板“web”应用到默认容器。",
    );
  } finally {
    await cleanup(t);
  }
});

test("preExecutePolicy calls the template provider only for template load", async () => {
  let calls = 0;
  const provider = async () => {
    calls += 1;
    return undefined;
  };
  const asked = (await preExecutePolicy(
    {
      name: "image_remove",
      arguments: { imageId: "valkey" },
      agent: {
        session: {
          facts: { mode: "workspace-write", policy: "ask" },
        },
      },
    },
    () => Promise.resolve({ kind: "allow" }),
    undefined,
    () => "en",
    testReadSession,
    undefined,
    provider,
  )) as { kind: string; reason: string };
  assert.equal(asked.kind, "ask");
  assert.equal(asked.reason, 'Remove image "valkey".');
  assert.equal(calls, 0);
});
