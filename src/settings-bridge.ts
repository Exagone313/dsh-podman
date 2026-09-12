// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import z from "@deepseek-ai/schemastery";
import { VERSION, GIT_COMMIT } from "./generated/version.js";
import { workspaceSlug } from "./workspace-binding.js";
import type { WorkspaceResolver } from "./workspace-binding.js";
import {
  defaultMountMode,
  mountKindToProto,
  mountModeToProto,
} from "./mount-enums.js";

export const CONTAINER_NS = "podman";

const commandSchema = z.object({
  op: z.union([
    z.const("refresh"),
    z.const("remove"),
    z.const("recreate"),
    z.const("create"),
    z.const("volume_create"),
    z.const("volume_remove"),
    z.const("image_remove"),
    z.const("secret_create"),
    z.const("secret_remove"),
    z.const("secret_set"),
    z.const("image_rebuild"),
    z.const("image_rebuild_all"),
    z.const("container_secret_add"),
    z.const("container_secret_remove"),
    z.const("image_build"),
    z.const("image_base_rebuild"),
    z.const("image_base_pull"),
    z.const("container_mount_add"),
    z.const("container_mount_remove"),
  ]),
  workspace: z.string().default(""),
  projectName: z.string().default(""),
  image: z.string().default(""),
  at: z.number().default(0),
  mounts: z.array(z.object({
    kind: z.string().default(""),
    project: z.string().default(""),
    path: z.string().default(""),
    destination: z.string().default(""),
    mode: z.string().default(""),
    volume: z.string().default(""),
    secret: z.string().default(""),
  })).default([]),
  value: z.string().default(""),
  env: z.dict(z.string()).default({}),
  container: z.string().default(""),
  secret: z.string().default(""),
  secretEnv: z.string().default(""),
  length: z.number().default(0),
  charset: z.string().default(""),
  packages: z.array(z.string()).default([]),
  secretEnvMap: z.dict(z.string()).default({}),
  mount: z.union([
    z.object({
      kind: z.string().default(""),
      project: z.string().default(""),
      path: z.string().default(""),
      destination: z.string().default(""),
      mode: z.string().default(""),
      volume: z.string().default(""),
      secret: z.string().default(""),
    }),
    z.const(null),
  ]).default(null),
});

export const settingsSchema = z.object({
  version: z.string().default(""),
  commit: z.string().default(""),
  defaultImage: z.string().default(""),
  socketsRoot: z.string().default(""),
  projectsRoot: z.string().default(""),
  notice: z.string().default(""),
  workspaces: z
    .array(
      z.object({
        workspaceSlug: z.string().default(""),
        projectName: z.string().default(""),
        containerName: z.string().default(""),
        imageId: z.string().default(""),
        status: z.string().default(""),
        createdAt: z.string().default(""),
        mounts: z
          .array(
            z.object({
              projectName: z.string().default(""),
              mode: z.string().default(""),
            }),
          )
          .default([]),
      }),
    )
    .default([]),
  containers: z
    .array(
      z.object({
        containerName: z.string().default(""),
        workspaceSlug: z.string().default(""),
        imageId: z.string().default(""),
        status: z.string().default(""),
        createdAt: z.string().default(""),
        mounts: z.array(z.object({
          projectName: z.string().default(""),
          path: z.string().default(""),
          destination: z.string().default(""),
          kind: z.string().default(""),
          mode: z.string().default(""),
          volume: z.string().default(""),
          secret: z.string().default(""),
        })).default([]),
        env: z.dict(z.string()).default({}),
        secretEnv: z.dict(z.string()).default({}),
      }),
    )
    .default([]),
  images: z
    .array(
      z.object({
        imageId: z.string().default(""),
        parent: z.string().default(""),
        packages: z.array(z.string()).default([]),
        imageTag: z.string().default(""),
        builtAt: z.string().default(""),
        isBase: z.boolean().default(false),
        status: z.string().default(""),
        primitive: z.string().default(""),
        packageManager: z.string().default(""),
        basePublic: z.boolean().default(false),
      }),
    )
    .default([]),
  volumes: z
    .array(
      z.object({
        name: z.string().default(""),
      }),
    )
    .default([]),
  secrets: z
    .array(
      z.object({
        name: z.string().default(""),
      }),
    )
    .default([]),
  command: z.union([commandSchema, z.const(null)]).default(null),
}) as unknown as z<ContainerSettings>;

