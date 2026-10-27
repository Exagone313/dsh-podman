// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grpc } from "./grpc/runtime-client.js";
import {
  READ_ONLY_TOOLS,
  summarizeArgs,
  toolHandlers,
  TOOLS,
} from "./index.js";
import { exportContainerTemplate } from "./container-template.js";

const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";

const TEMPLATE = `version: 1
kind: dsh-podman/container-template
spec:
  imageTemplate:
    base: ubuntu
    packages: [neovim]
  env: {NODE_ENV: development}
  secretEnv: {TOKEN: token}
  mounts:
    - {kind: project, project: app}
    - {kind: volume, volume: cache, destination: /cache, mode: read_write}
  paths: [/usr/local/bin]
  ports:
    - {container: 8080, host: 8080, protocol: tcp}
`;

interface Harness {
  root: string;
  project: string;
  resolver: any;
  calls: Array<[string, any]>;
  saved: any[];
  setContainers(rows: any[]): void;
  setImages(rows: any[]): void;
}

async function harness(options: {
  workspaceExists?: boolean;
  containers?: any[];
  images?: any[];
  publishFails?: boolean;
} = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "dsh-template-tools-"));
  const project = join(root, "app");
  await mkdir(join(project, ".dsh-podman"), { recursive: true });
  await writeFile(join(project, ".dsh-podman", "web.yml"), TEMPLATE);
  const calls: Array<[string, any]> = [];
  const saved: any[] = [];
  let containers = options.containers ?? [];
  let images = options.images ?? [];
  const resolver: any = {
    registry: {
      resolveByPath: async () => ({ id: WORKSPACE_ID, path: project }),
    },
    getConfig: () => ({ projectsRoot: root }),
    async resolve() {
      return {
        token: "t",
        guest: {
          writeTemplate: (request: any, _metadata: any, callback: any) => {
            saved.push(request);
            callback(null, {
              path: join(
                project,
                ".dsh-podman",
                request.name,
              ),
            });
          },
        },
      };
    },
    async control(method: string, request: any) {
      calls.push([method, request]);
      switch (method) {
        case "listImages":
          return { images: [...images] };
        case "listSecrets":
          return { secrets: [{ name: "token" }] };
        case "listContainers":
          return {
            containers: containers.map((container) => ({
              ...container,
              workspaceSlug: container.workspaceSlug ?? WORKSPACE_ID,
              containerName: container.containerName ?? container.name,
            })),
          };
        case "describeWorkspace":
          if (options.workspaceExists === false) {
            throw Object.assign(new Error("workspace not found"), {
              code: grpc.status.NOT_FOUND,
            });
          }
          return {
            workspaceSlug: WORKSPACE_ID,
            containers: containers.length > 0
              ? containers
              : [{ name: "default" }],
          };
        case "buildImage":
          images.push({
            imageId: request.imageId,
            parent: request.parent,
            packages: request.packages,
            status: "built",
          });
          return {};
        case "publishPort":
          if (options.publishFails) throw new Error("gateway is not running");
          return {};
        case "createWorkspace":
        case "startContainer":
          return {
            containerName: request.container ?? "default",
            workspaceSlug: request.workspaceSlug,
            imageId: request.imageId,
            status: "running",
            mounts: request.mounts ?? [],
            env: request.env ?? {},
            secretEnv: request.secretEnv ?? {},
            paths: request.paths ?? [],
            publishedPorts: [],
            agentToken: "never-returned",
          };
        default:
          return {};
      }
    },
  };
  return {
    root,
    project,
    resolver,
    calls,
    saved,
    setContainers(rows: any[]) {
      containers = rows;
    },
    setImages(rows: any[]) {
      images = rows;
    },
  };
}

const exec = async (project: string): Promise<any> => ({
  agent: { session: { header: { cwd: project } } },
});

async function cleanup(t: Harness): Promise<void> {
  await rm(t.root, { recursive: true, force: true });
}

test("the template tools are registered with the right approval", () => {
  for (
    const name of [
      "container_template_load",
      "container_template_export",
      "container_template_save",
    ]
  ) {
    assert.ok(TOOLS.some((tool) => tool.name === name), `${name} registered`);
  }
  assert.equal(
    TOOLS.find((tool) => tool.name === "container_template_load")?.approval,
    true,
  );
  assert.equal(
    TOOLS.find((tool) => tool.name === "container_template_save")?.approval,
    true,
  );
  assert.equal(
    TOOLS.find((tool) => tool.name === "container_template_export")?.approval,
    undefined,
  );
  assert.ok(
    READ_ONLY_TOOLS.has("container_template_export"),
    "export stays available under read-only",
  );
});

