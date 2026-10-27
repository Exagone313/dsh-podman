// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// The load-template popup's host half: one authenticated route below the
// harness API path that lists a project's templates, inspects one (including an
// upload), builds the image it needs, creates a container from it, and
// publishes the ports of a template whose replace the edit editor applied.
//
// Listing and reading happen on the dsh host, from the read-only view of the
// projects root the same way dsh's own directory picker reads a workspace
// directory; saving a template goes through the workspace's guest agent
// instead, because the host view is read-only.

import {
  type ContainerTemplate,
  effectiveImage,
  parseContainerTemplate,
  renderContainerTemplate,
  templateImageId,
  templateImagePlan,
  templateRequirements,
  type TemplateWarning,
} from "./container-template.js";
import type {
  ContainerView,
  PublishedPortView,
} from "./client/card-protocol.js";
import {
  type TemplateApplyView,
  type TemplateBuildView,
  type TemplateEntryView,
  type TemplateInspectionView,
  type TemplatePublishView,
  TEMPLATES_PATH,
  type TemplatesListing,
} from "./client/template-protocol.js";
import { containerMountView } from "./card-route.js";
import { ensureTemplateImage } from "./template-image.js";
import {
  applyContainerTemplate,
  publishTemplatePorts,
} from "./template-apply.js";
import {
  listProjectTemplates,
  MAX_TEMPLATE_BYTES,
  projectDirectoryExists,
  type ProjectTemplateFile,
  readProjectTemplate,
  type RegisteredWorkspace,
  TemplateFileError,
  templateFileName,
  templatePathForName,
  workspaceForSlug,
} from "./template-files.js";
import { TemplateError } from "./container-template.js";
import { portProtocolFromProto } from "./publish-port.js";
import type { WorkspaceResolver } from "./workspace-binding.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stringField(value: unknown): string {
  return typeof value === "string" ? value : "";
}

interface ImageRow {
  imageId: string;
  parent: string;
  packages: readonly string[];
  status?: string;
  builtAt?: string;
}

async function listImages(resolver: WorkspaceResolver): Promise<ImageRow[]> {
  const result = (await resolver.control("listImages", {})) as {
    images?: ImageRow[];
  };
  return result.images ?? [];
}

async function listSecrets(resolver: WorkspaceResolver): Promise<string[]> {
  const result = (await resolver.control("listSecrets", {})) as {
    secrets?: { name?: string }[];
  };
  return (result.secrets ?? []).map((secret) => secret.name ?? "");
}

async function listVolumes(resolver: WorkspaceResolver): Promise<string[]> {
  const result = (await resolver.control("listVolumes", {})) as {
    volumes?: { name?: string }[];
  };
  return (result.volumes ?? []).map((volume) => volume.name ?? "");
}

// resolveTemplate turns a request into the template document to inspect: an
// uploaded YAML string, or the project's own file. The path is the absolute
// host path the template has (or would have once saved), which is what its
// image id hashes.
async function resolveTemplate(
  workspace: RegisteredWorkspace,
  request: { name: string; yaml?: unknown },
): Promise<ProjectTemplateFile> {
  if (typeof request.yaml === "string") {
    const name = templateFileName(request.name);
    return {
      name,
      path: templatePathForName(workspace.projectPath, name),
      yaml: request.yaml,
    };
  }
  return await readProjectTemplate(workspace.projectPath, request.name);
}

// loadTemplate reads and parses the requested document, enforcing the size
// limit every operation shares.
async function loadTemplate(
  workspace: RegisteredWorkspace,
  request: { name: string; yaml?: unknown },
): Promise<{ file: ProjectTemplateFile; template: ContainerTemplate }> {
  const file = await resolveTemplate(workspace, request);
  if (Buffer.byteLength(file.yaml, "utf8") > MAX_TEMPLATE_BYTES) {
    throw new TemplateError("the template is too large");
  }
  return { file, template: parseContainerTemplate(file.yaml) };
}

