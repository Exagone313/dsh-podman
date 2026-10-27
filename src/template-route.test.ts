// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grpc } from "./grpc/runtime-client.js";
import { handleTemplateRequest, runTemplateRequest } from "./template-route.js";
import {
  parseContainerTemplate,
  templateImageId,
} from "./container-template.js";

const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

interface Harness {
  root: string;
  project: string;
  registry: any;
  resolver: any;
  calls: Array<[string, any]>;
  images: any[];
  // The volume list the control plane reports to the inspection.
  volumes: string[];
  // Every template document saved through a guest agent; a replace must never
  // reach for one.
  writes: any[];
  setImages(images: any[]): void;
  setVolumes(volumes: string[]): void;
}

async function harness(options: {
  workspaceExists?: boolean;
  containers?: { name: string }[];
  secrets?: string[];
  volumes?: string[];
  publishFails?: boolean;
} = {}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "dsh-template-"));
  const project = join(root, "app");
  await mkdir(join(project, ".dsh-podman"), { recursive: true });
  const calls: Array<[string, any]> = [];
  const images: any[] = [];
  const volumes: string[] = [...(options.volumes ?? [])];
  const writes: any[] = [];
  const resolver: any = {
    getConfig: () => ({ projectsRoot: root }),
    async resolve() {
      return {
        token: "t",
        guest: {
          writeTemplate: (request: any, _metadata: any, callback: any) => {
            writes.push(request);
            callback(null, { path: join(project, request.name) });
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
          return {
            secrets: (options.secrets ?? []).map((name) => ({ name })),
          };
        case "listVolumes":
          return { volumes: volumes.map((name) => ({ name })) };
        case "listContainers":
          return {
            containers: (options.containers ?? [{ name: "default" }]).map(
              (container) => ({
                containerName: container.name,
                workspaceSlug: WORKSPACE_ID,
              }),
            ),
          };
        case "describeWorkspace":
          if (options.workspaceExists === false) {
            throw Object.assign(new Error("workspace not found"), {
              code: grpc.status.NOT_FOUND,
            });
          }
          return {
            workspaceSlug: request.workspaceSlug,
            containers: options.containers ?? [{ name: "default" }],
          };
        case "buildImage": {
          images.push({
            imageId: request.imageId,
            parent: request.parent,
            packages: request.packages,
            status: "built",
          });
          return {};
        }
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
          };
        default:
          return {};
      }
    },
  };
  return {
    root,
    project,
    registry: {
      list: () => [{ id: WORKSPACE_ID, path: project }],
    },
    resolver,
    calls,
    images,
    volumes,
    writes,
    setImages(next: any[]) {
      images.splice(0, images.length, ...next);
    },
    setVolumes(next: string[]) {
      volumes.splice(0, volumes.length, ...next);
    },
  };
}

async function cleanup(t: Harness): Promise<void> {
  await rm(t.root, { recursive: true, force: true });
}

const VALID = `version: 1
kind: dsh-podman/container-template
spec:
  image: ubuntu
  env: {NODE_ENV: development}
  secretEnv: {GITHUB_TOKEN: github-token}
  mounts:
    - {kind: project, project: app}
    - {kind: project, project: missing}
    - {kind: volume, volume: cache, destination: /cache, mode: read_write}
  paths: [/usr/local/bin]
  ports:
    - {container: 8080, host: 8080, protocol: tcp}
`;