test("container_template_load builds the image and creates the container without leaking internals", async () => {
  const t = await harness({ workspaceExists: false, publishFails: true });
  try {
    const result = (await toolHandlers.container_template_load(
      t.resolver,
      { template: "web" },
      await exec(t.project),
    )) as any;
    assert.equal(result.containerName, "default");
    assert.equal(result.template, "web.yml");
    assert.match(result.imageId, /^template-web-/);
    assert.equal(result.agentToken, undefined);
    assert.equal(result.workspaceSlug, undefined);
    assert.match(result.warnings[0], /port 8080\/tcp/);
    const create = t.calls.find(([method]) => method === "createWorkspace");
    assert.equal(create?.[1].projectName, "app");
    assert.deepEqual(create?.[1].mounts[0], {
      projectName: "app",
      kind: "MOUNT_KIND_PROJECT",
      mode: "MOUNT_MODE_READ_ONLY",
    });
    assert.deepEqual({ ...create?.[1].env }, { NODE_ENV: "development" });
    assert.deepEqual({ ...create?.[1].secretEnv }, { TOKEN: "token" });
    assert.deepEqual(create?.[1].paths, ["/usr/local/bin"]);
    assert.ok(t.calls.some(([method]) => method === "buildImage"));
  } finally {
    await cleanup(t);
  }
});

test("container_template_load creates a named container in an existing workspace", async () => {
  const t = await harness({
    containers: [{ name: "default" }],
  });
  try {
    const result = (await toolHandlers.container_template_load(
      t.resolver,
      { template: "web.yml", container: "web" },
      await exec(t.project),
    )) as any;
    assert.equal(result.containerName, "web");
    const start = t.calls.find(([method]) => method === "startContainer");
    assert.equal(start?.[1].container, "web");
    // Creating from a template never writes a template document.
    assert.deepEqual(t.saved, []);
  } finally {
    await cleanup(t);
  }
});

test("container_template_load replaces an existing container in place", async () => {
  const t = await harness({
    containers: [{ containerName: "default", imageId: "ubuntu" }],
  });
  try {
    const result = (await toolHandlers.container_template_load(
      t.resolver,
      { template: "web" },
      await exec(t.project),
    )) as any;
    assert.equal(result.containerName, "default");
    assert.match(result.imageId, /^template-web-/);
    // The replace goes through StartContainer with the whole template payload;
    // nothing is removed or recreated separately.
    const start = t.calls.find(([method]) => method === "startContainer");
    assert.ok(start);
    assert.equal(start[1].container, "default");
    assert.equal(start[1].imageId, result.imageId);
    assert.deepEqual(start[1].mounts[0], {
      projectName: "app",
      kind: "MOUNT_KIND_PROJECT",
      mode: "MOUNT_MODE_READ_ONLY",
    });
    assert.deepEqual({ ...start[1].env }, { NODE_ENV: "development" });
    assert.deepEqual({ ...start[1].secretEnv }, { TOKEN: "token" });
    assert.deepEqual(start[1].paths, ["/usr/local/bin"]);
  } finally {
    await cleanup(t);
  }
});

test("container_template_load cannot create a named container without a workspace", async () => {
  const t = await harness({ workspaceExists: false });
  try {
    await assert.rejects(
      async () =>
        toolHandlers.container_template_load(
          t.resolver,
          { template: "web", container: "dev" },
          await exec(t.project),
        ),
      /has no container yet/,
    );
  } finally {
    await cleanup(t);
  }
});