// inspectTemplate parses one template and computes everything the popup shows:
// its effective image, whether a build is needed, and the workspace
// requirements (missing project directories, volumes and secrets). The image
// and volume lists are read here, on every call: a plan is never computed from
// a list the caller kept from an earlier snapshot, so an image or volume the
// maintainer removed is missing from this plan immediately.
async function inspectTemplate(
  resolver: WorkspaceResolver,
  workspace: RegisteredWorkspace,
  request: { name: string; yaml?: unknown },
): Promise<{
  inspection: TemplateInspectionView;
  template: ContainerTemplate;
  file: ProjectTemplateFile;
}> {
  const { file, template } = await loadTemplate(workspace, request);
  const imageId = await templateImageId(file.name, file.path);
  const effective = effectiveImage(template);
  const [listed, volumes] = await Promise.all([
    listImages(resolver),
    listVolumes(resolver),
  ]);
  const plan = templateImagePlan(effective, imageId, listed);
  const warnings = await requirements(resolver, workspace, template, volumes);
  const inspection: TemplateInspectionView = {
    name: file.name,
    path: file.path,
    yaml: renderContainerTemplate(template),
    template,
    imageId: plan.imageId,
    image: plan,
    warnings,
  };
  return { inspection, template, file };
}

async function requirements(
  resolver: WorkspaceResolver,
  workspace: RegisteredWorkspace,
  template: ContainerTemplate,
  volumes: readonly string[],
): Promise<TemplateWarning[]> {
  const projectsRoot = resolver.getConfig().projectsRoot;
  const projects = new Map<string, boolean>();
  for (const mount of template.spec.mounts) {
    if (mount.kind !== "project" || projects.has(mount.project)) continue;
    projects.set(
      mount.project,
      await projectDirectoryExists(projectsRoot, mount.project),
    );
  }
  const secrets = await listSecrets(resolver);
  return templateRequirements(template, {
    projectExists: (project) => projects.get(project) === true,
    secrets,
    volumes,
  });
}

// containerView is the snapshot shape for one container; it mirrors the card's
// own projection so the popup's reload and the card agree.
function containerView(row: any, projectsRoot: string): ContainerView {
  const published = (row?.publishedPorts ?? []) as any[];
  return {
    containerName: stringField(row?.containerName),
    workspaceSlug: stringField(row?.workspaceSlug),
    imageId: stringField(row?.imageId),
    status: stringField(row?.status),
    createdAt: stringField(row?.createdAt),
    mounts: ((row?.mounts ?? []) as any[]).map((mount: any) =>
      containerMountView(mount, projectsRoot)
    ),
    paths: Array.isArray(row?.paths) ? row.paths.map(String) : [],
    env: (row?.env ?? {}) as Record<string, string>,
    secretEnv: (row?.secretEnv ?? {}) as Record<string, string>,
    publishedPorts: published.map((port: any): PublishedPortView => ({
      protocol: portProtocolFromProto(stringField(port?.protocol)) ??
        stringField(port?.protocol),
      port: Number(port?.port ?? 0),
      address: stringField(port?.address),
      hostPort: Number(port?.hostPort ?? 0),
      endpoint: stringField(port?.endpoint),
    })),
  };
}

export async function runTemplateRequest(
  resolver: WorkspaceResolver,
  workspaceRegistry: any,
  raw: Record<string, unknown>,
): Promise<
  | TemplateInspectionView
  | TemplateBuildView
  | TemplateApplyView
  | TemplatePublishView