test("the route lists only the project's YAML templates", async () => {
  const t = await harness();
  try {
    await writeFile(join(t.project, ".dsh-podman", "web.yml"), VALID);
    await writeFile(join(t.project, ".dsh-podman", "other.yaml"), VALID);
    await writeFile(join(t.project, ".dsh-podman", "notes.txt"), "ignored");
    await writeFile(join(t.project, ".dsh-podman", ".hidden.yml"), VALID);
    const response = await handleTemplateRequest(
      new Request(
        `http://host/api/podman/templates?workspace=${WORKSPACE_ID}`,
      ),
      t.resolver,
      t.registry,
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { templates: any[] };
    assert.deepEqual(
      body.templates.map((template) => template.name),
      ["other.yaml", "web.yml"],
    );
    assert.equal(
      body.templates[0].path,
      join(t.project, ".dsh-podman", "other.yaml"),
    );
  } finally {
    await cleanup(t);
  }
});

test("a missing template directory lists nothing", async () => {
  const t = await harness();
  try {
    await rm(join(t.project, ".dsh-podman"), { recursive: true, force: true });
    const listing = (await runTemplateRequest(t.resolver, t.registry, {
      op: "inspect",
      workspace: WORKSPACE_ID,
      name: "absent",
    }).catch((error: Error) => error)) as Error;
    assert.match(listing.message, /not found/);
    const response = await handleTemplateRequest(
      new Request(
        `http://host/api/podman/templates?workspace=${WORKSPACE_ID}`,
      ),
      t.resolver,
      t.registry,
    );
    assert.deepEqual(await response.json(), { templates: [] });
  } finally {
    await cleanup(t);
  }
});

test("inspect reports the image plan and the workspace requirements", async () => {
  const t = await harness({ secrets: ["github-token"] });
  try {
    await writeFile(join(t.project, ".dsh-podman", "web.yml"), VALID);
    // The listImages the orchestrator reports includes every base; the plan
    // reads its state from that record.
    t.setImages([{
      imageId: "ubuntu",
      parent: "",
      packages: [],
      status: "built",
      builtAt: "2026-10-20T14:16:39Z",
      basePublic: false,
    }]);
    const inspection = (await runTemplateRequest(t.resolver, t.registry, {
      op: "inspect",
      workspace: WORKSPACE_ID,
      name: "web",
    })) as any;
    assert.equal(inspection.name, "web.yml");
    assert.equal(inspection.imageId, "ubuntu");
    assert.equal(inspection.image.needsBuild, false);
    assert.deepEqual(inspection.warnings, [{
      kind: "project_missing",
      project: "missing",
      path: "missing",
    }, {
      kind: "volume_missing",
      volume: "cache",
    }]);
    // The canonical rendering is what an upload previews.
    assert.match(
      inspection.yaml,
      /^ {2}secretEnv:\n {4}GITHUB_TOKEN: github-token$/m,
    );
    assert.deepEqual(
      parseContainerTemplate(inspection.yaml),
      inspection.template,
    );
  } finally {
    await cleanup(t);
  }
});

// A template that mounts volumes names each absent one as a warning; the host
// reads the volume list when it inspects, so the answer is never derived from
// a list the caller kept.
const VOLUME_TEMPLATE = `version: 1
kind: dsh-podman/container-template
spec:
  image: ubuntu
  mounts:
    - {kind: volume, volume: cache, destination: /cache, mode: read_write}
    - {kind: volume, volume: logs, destination: /logs}
    - {kind: volume, volume: cache, destination: /cache-again}
`;

test("inspect warns once per missing volume, never for a present one", async () => {
  const t = await harness({ volumes: ["logs"] });
  try {
    const inspection = (await runTemplateRequest(t.resolver, t.registry, {
      op: "inspect",
      workspace: WORKSPACE_ID,
      name: "volumes",
      yaml: VOLUME_TEMPLATE,
    })) as any;
    assert.deepEqual(
      inspection.warnings.filter((warning: any) =>
        warning.kind === "volume_missing"
      ),
      [{ kind: "volume_missing", volume: "cache" }],
    );
    // The route passes the volume list it read; the popup never guesses it.
    assert.ok(
      t.calls.some(([method]) => method === "listVolumes"),
      "the inspection must list the volumes when it runs",
    );
  } finally {
    await cleanup(t);
  }
});

test("inspect reads the volume list on every call", async () => {
  const t = await harness({ volumes: ["cache", "logs"] });
  try {
    const before = (await runTemplateRequest(t.resolver, t.registry, {
      op: "inspect",
      workspace: WORKSPACE_ID,
      name: "volumes",
      yaml: VOLUME_TEMPLATE,
    })) as any;
    assert.deepEqual(
      before.warnings.filter((warning: any) =>
        warning.kind === "volume_missing"
      ),
      [],
    );
    t.setVolumes([]);
    t.calls.length = 0;
    const after = (await runTemplateRequest(t.resolver, t.registry, {
      op: "inspect",
      workspace: WORKSPACE_ID,
      name: "volumes",
      yaml: VOLUME_TEMPLATE,
    })) as any;
    assert.deepEqual(
      after.warnings.filter((warning: any) =>
        warning.kind === "volume_missing"
      ),
      [
        { kind: "volume_missing", volume: "cache" },
        { kind: "volume_missing", volume: "logs" },
      ],
    );
    assert.ok(
      t.calls.some(([method]) => method === "listVolumes"),
      "the inspection must list the volumes when it runs",
    );
  } finally {
    await cleanup(t);
  }
});

test("inspect carries the image's build time through the plan", async () => {
  const t = await harness();
  try {
    await writeFile(join(t.project, ".dsh-podman", "web.yml"), VALID);
    const builtAt = "2026-10-20T14:16:39Z";
    // The base image's own record dates the plan, so the details popup renders
    // Built … from the inspection without a second image-list lookup.
    t.setImages([{
      imageId: "ubuntu",
      parent: "",
      packages: [],
      status: "pulled",
      builtAt,
    }]);
    const inspection = (await runTemplateRequest(t.resolver, t.registry, {
      op: "inspect",
      workspace: WORKSPACE_ID,
      name: "web",
    })) as any;
    assert.equal(inspection.image.builtAt, builtAt);
  } finally {
    await cleanup(t);
  }
});

test("inspect reads the image list when it opens, not a stale snapshot", async () => {
  const t = await harness();
  try {
    const path = join(t.project, ".dsh-podman", "web.yml");
    await writeFile(
      path,
      `version: 1
kind: dsh-podman/container-template
spec:
  imageTemplate: {base: alpine, packages: [neovim]}
`,
    );
    const imageId = await templateImageId("web.yml", path);
    // A snapshot captured while the image existed still contains it.
    const staleSnapshot = [{
      imageId,
      parent: "alpine",
      packages: ["neovim"],
      status: "built",
    }];
    t.setImages(staleSnapshot);
    const before = (await runTemplateRequest(t.resolver, t.registry, {
      op: "inspect",
      workspace: WORKSPACE_ID,
      name: "web",
    })) as any;
    assert.equal(before.image.needsBuild, false);
    // The maintainer removed the image since that snapshot was taken. The
    // popup's inspect must read the list now, so the stale snapshot cannot keep
    // the plan ready.
    t.setImages([]);
    t.calls.length = 0;
    const after = (await runTemplateRequest(t.resolver, t.registry, {
      op: "inspect",
      workspace: WORKSPACE_ID,
      name: "web",
    })) as any;
    assert.equal(after.image.needsBuild, true);
    assert.equal(after.image.reason, "missing");
    assert.ok(
      t.calls.some(([method]) => method === "listImages"),
      "the inspection must list the images when it runs",
    );
  } finally {
    await cleanup(t);
  }
});

test("inspect previews an uploaded template at the path it would be saved to", async () => {
  const t = await harness();
  try {
    const inspection = (await runTemplateRequest(t.resolver, t.registry, {
      op: "inspect",
      workspace: WORKSPACE_ID,
      name: "Uploaded Web",
      yaml: `version: 1
kind: dsh-podman/container-template
spec:
  imageTemplate: {base: alpine, packages: [neovim]}
`,
    })) as any;
    assert.equal(inspection.name, "Uploaded Web.yml");
    assert.equal(
      inspection.path,
      join(t.project, ".dsh-podman", "Uploaded Web.yml"),
    );
    const id = await templateImageId(
      "Uploaded Web.yml",
      inspection.path,
    );
    assert.equal(inspection.imageId, id);
    assert.equal(inspection.image.needsBuild, true);
  } finally {
    await cleanup(t);
  }
});

test("a malformed template is refused with its field name", async () => {
  const t = await harness();
  try {
    await writeFile(
      join(t.project, ".dsh-podman", "bad.yml"),
      "version: 1\nkind: dsh-podman/container-template\nspec:\n  image: ubuntu\n  command: [bash]\n",
    );
    await assert.rejects(
      () =>
        runTemplateRequest(t.resolver, t.registry, {
          op: "inspect",
          workspace: WORKSPACE_ID,
          name: "bad",
        }),
      /spec\.command: unknown key/,
    );
  } finally {
    await cleanup(t);
  }
});

test("build builds a template image and reports its plan", async () => {
  const t = await harness();
  try {
    const yaml = `version: 1
kind: dsh-podman/container-template
spec:
  imageTemplate: {base: ubuntu, packages: [neovim]}
`;
    await writeFile(join(t.project, ".dsh-podman", "web.yml"), yaml);
    const built = (await runTemplateRequest(t.resolver, t.registry, {
      op: "build",
      workspace: WORKSPACE_ID,
      name: "web",
    })) as any;
    assert.equal(built.built, true);
    assert.equal(built.image.needsBuild, false);
    const call = t.calls.find(([method]) => method === "buildImage");
    assert.ok(call);
    assert.deepEqual(call[1], {
      imageId: built.imageId,
      parent: "ubuntu",
      packages: ["neovim"],
    });
  } finally {
    await cleanup(t);
  }
});

test("a forced build rebuilds a ready template image, and a plain build reuses it", async () => {
  const t = await harness();
  try {
    const yaml = `version: 1
kind: dsh-podman/container-template
spec:
  imageTemplate: {base: ubuntu, packages: [neovim]}
`;
    await writeFile(join(t.project, ".dsh-podman", "web.yml"), yaml);
    // The plan's image id, then a record that satisfies its recipe.
    const inspected = (await runTemplateRequest(t.resolver, t.registry, {
      op: "inspect",
      workspace: WORKSPACE_ID,
      name: "web",
    })) as any;
    t.setImages([{
      imageId: inspected.imageId,
      parent: "ubuntu",
      packages: ["neovim"],
      status: "built",
    }]);
    // A plain build of a ready image reuses it and builds nothing.
    t.calls.length = 0;
    const reused = (await runTemplateRequest(t.resolver, t.registry, {
      op: "build",
      workspace: WORKSPACE_ID,
      name: "web",
    })) as any;
    assert.equal(reused.built, false);
    assert.equal(
      t.calls.some(([method]) => method === "buildImage"),
      false,
    );
    // The Rebuild action forces the same ready image to be built again.
    t.calls.length = 0;
    const rebuilt = (await runTemplateRequest(t.resolver, t.registry, {
      op: "build",
      workspace: WORKSPACE_ID,
      name: "web",
      force: true,
    })) as any;
    assert.equal(rebuilt.built, true);
    const calls = t.calls.filter(([method]) => method === "buildImage");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0][1], {
      imageId: inspected.imageId,
      parent: "ubuntu",
      packages: ["neovim"],
    });
  } finally {
    await cleanup(t);
  }
});

