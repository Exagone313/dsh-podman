// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// The settings card's host half: one authenticated route below the harness API
// path. It serves the live orchestrator snapshot and runs one command per
// request, so neither the snapshot nor the commands touch the persisted
// settings document.

import {
  CARD_PATH,
  type CardCommandResult,
  type CardSnapshot,
  type CommandOp,
  type CommandRequest,
  type ContainerView,
  type ImageView,
  type MountInput,
  type WorkspaceView,
} from "./client/card-protocol.js";
import {
  type ReasonLocale,
  renderCacheCleanNotice,
  renderDefaultEnvSyncNotice,
  resolveReasonLocale,
} from "./approval-reasons.js";
import { mergeDefaultEnv, missingDefaultEnv } from "./container-env.js";
import { defaultMountMode, mountKindToProto, mountModeToProto } from "./mount-enums.js";
import { mountInputToProto, validateMountInput } from "./mount-input.js";
import { unaryGuest } from "./guest-rpc.js";
import { type WorkspaceResolver, workspaceSlug } from "./workspace-binding.js";
import { GIT_COMMIT, VERSION } from "./generated/version.js";
import { versionState as pluginVersionState } from "./version-compat.js";
import { dshVersion } from "./dsh-version.js";

// readOrchestratorVersion asks the orchestrator for its version, or returns ""
// when the call fails (an orchestrator predating the handshake).
async function readOrchestratorVersion(resolver: WorkspaceResolver): Promise<string> {
  try {
    const response: any = await resolver.control("getVersion", {});
    return String(response?.version ?? "");
  } catch {
    return "";
  }
}

// The cache clean modes the settings card can request, mapped to the control
// plane's enum names.
const CACHE_CLEAN_MODES: Record<string, string> = {
  "keep-latest": "CACHE_CLEAN_MODE_KEEP_LATEST",
  all: "CACHE_CLEAN_MODE_ALL",
};

function cacheCleanModeToProto(mode: string): string {
  const proto = Object.prototype.hasOwnProperty.call(CACHE_CLEAN_MODES, mode)
    ? CACHE_CLEAN_MODES[mode]
    : undefined;
  if (proto === undefined) throw new Error(`unknown cache clean mode: ${mode}`);
  return proto;
}

// containerMountView and imageView rebuild the snapshot's nested objects from
// an explicit allow-list, so a field added to the proto later cannot reach the
// browser just because it exists on the wire (see AGENTS.md "Security").
function containerMountView(mount: any): {
  projectName: string;
  destination: string;
  kind: string;
  mode: string;
  volume: string;
  secret: string;
} {
  return {
    projectName: stringField(mount?.projectName),
    destination: stringField(mount?.destination),
    kind: stringField(mount?.kind),
    mode: stringField(mount?.mode),
    volume: stringField(mount?.volume),
    secret: stringField(mount?.secret),
  };
}

function imageView(image: any): ImageView {
  return {
    imageId: stringField(image?.imageId),
    parent: stringField(image?.parent),
    packages: Array.isArray(image?.packages) ? image.packages.map(String) : [],
    imageTag: stringField(image?.imageTag),
    builtAt: stringField(image?.builtAt),
    isBase: Boolean(image?.isBase),
    status: stringField(image?.status),
    primitive: stringField(image?.primitive),
    packageManager: stringField(image?.packageManager),
    basePublic: Boolean(image?.basePublic),
  };
}

function orchestratorWorkspaceViews(raw: unknown): WorkspaceView[] {
  return ((raw as any[] | undefined) ?? []).map((workspace: any) => ({
    workspaceSlug: workspace.workspaceSlug ?? "",
    projectName: workspace.projectName ??
      workspace.mounts?.[0]?.projectName ??
      workspace.workspaceSlug ??
      "",
    containerName: workspace.containerName ?? "",
    imageId: workspace.imageId ?? "",
    status: workspace.status ?? "",
    createdAt: workspace.createdAt ?? "",
    mounts: ((workspace.mounts ?? []) as any[]).map((mount: any) => ({
      projectName: mount.projectName ?? "",
      mode: mount.mode ?? "",
    })),
  }));
}