test("container_template_export returns the YAML and exports a base-only custom image as image:", async () => {
  const t = await harness();
  try {
    t.setImages([
      { imageId: "ubuntu", parent: "", packages: ["git"], isBase: true },
      { imageId: "only-builtins", parent: "ubuntu", packages: ["git"] },
    ]);
    t.setContainers([{
      containerName: "default",
      workspaceSlug: WORKSPACE_ID,
      imageId: "only-builtins",
      mounts: [
        { kind: "project", projectName: "z" },
        { kind: "project", projectName: "app" },
      ],
      env: {},
      secretEnv: {},
      paths: [],
      publishedPorts: [{
        port: 8080,
        hostPort: 8080,
        protocol: "PROTOCOL_TCP",
      }],
    }]);
    const yaml = (await toolHandlers.container_template_export(
      t.resolver,
      { container: "default" },
      await exec(t.project),
    )) as string;
    assert.match(yaml, /^ {2}image: ubuntu$/m);
    assert.doesNotMatch(yaml, /imageTemplate/);
    assert.match(yaml, /protocol: tcp/);
    // The handler resolves the workspace project and exports it first.
    assert.match(
      yaml,
      /^ {2}mounts:\n {4}- kind: project\n {6}project: app\n/m,
    );
    assert.deepEqual(
      exportContainerTemplate(
        {
          containerName: "x",
          imageId: "ubuntu",
          mounts: [],
          publishedPorts: [],
        },
        [],
      ).template.spec.image,
      "ubuntu",
    );
  } finally {
    await cleanup(t);
  }
});

test("container_template_save exports the source container and writes it through the guest", async () => {
  const t = await harness({
    containers: [{ containerName: "default", imageId: "ubuntu" }],
  });
  try {
    const result = (await toolHandlers.container_template_save(
      t.resolver,
      { container: "default", name: "Web Dev" },
      await exec(t.project),
    )) as any;
    assert.equal(result.container, "default");
    assert.equal(result.name, "Web Dev.yml");
    assert.equal(t.saved.length, 1);
    assert.equal(t.saved[0].projectDir, t.project);
    assert.equal(t.saved[0].name, "Web Dev.yml");
    const yaml = Buffer.from(t.saved[0].content).toString("utf8");
    assert.match(yaml, /kind: dsh-podman\/container-template/);
    assert.match(yaml, /^ {2}image: ubuntu$/m);
  } finally {
    await cleanup(t);
  }
});

test("container_template_save takes a container and a name, not a document", async () => {
  const tool = TOOLS.find((entry) => entry.name === "container_template_save");
  assert.deepEqual(tool?.parameters.required, ["container", "name"]);
  assert.deepEqual(
    Object.keys(tool?.parameters.properties ?? {}).sort(),
    ["container", "name"],
  );
  const t = await harness({
    containers: [{ containerName: "default", imageId: "ubuntu" }],
  });
  try {
    await assert.rejects(
      async () =>
        toolHandlers.container_template_save(
          t.resolver,
          { name: "web" },
          await exec(t.project),
        ),
      /the "container" parameter is required/,
    );
    await assert.rejects(
      async () =>
        toolHandlers.container_template_save(
          t.resolver,
          { container: "ghost", name: "web" },
          await exec(t.project),
        ),
      /container "ghost" not found/,
    );
    await assert.rejects(
      async () =>
        toolHandlers.container_template_save(
          t.resolver,
          { container: "default", name: "../escape" },
          await exec(t.project),
        ),
      /plain basename/,
    );
    assert.equal(t.saved.length, 0);
  } finally {
    await cleanup(t);
  }
});

test("template tools summarize their approval reason", () => {
  assert.equal(
    summarizeArgs("container_template_load", {
      template: "web",
      container: "dev",
    }),
    'Apply container template "web" to container "dev".',
  );
  assert.equal(
    summarizeArgs(
      "container_template_load",
      { template: "web", container: "dev" },
      undefined,
      "zh",
    ),
    "将容器模板“web”应用到容器“dev”。",
  );
  assert.equal(
    summarizeArgs("container_template_load", { template: "web" }),
    'Apply container template "web" to the default container.',
  );
  assert.equal(
    summarizeArgs(
      "container_template_load",
      { template: "web" },
      undefined,
      "zh",
    ),
    "将容器模板“web”应用到默认容器。",
  );
  assert.match(
    summarizeArgs("container_template_save", {
      container: "app",
      name: "web.yml",
    }),
    /Save container "app" as template "web.yml" at "\.dsh-podman\/web\.yml"/,
  );
  assert.equal(
    summarizeArgs(
      "container_template_save",
      { container: "app", name: "web.yml" },
      "/projects/app",
    ),
    'Save container "app" as template "web.yml" at "/projects/app/.dsh-podman/web.yml".',
  );
  assert.equal(
    summarizeArgs(
      "container_template_save",
      { container: "app", name: "web" },
      "/projects/app",
      "zh",
    ),
    "将容器 “app” 保存为模板 “web.yml”，路径为 “/projects/app/.dsh-podman/web.yml”。",
  );
});