test("apply create keeps the declared project mount mode and publishes ports", async () => {
  const t = await harness({ workspaceExists: false });
  try {
    await writeFile(join(t.project, ".dsh-podman", "web.yml"), VALID);
    const applied = (await runTemplateRequest(t.resolver, t.registry, {
      op: "apply",
      workspace: WORKSPACE_ID,
      name: "web",
    })) as any;
    const create = t.calls.find(([method]) => method === "createWorkspace");
    assert.ok(create);
    assert.equal(create[1].imageId, "ubuntu");
    assert.equal(create[1].projectName, "app");
    // The template declared the workspace project mount, so applying it keeps
    // the mode the mount defaults to instead of coercing it read-write.
    assert.deepEqual(create[1].mounts[0], {
      projectName: "app",
      kind: "MOUNT_KIND_PROJECT",
      mode: "MOUNT_MODE_READ_ONLY",
    });
    assert.deepEqual(applied.container.mounts[0].projectName, "app");
    const publish = t.calls.find(([method]) => method === "publishPort");
    assert.deepEqual(publish?.[1], {
      workspaceSlug: WORKSPACE_ID,
      container: "default",
      port: 8080,
      protocol: "PROTOCOL_TCP",
      suggestedHostPort: 8080,
    });
    assert.deepEqual(applied.warnings, [
      'project mount "missing": directory not found',
      'secret "github-token" for GITHUB_TOKEN: not found',
      'volume "cache": not found',
    ]);
  } finally {
    await cleanup(t);
  }
});