> {
  const op = stringField(raw.op);
  const workspace = workspaceForSlug(
    workspaceRegistry,
    resolver.getConfig().projectsRoot,
    stringField(raw.workspace),
  );
  if (op === "inspect") {
    const { inspection } = await inspectTemplate(resolver, workspace, {
      name: stringField(raw.name),
      ...(typeof raw.yaml === "string" ? { yaml: raw.yaml } : {}),
    });
    return inspection;
  }
  if (op === "build") {
    const { inspection, template, file } = await inspectTemplate(
      resolver,
      workspace,
      {
        name: stringField(raw.name),
        ...(typeof raw.yaml === "string" ? { yaml: raw.yaml } : {}),
      },
    );
    // No pre-fetched list: the build decides from the images present when it
    // runs, then the plan is re-read once the build finished so a failed or
    // removed image is reported as missing rather than ready. `force` is the
    // Rebuild action: it rebuilds a current image instead of reusing it.
    const ensured = await ensureTemplateImage(resolver, {
      name: file.name,
      path: file.path,
      template,
      force: raw.force === true,
    });
    const refreshed = await listImages(resolver);
    const plan = templateImagePlan(
      effectiveImage(template),
      ensured.imageId,
      refreshed,
    );
    return {
      ...inspection,
      imageId: ensured.imageId,
      image: plan,
      built: ensured.built,
      removed: ensured.removed,
    };
  }
  if (op === "apply") {
    const { inspection, template, file } = await inspectTemplate(
      resolver,
      workspace,
      {
        name: stringField(raw.name),
        ...(typeof raw.yaml === "string" ? { yaml: raw.yaml } : {}),
      },
    );
    const ensured = await ensureTemplateImage(resolver, {
      name: file.name,
      path: file.path,
      template,
    });
    const container = stringField(raw.container);
    const result = await applyContainerTemplate(resolver, {
      workspaceSlug: workspace.workspaceSlug,
      projectName: workspace.projectName,
      template,
      imageId: ensured.imageId,
      ...(container === "" ? {} : { container }),
    });
    return {
      container: containerView(
        result.row,
        resolver.getConfig().projectsRoot,
      ),
      imageId: ensured.imageId,
      warnings: [
        ...inspection.warnings.map(warningText).filter((text) => text !== ""),
        ...result.warnings,
      ],
    };
  }
  if (op === "publish") {
    // A template-sourced replace publishes its ports after the edit editor's
    // Apply updated the container; nothing else happens here.
    const container = stringField(raw.container);
    if (container === "") {
      throw new TemplateFileError(
        "a container is required to publish a template's ports",
      );
    }
    const { template } = await loadTemplate(workspace, {
      name: stringField(raw.name),
      ...(typeof raw.yaml === "string" ? { yaml: raw.yaml } : {}),
    });
    return {
      warnings: await publishTemplatePorts(resolver, {
        workspaceSlug: workspace.workspaceSlug,
        container,
        template,
      }),
    };
  }
  throw new TemplateFileError(
    `unknown template operation ${JSON.stringify(op)}`,
  );
}

function warningText(warning: TemplateWarning): string {
  switch (warning.kind) {
    case "project_missing":
      return `project mount ${
        JSON.stringify(warning.project)
      }: directory not found`;
    case "secret_missing":
      return `secret ${JSON.stringify(warning.secret)}: not found`;
    case "secret_env_missing":
      return `secret ${
        JSON.stringify(warning.secret)
      } for ${warning.env}: not found`;
    case "volume_missing":
      return `volume ${JSON.stringify(warning.volume)}: not found`;
  }
}

export async function handleTemplateRequest(
  request: Request,
  resolver: WorkspaceResolver,
  workspaceRegistry: any,
): Promise<Response> {
  try {
    if (request.method === "GET") {
      const url = new URL(request.url);
      const workspace = workspaceForSlug(
        workspaceRegistry,
        resolver.getConfig().projectsRoot,
        url.searchParams.get("workspace") ?? "",
      );
      const templates: TemplateEntryView[] = (
        await listProjectTemplates(workspace.projectPath)
      ).map((template) => ({
        name: template.name,
        path: template.path,
        yaml: template.yaml,
      }));
      const listing: TemplatesListing = { templates };
      return jsonResponse(200, listing);
    }
    if (request.method !== "POST") {
      return new Response("method not allowed", { status: 405 });
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return jsonResponse(400, { error: "invalid JSON body" });
    }
    if (body === null || typeof body !== "object") {
      return jsonResponse(400, { error: "a template request is required" });
    }
    const result = await runTemplateRequest(
      resolver,
      workspaceRegistry,
      body as Record<string, unknown>,
    );
    return jsonResponse(200, result);
  } catch (error) {
    if (error instanceof TemplateError || error instanceof TemplateFileError) {
      return jsonResponse(400, { error: error.message });
    }
    return jsonResponse(500, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Register the template route. It is served below the harness API path, so the
 * carrier applies its Host/Origin fence and browser authentication first.
 */
export function registerTemplateRoute(
  ctx: any,
  resolver: WorkspaceResolver,
  workspaceRegistry: any,
): void {
  ctx.inject(["connection"], (connectionCtx: any) => {
    connectionCtx.connection.fetch.register({
      path: TEMPLATES_PATH,
      methods: ["GET", "POST"],
      requestBody: "buffered",
      fetch: (request: Request) =>
        handleTemplateRequest(request, resolver, workspaceRegistry),
    });
  });
}