export interface MountInput {
  kind: string;
  project: string;
  path: string;
  destination: string;
  mode: string;
  volume: string;
  secret: string;
}
export interface CommandRequest {
  op: "refresh" | "remove" | "recreate" | "create" | "volume_create" | "volume_remove" | "image_remove" | "secret_create" | "secret_remove" | "secret_set" | "image_rebuild" | "image_rebuild_all" | "container_secret_add" | "container_secret_remove" | "image_build" | "image_base_rebuild" | "image_base_pull" | "container_mount_add" | "container_mount_remove";
  workspace: string;
  projectName: string;
  image: string;
  at: number;
  mounts: readonly MountInput[];
  value: string;
  env: Record<string, string>;
  container: string;
  secret: string;
  secretEnv: string;
  length: number;
  charset: string;
  packages: string[];
  secretEnvMap: Record<string, string>;
  mount: MountInput | null;
}
export interface ContainerView {
  containerName: string;
  workspaceSlug: string;
  imageId: string;
  status: string;
  createdAt: string;
  mounts: readonly { projectName: string; path: string; destination: string; kind: string; mode: string; volume: string; secret: string }[];
  env: Record<string, string>;
  secretEnv: Record<string, string>;
}
export interface ImageView {
  imageId: string;
  parent: string;
  packages: readonly string[];
  imageTag: string;
  builtAt: string;
  isBase: boolean;
  status: string;
  primitive: string;
  packageManager: string;
  basePublic: boolean;
}
export interface VolumeView {
  name: string;
}
export interface SecretView {
  name: string;
}
export interface WorkspaceView {
  workspaceSlug: string;
  projectName: string;
  containerName: string;
  imageId: string;
  status: string;
  createdAt: string;
  mounts: readonly { projectName: string; mode: string }[];
}
export interface ContainerSettings {
  version: string;
  commit: string;
  defaultImage: string;
  socketsRoot: string;
  projectsRoot: string;
  notice: string;
  workspaces: readonly WorkspaceView[];
  containers: readonly ContainerView[];
  images: readonly ImageView[];
  volumes: readonly VolumeView[];
  secrets: readonly SecretView[];
  command: CommandRequest | null;
}

export interface ContainerSettingsScope {
  get(): ContainerSettings;
  watch(
    callback: (
      next: ContainerSettings,
      prev: ContainerSettings,
    ) => void | Promise<void>,
  ): () => void;
  update(patch: object): Promise<void>;
  replace(section: object): Promise<void>;
}

function mountInputToProto(mount: { kind: string; project: string; path: string; destination: string; mode: string; volume: string; secret: string }): Record<string, unknown> {
  const kind = mountKindToProto(mount.kind || undefined);
  const mode = mountModeToProto(mount.mode || defaultMountMode(mount.kind || undefined));
  const result: Record<string, unknown> = { projectName: mount.project ?? "", kind, mode };
  if (mount.path) result.path = mount.path;
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
      workspaceSlug: workspaceSlug(String(workspace.id ?? "")),
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
  dhs: WorkspaceView[],
  orchestrator: WorkspaceView[],
): WorkspaceView[] {
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
    const refresh = async (): Promise<void> => {
      if (refreshing) return;
      refreshing = true;
      try {
        const [containers, images, workspaces, volumes, secrets] = await Promise.all([
          resolver.control("listContainers", {}),
          resolver.control("listImages", {}),
          resolver.control("listWorkspaces", {}),
          resolver.control("listVolumes", {}),
          resolver.control("listSecrets", {}),
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
          notice: "",
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
            else { request.project = m.project; if (m.path) request.path = m.path; request.mode = mode; }
            await resolver.control("addContainerMount", request);
            break;
          }
          case "container_mount_remove": {
            const m = command.mount;
            if (m === null) break;
            const kind = mountKindToProto(m.kind || undefined);
            const request: Record<string, unknown> = { workspaceSlug: command.workspace, container: command.container || "default", kind };
            if (kind === "MOUNT_KIND_PROJECT") { request.project = m.project; if (m.path) request.path = m.path; }
            else if (kind === "MOUNT_KIND_VOLUME") { if (m.volume) request.volume = m.volume; }
            else if (kind === "MOUNT_KIND_SECRET") { if (m.secret) request.secret = m.secret; }
            if (kind !== "MOUNT_KIND_PROJECT" && m.destination) request.destination = m.destination;
            await resolver.control("removeContainerMount", request);
            break;
          }
          case "remove":
            await resolver.control("removeContainer", {
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
        }
        await scope.update({ command: null });
        await refresh();
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