function dshWorkspaceViews(registry: any, projectsRoot: string): WorkspaceView[] {
  const list = registry?.list?.() ?? [];
  return list.map((workspace: any) => {
    const path = String(workspace.path ?? "");
    const projectName = path.startsWith(`${projectsRoot}/`)
      ? path.slice(projectsRoot.length + 1)
      : path;
    return {
      workspaceSlug: workspaceSlug(workspace.id),
      projectName: projectName || String(workspace.title ?? "") || String(workspace.id ?? ""),
      containerName: "",
      imageId: "",
      status: "",
      createdAt: workspace.createdAt ?? "",
      mounts: projectName !== "" ? [{ projectName, mode: "MOUNT_MODE_READ_WRITE" }] : [],
    };
  });
}

function mergeWorkspaceViews(
  dsh: WorkspaceView[],
  orchestrator: WorkspaceView[],
): WorkspaceView[] {
  const bySlug = new Map(orchestrator.map((workspace) => [workspace.workspaceSlug, workspace]));
  const seen = new Set<string>();
  const merged: WorkspaceView[] = [];
  for (const workspace of dsh) {
    const existing = bySlug.get(workspace.workspaceSlug);
    merged.push(existing ? { ...workspace, ...existing } : workspace);
    seen.add(workspace.workspaceSlug);
  }
  for (const workspace of orchestrator) {
    if (!seen.has(workspace.workspaceSlug)) merged.push(workspace);
  }
  return merged;
}

// dshWorkspaceCwd returns a registered dsh workspace's host path — the cwd the
// resolver needs to bind a container for a card action.
function dshWorkspaceCwd(registry: any, slug: string): string {
  for (const workspace of registry?.list?.() ?? []) {
    if (workspaceSlug(workspace.id) === slug) {
      return String(workspace.path ?? "");
    }
  }
  throw new Error(`unknown workspace ${JSON.stringify(slug)}`);
}

/** Build the live snapshot the card renders. */
export async function cardSnapshot(
  resolver: WorkspaceResolver,
  workspaceRegistry: any,
): Promise<CardSnapshot> {
  // The handshake RPC is exempt from the orchestrator's version check, so it
  // succeeds even when the rest is refused; an older orchestrator that has no
  // GetVersion yet leaves the version unknown.
  const orchestratorVersion = await readOrchestratorVersion(resolver);
  let listings: readonly unknown[];
  try {
    listings = await Promise.all([
      resolver.control("listContainers", {}),
      resolver.control("listImages", {}),
      resolver.control("listWorkspaces", {}),
      resolver.control("listVolumes", {}),
      resolver.control("listSecrets", {}),
      resolver.control("listCaches", {}),
    ]);
  } catch (error: unknown) {
    // An incompatible plugin is refused before any handler runs, so the card
    // reports the mismatch instead of an unexplained empty snapshot.
    if ((error as { code?: unknown })?.code !== "FailedPrecondition") throw error;
    return {
      version: VERSION,
      commit: GIT_COMMIT,
      dshVersion: dshVersion(),
      orchestratorVersion,
      versionState: "major-mismatch",
      projectsRoot: resolver.getConfig().projectsRoot,
      workspaces: [],
      containers: [],
      images: [],
      volumes: [],
      secrets: [],
      caches: [],
    };
  }
  const [containers, images, workspaces, volumes, secrets, caches] = listings;
  return {
    version: VERSION,
    commit: GIT_COMMIT,
    dshVersion: dshVersion(),
    orchestratorVersion,
    versionState: pluginVersionState(VERSION, orchestratorVersion),
    projectsRoot: resolver.getConfig().projectsRoot,
    workspaces: mergeWorkspaceViews(
      dshWorkspaceViews(workspaceRegistry, resolver.getConfig().projectsRoot),
      orchestratorWorkspaceViews((workspaces as any).workspaces),
    ),
    containers: (((containers as any).containers ?? []) as ContainerView[]).map(
      (container) => ({
        containerName: container.containerName ?? "",
        workspaceSlug: container.workspaceSlug ?? "",
        imageId: container.imageId ?? "",
        status: container.status ?? "",
        createdAt: container.createdAt ?? "",
        mounts: (container.mounts ?? []).map(containerMountView),
        paths: container.paths ?? [],
        env: container.env ?? {},
        secretEnv: container.secretEnv ?? {},
      }),
    ),
    images: (((images as any).images ?? []) as any[]).map(imageView),
    volumes: ((volumes as any).volumes ?? []).map((volume: any) => ({
      name: volume.name ?? "",
    })),
    secrets: ((secrets as any).secrets ?? []).map((secret: any) => ({
      name: secret.name ?? "",
    })),
    caches: ((caches as any).caches ?? []).map((cache: any) => ({
      manager: cache.manager ?? "",
      path: cache.path ?? "",
      files: Number(cache.files ?? 0),
      // The control plane reports int64 as a string.
      bytes: Number(cache.bytes ?? 0),
    })),
  };
}