test("publishing a replace's ports never removes, creates or writes", async () => {
  const t = await harness({
    containers: [{ name: "default" }, { name: "dev" }],
    publishFails: true,
  });
  try {
    await writeFile(join(t.project, ".dsh-podman", "web.yml"), VALID);
    const published = (await runTemplateRequest(t.resolver, t.registry, {
      op: "publish",
      workspace: WORKSPACE_ID,
      name: "web",
      yaml: VALID,
      container: "dev",
    })) as any;
    assert.deepEqual(published.warnings, [
      "port 8080/tcp: gateway is not running",
    ]);
    // The edit editor updated the container; this path only publishes ports.
    assert.deepEqual(t.calls.map(([method]) => method), ["publishPort"]);
    assert.deepEqual(t.writes, []);
  } finally {
    await cleanup(t);
  }
});

test("create replaces a container name that already exists", async () => {
  const t = await harness({
    containers: [{ name: "default" }, { name: "dev" }],
    secrets: ["github-token"],
    volumes: ["cache"],
  });
  try {
    await writeFile(join(t.project, ".dsh-podman", "web.yml"), VALID);
    const applied = (await runTemplateRequest(t.resolver, t.registry, {
      op: "apply",
      workspace: WORKSPACE_ID,
      name: "web",
      container: "dev",
    })) as any;
    // An existing destination is replaced through StartContainer, never
    // refused or removed up front.
    const start = t.calls.find(([method]) => method === "startContainer");
    assert.ok(start);
    assert.equal(start[1].container, "dev");
    assert.equal(start[1].imageId, "ubuntu");
    assert.deepEqual(start[1].mounts[0], {
      projectName: "app",
      kind: "MOUNT_KIND_PROJECT",
      mode: "MOUNT_MODE_READ_ONLY",
    });
    assert.deepEqual({ ...start[1].env }, { NODE_ENV: "development" });
    assert.deepEqual({ ...start[1].secretEnv }, {
      GITHUB_TOKEN: "github-token",
    });
    assert.deepEqual(start[1].paths, ["/usr/local/bin"]);
    assert.equal(applied.container.containerName, "dev");
    assert.equal(applied.container.imageId, "ubuntu");
  } finally {
    await cleanup(t);
  }
});

test("HTTP errors carry the template message", async () => {
  const t = await harness();
  try {
    const response = await handleTemplateRequest(
      new Request("http://host/api/podman/templates", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          op: "inspect",
          workspace: WORKSPACE_ID,
          name: "missing",
        }),
      }),
      t.resolver,
      t.registry,
    );
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error: string };
    assert.match(body.error, /not found/);
  } finally {
    await cleanup(t);
  }
});
