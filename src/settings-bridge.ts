// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import {
  CONTAINER_NS,
  type ContainerSettings,
  type ContainerSettingsScope,
  type WorkspaceView,
  settingsSchema,
} from "./settings-schema.js";
import { GIT_COMMIT, VERSION } from "./generated/version.js";
import { renderCacheCleanNotice, resolveReasonLocale } from "./approval-reasons.js";
import { defaultMountMode, mountKindToProto, mountModeToProto } from "./mount-enums.js";
import { unaryGuest } from "./guest-rpc.js";
import { type WorkspaceResolver, workspaceSlug } from "./workspace-binding.js";

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

function mountInputToProto(mount: { kind: string; project: string; destination: string; mode: string; volume: string; secret: string }): Record<string, unknown> {
  const kind = mountKindToProto(mount.kind || undefined);
  const mode = mountModeToProto(mount.mode || defaultMountMode(mount.kind || undefined));
  const result: Record<string, unknown> = { projectName: mount.project ?? "", kind, mode };
  if (kind !== "MOUNT_KIND_PROJECT" && mount.destination) result.destination = mount.destination;
  if (mount.volume) result.volume = mount.volume;
  if (mount.secret) result.secret = mount.secret;
  return result;
}

function orchestratorWorkspaceViews(raw: unknown): WorkspaceView[] {
  return ((raw as any[] | undefined) ?? []).map((workspace: any) => ({
    workspaceSlug: workspace.workspaceSlug ?? "",
    projectName: workspace.projectName ?? workspace.mounts?.[0]?.projectName ?? workspace.workspaceSlug ?? "",
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

// dshWorkspaceCwd returns a registered dsh workspace's host path — the cwd the
// resolver needs to bind a container for a settings-card action.
function dshWorkspaceCwd(registry: any, slug: string): string {
  for (const workspace of registry?.list?.() ?? []) {
    if (workspaceSlug(workspace.id) === slug) {
      return String(workspace.path ?? "");
    }
  }
  throw new Error(`unknown workspace ${JSON.stringify(slug)}`);
}

function mergeWorkspaceViews(
  dhs: WorkspaceView[],
  orchestrator: WorkspaceView[],): WorkspaceView[] {
  const bySlug = new Map(orchestrator.map((workspace) => [workspace.workspaceSlug, workspace]));
  const seen = new Set<string>();
  const merged: WorkspaceView[] = [];
  for (const workspace of dhs) {
    const existing = bySlug.get(workspace.workspaceSlug);
    merged.push(existing ? { ...workspace, ...existing } : workspace);
    seen.add(workspace.workspaceSlug);
  }
  for (const workspace of orchestrator) {
    if (!seen.has(workspace.workspaceSlug)) merged.push(workspace);
  }
  return merged;
}

export function installContainerSettings(
  ctx: any,
  resolver: WorkspaceResolver,
  workspaceRegistry?: any,
): void {
  ctx.inject(["settings"], (sctx: any) => {
    const scope = sctx.settings.register(CONTAINER_NS, settingsSchema, {
      base: {
        version: VERSION,
        commit: GIT_COMMIT,
        defaultImage: resolver.getConfig().defaultImage,
        socketsRoot: resolver.getConfig().socketsRoot,
        projectsRoot: resolver.getConfig().projectsRoot,
      },
    }) as ContainerSettingsScope;

    let refreshing = false;
    const refresh = async (notice = ""): Promise<void> => {
      if (refreshing) return;
      refreshing = true;
      try {
        const [containers, images, workspaces, volumes, secrets, caches] = await Promise.all([
          resolver.control("listContainers", {}),
          resolver.control("listImages", {}),
          resolver.control("listWorkspaces", {}),
          resolver.control("listVolumes", {}),
          resolver.control("listSecrets", {}),
          resolver.control("listCaches", {}),
        ]);
        await scope.update({
          containers: (containers as any).containers ?? [],
          images: (images as any).images ?? [],
          workspaces: mergeWorkspaceViews(
            dshWorkspaceViews(workspaceRegistry, resolver.getConfig().projectsRoot),
            orchestratorWorkspaceViews((workspaces as any).workspaces),
          ),
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
          notice,
        });
      } catch (error) {
        await scope.update({
          notice: error instanceof Error ? error.message : String(error),
        });
      } finally {
        refreshing = false;
      }
    };

    const handle = async (next: ContainerSettings): Promise<void> => {
      resolver.setConfig({
        defaultImage: next.defaultImage,
        socketsRoot: next.socketsRoot,
      });
      const command = next.command;
      if (command === null || command === undefined) return;
      let notice = "";
      try {
        switch (command.op) {
          case "refresh":
            break;
          case "create": {
            const payload: Record<string, unknown> = {
              workspaceSlug: command.workspace,
              imageId: command.image === "" ? undefined : command.image,
            };
            const mounts = command.mounts.map(mountInputToProto);
            if (mounts.length > 0) payload.mounts = mounts;
            if (Object.keys(command.env).length > 0) payload.env = command.env;
            if (Object.keys(command.secretEnvMap).length > 0) payload.secretEnv = command.secretEnvMap;
            if (command.container !== "") {
              await resolver.control("startContainer", { ...payload, container: command.container });
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
            const kind = mountKindToProto(m.kind || undefined);
            const mode = mountModeToProto(m.mode || defaultMountMode(m.kind || undefined));
            const request: Record<string, unknown> = { workspaceSlug: command.workspace, container: command.container || "default", kind };
            if (kind === "MOUNT_KIND_VOLUME") { request.volume = m.volume; request.destination = m.destination; request.mode = mode; }
            else if (kind === "MOUNT_KIND_TMPFS") { request.destination = m.destination; request.mode = mode; }
            else if (kind === "MOUNT_KIND_SECRET") { request.secret = m.secret; request.destination = m.destination; }
            else { request.project = m.project; request.mode = mode; }
            await resolver.control("addContainerMount", request);
            break;
          }
          case "container_mount_remove": {
            const m = command.mount;
            if (m === null) break;
            const kind = mountKindToProto(m.kind || undefined);
            const request: Record<string, unknown> = { workspaceSlug: command.workspace, container: command.container || "default", kind };
            if (kind === "MOUNT_KIND_PROJECT") { request.project = m.project; }
            else if (kind === "MOUNT_KIND_VOLUME") { if (m.volume) request.volume = m.volume; }
            else if (kind === "MOUNT_KIND_SECRET") { if (m.secret) request.secret = m.secret; }
            if (kind !== "MOUNT_KIND_PROJECT" && m.destination) request.destination = m.destination;
            await resolver.control("removeContainerMount", request);
            break;
          }
          case "container_mount_update": {
            const m = command.mount;
            if (m === null) break;
            const kind = mountKindToProto(m.kind || undefined);
            const request: Record<string, unknown> = {
              workspaceSlug: command.workspace,
              container: command.container || "default",
              kind,
              mode: mountModeToProto(m.mode),
            };
            if (kind === "MOUNT_KIND_PROJECT") { request.project = m.project; }
            else if (kind === "MOUNT_KIND_VOLUME") { if (m.volume) request.volume = m.volume; if (m.destination) request.destination = m.destination; }
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
            // The container is not recreated, so push the list to the running
            // guest agent as well; the record above is what a recreate restores.
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
            await resolver.control("removeImage", {
              imageId: command.workspace,
            });
            break;
          case "secret_create":
            await resolver.control("createSecret", {
              name: command.workspace,
              ...(command.length ? { length: command.length } : {}),
              ...(command.charset ? { charset: command.charset } : {}),
            });
            break;
          case "secret_remove":
            await resolver.control("removeSecret", {
              name: command.workspace,
            });
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
              env: command.secretEnv,
              secret: command.secret,
            });
            break;
          case "container_secret_remove":
            await resolver.control("removeContainerSecret", {
              workspaceSlug: command.workspace,
              container: command.container || "default",
              env: command.secretEnv,
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
            await resolver.control("rebuildBaseImage", {
              name: command.workspace,
            });
            break;
          case "image_base_pull":
            await resolver.control("pullBaseImage", {
              name: command.workspace,
            });
            break;
          case "cache_clean": {
            const result = (await resolver.control("cleanCaches", {
              mode: cacheCleanModeToProto(command.cacheMode),
            })) as { removedFiles?: unknown };
            notice = renderCacheCleanNotice(
              resolveReasonLocale(sctx.settings),
              Number(result.removedFiles ?? 0),
            );
            break;
          }
        }
        await scope.update({ command: null });
        await refresh(notice);
      } catch (error) {
        await scope.update({
          notice: error instanceof Error ? error.message : String(error),
          command: null,
        });
      }
    };

    scope.watch((next: ContainerSettings) => {
      void handle(next);
    });
    void refresh();
  });
}

export {
  CONTAINER_NS,
  CommandRequest,
  ContainerSettings,
  ContainerSettingsScope,
  ContainerView,
  ImageView,
  MountInput,
  SecretView,
  VolumeView,
  WorkspaceView,
  settingsSchema,
} from "./settings-schema.js";