/**
 * Run one card command, returning the notice to show (usually empty). `ctx` is
 * the settings-injected context, read only for the session locale.
 */
export async function runCommand(
  _ctx: any,
  resolver: WorkspaceResolver,
  workspaceRegistry: any,
  raw: Record<string, unknown>,
  // The live UI locale, read per notice; absent in tests, which render English.
  readLocale?: () => ReasonLocale,
): Promise<string> {
  const command = normalizeCommand(raw);
  let notice = "";
  switch (command.op) {
    case "create": {
      const payload: Record<string, unknown> = {
        workspaceSlug: command.workspace,
        imageId: command.image === "" ? undefined : command.image,
      };
      const projectsRoot = resolver.getConfig().projectsRoot;
      const mounts = command.mounts.map((mount) => mountInputToProto(mount, projectsRoot));
      if (mounts.length > 0) payload.mounts = mounts;
      // The card's create is a creation path: seed the default environment
      // under whatever the modal collected. A later recreate is authoritative,
      // which is how a seeded value is removed again.
      const env = mergeDefaultEnv(resolver.getConfig().containerEnv, command.env);
      if (Object.keys(env).length > 0) payload.env = env;
      if (Object.keys(command.secretEnv).length > 0) {
        payload.secretEnv = command.secretEnv;
      }
      if (command.paths.length > 0) payload.paths = [...command.paths];
      if (command.container !== "") {
        await resolver.control("startContainer", {
          ...payload,
          container: command.container,
        });
      } else {
        await resolver.control("createWorkspace", {
          ...payload,
          projectName: command.projectName,
        });
      }
      break;
    }
    case "container_mount_add": {
      const m = command.mount;
      if (m === null) break;
      validateMountInput(m, resolver.getConfig().projectsRoot);
      const kind = mountKindToProto(m.kind || undefined);
      const mode = mountModeToProto(m.mode || defaultMountMode(m.kind || undefined));
      const request: Record<string, unknown> = {
        workspaceSlug: command.workspace,
        container: command.container || "default",
        kind,
      };
      if (kind === "MOUNT_KIND_VOLUME") {
        request.volume = m.volume;
        request.destination = m.destination;
        request.mode = mode;
      } else if (kind === "MOUNT_KIND_TMPFS") {
        request.destination = m.destination;
        request.mode = mode;
      } else if (kind === "MOUNT_KIND_SECRET") {
        request.secret = m.secret;
        request.destination = m.destination;
      } else {
        request.project = m.project;
        request.mode = mode;
      }
      await resolver.control("addContainerMount", request);
      break;
    }
    case "container_mount_remove": {
      const m = command.mount;
      if (m === null) break;
      const kind = mountKindToProto(m.kind || undefined);
      const request: Record<string, unknown> = {
        workspaceSlug: command.workspace,
        container: command.container || "default",
        kind,
      };
      if (kind === "MOUNT_KIND_PROJECT") {
        request.project = m.project;
      } else if (kind === "MOUNT_KIND_VOLUME") {
        if (m.volume) request.volume = m.volume;
      } else if (kind === "MOUNT_KIND_SECRET") {
        if (m.secret) request.secret = m.secret;
      }
      if (kind !== "MOUNT_KIND_PROJECT" && m.destination) {
        request.destination = m.destination;
      }
      await resolver.control("removeContainerMount", request);
      break;
    }
    case "container_mount_update": {
      const m = command.mount;
      if (m === null) break;
      // An update sets a mode, so a secret mount must not be made read-write
      // here either.
      validateMountInput(m, resolver.getConfig().projectsRoot);
      const kind = mountKindToProto(m.kind || undefined);
      const request: Record<string, unknown> = {
        workspaceSlug: command.workspace,
        container: command.container || "default",
        kind,
        mode: mountModeToProto(m.mode),
      };
      if (kind === "MOUNT_KIND_PROJECT") {
        request.project = m.project;
      } else if (kind === "MOUNT_KIND_VOLUME") {
        if (m.volume) request.volume = m.volume;
        if (m.destination) request.destination = m.destination;
      }
      await resolver.control("updateContainerMount", request);
      break;
    }
    case "container_path_set": {
      const paths = [...command.paths];
      await resolver.control("setContainerPaths", {
        workspaceSlug: command.workspace,
        container: command.container || "default",
        paths,
      });
      // The container is not recreated, so push the list to the running guest
      // agent as well; the record above is what a recreate restores.
      const cwd = dshWorkspaceCwd(workspaceRegistry, command.workspace);
      const container = command.container || "default";
      const binding = container === "default"
        ? await resolver.resolve(cwd)
        : await resolver.containerBinding(cwd, container);
      await unaryGuest({ binding }, "setPaths", { paths });
      break;
    }
    case "remove":
      await resolver.control("removeContainer", {
        workspaceSlug: command.workspace,
      });
      break;
    case "workspace_remove":
      await resolver.control("removeWorkspace", {
        workspaceSlug: command.workspace,
      });
      break;
    case "recreate":
      await resolver.control("recreateContainer", {
        workspaceSlug: command.workspace,
        imageId: command.image === "" ? undefined : command.image,
        ...(Object.keys(command.env).length > 0 ? { env: command.env } : {}),
      });
      break;
    case "volume_create":
      await resolver.control("createVolume", { name: command.workspace });
      break;
    case "volume_remove":
      await resolver.control("removeVolume", { name: command.workspace });
      break;
    case "image_remove":
      await resolver.control("removeImage", { imageId: command.workspace });
      break;
    case "secret_create":
      await resolver.control("createSecret", {
        name: command.workspace,
        ...(command.length ? { length: command.length } : {}),
        ...(command.charset ? { charset: command.charset } : {}),
      });
      break;
    case "secret_remove":
      await resolver.control("removeSecret", { name: command.workspace });
      break;
    case "secret_set":
      await resolver.control("writeSecretValue", {
        name: command.workspace,
        value: command.value,
      });
      break;
    case "image_rebuild":
      await resolver.control("rebuildImage", { imageId: command.workspace });
      break;
    case "image_rebuild_all":
      await resolver.control("rebuildAllImages", {});
      break;
    case "container_secret_add":
      await resolver.control("addContainerSecret", {
        workspaceSlug: command.workspace,
        container: command.container || "default",
        env: command.secretEnvName,
        secret: command.secret,
      });
      break;
    case "container_secret_remove":
      await resolver.control("removeContainerSecret", {
        workspaceSlug: command.workspace,
        container: command.container || "default",
        env: command.secretEnvName,
      });
      break;
    case "image_build":
      await resolver.control("buildImage", {
        imageId: command.workspace,
        parent: command.image,
        packages: command.packages,
      });
      break;
    case "image_base_rebuild":
      await resolver.control("rebuildBaseImage", { name: command.workspace });
      break;
    case "image_base_pull":
      await resolver.control("pullBaseImage", { name: command.workspace });
      break;
    case "default_env_sync": {
      // Add the default environment to containers that already exist. Only the
      // keys a container is missing are added, so an explicit value is never
      // overwritten, and a stopped container is left for its next start (which
      // seeds the defaults). A recreate applies the merged map.
      const defaults = resolver.getConfig().containerEnv ?? {};
      if (Object.keys(defaults).length === 0) break;
      const listings = await resolver.control<{ containers?: any[] }>(
        "listContainers",
        {},
      );
      let applied = 0;
      let skipped = 0;
      for (const row of listings.containers ?? []) {
        if (command.workspace !== "" && row.workspaceSlug !== command.workspace) {
          continue;
        }
        const current = (row.env ?? {}) as Record<string, string>;
        const missing = missingDefaultEnv(defaults, current);
        if (Object.keys(missing).length === 0) continue;
        if (row.status !== "running") {
          skipped++;
          continue;
        }
        await resolver.control("recreateContainer", {
          workspaceSlug: row.workspaceSlug,
          container: row.containerName,
          env: mergeDefaultEnv(defaults, current),
        });
        applied++;
      }
      notice = renderDefaultEnvSyncNotice(
        resolveReasonLocale(readLocale?.()),
        applied,
        skipped,
      );
      break;
    }
    case "cache_clean": {
      const result = (await resolver.control("cleanCaches", {
        mode: cacheCleanModeToProto(command.cacheMode),
      })) as { removedFiles?: unknown };
      notice = renderCacheCleanNotice(
        resolveReasonLocale(readLocale?.()),
        Number(result.removedFiles ?? 0),
      );
      break;
    }
    default:
      throw new Error(
        `unknown command ${JSON.stringify((command as { op?: unknown }).op)}`,
      );
  }
  return notice;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stringField(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function stringMap(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    result[key] = String(item);
  }
  return result;
}

function mountField(value: unknown): MountInput | null {
  if (typeof value !== "object" || value === null) return null;
  const mount = value as Record<string, unknown>;
  return {
    kind: stringField(mount.kind),
    project: stringField(mount.project),
    destination: stringField(mount.destination),
    mode: stringField(mount.mode),
    volume: stringField(mount.volume),
    secret: stringField(mount.secret),
  };
}

// normalizeCommand fills the defaults a caller may omit, so the command runner
// can rely on every field being present. The route is a public endpoint, so it
// must not trust the request body's shape.
function normalizeCommand(raw: Record<string, unknown>): CommandRequest {
  const mounts = Array.isArray(raw.mounts) ? raw.mounts : [];
  return {
    op: raw.op as CommandOp,
    workspace: stringField(raw.workspace),
    projectName: stringField(raw.projectName),
    image: stringField(raw.image),
    mounts: mounts.map(
      (mount) =>
        mountField(mount) ?? {
          kind: "",
          project: "",
          destination: "",
          mode: "",
          volume: "",
          secret: "",
        },
    ),
    paths: Array.isArray(raw.paths) ? raw.paths.map(String) : [],
    value: stringField(raw.value),
    env: stringMap(raw.env),
    container: stringField(raw.container),
    secret: stringField(raw.secret),
    secretEnvName: stringField(raw.secretEnvName),
    length: typeof raw.length === "number" ? raw.length : 0,
    charset: stringField(raw.charset),
    packages: Array.isArray(raw.packages) ? raw.packages.map(String) : [],
    secretEnv: stringMap(raw.secretEnv),
    cacheMode: stringField(raw.cacheMode),
    mount: mountField(raw.mount),
  };
}

async function handleCardRequest(
  request: Request,
  ctx: any,
  resolver: WorkspaceResolver,
  workspaceRegistry: any,
  readLocale?: () => ReasonLocale,
): Promise<Response> {
  if (request.method === "GET") {
    try {
      return jsonResponse(200, await cardSnapshot(resolver, workspaceRegistry));
    } catch (error) {
      return jsonResponse(500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (request.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }
  let command: unknown;
  try {
    const body = (await request.json()) as { command?: unknown };
    command = body?.command;
  } catch {
    return jsonResponse(400, { error: "invalid JSON body" });
  }
  if (command === null || typeof command !== "object") {
    return jsonResponse(400, { error: "a command is required" });
  }
  try {
    const notice = await runCommand(
      ctx,
      resolver,
      workspaceRegistry,
      command as Record<string, unknown>,
      readLocale,
    );
    const result: CardCommandResult = notice === "" ? {} : { notice };
    return jsonResponse(200, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.startsWith("unknown command") ? 400 : 500;
    return jsonResponse(status, { error: message });
  }
}

/**
 * Register the card's authenticated fetch route. It is served below the
 * harness API path, so the carrier applies its Host/Origin fence and browser
 * authentication before the handler runs.
 */
export function registerCardRoute(
  ctx: any,
  resolver: WorkspaceResolver,
  workspaceRegistry?: any,
  readLocale?: () => ReasonLocale,
): void {
  ctx.inject(["connection"], (connectionCtx: any) => {
    connectionCtx.connection.fetch.register({
      path: CARD_PATH,
      methods: ["GET", "POST"],
      requestBody: "buffered",
      fetch: (request: Request) =>
        handleCardRequest(request, connectionCtx, resolver, workspaceRegistry, readLocale),
    });
  });
}
