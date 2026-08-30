// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import z from "@deepseek-ai/schemastery";
import { workspaceSlug } from "./workspace-binding.js";
import type { WorkspaceResolver } from "./workspace-binding.js";

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
  ]),
  workspace: z.string().default(""),
  image: z.string().default(""),
  at: z.number().default(0),
  mounts: z
    .array(
      z.object({
        projectName: z.string().default(""),
        mode: z.string().default(""),
      }),
    )
    .default([]),
  value: z.string().default(""),
});

export const settingsSchema = z.object({
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
  images: z
    .array(
      z.object({
        imageId: z.string().default(""),
        baseImage: z.string().default(""),
        imageTag: z.string().default(""),
        builtAt: z.string().default(""),
        packages: z.array(z.string()).default([]),
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

export interface CommandRequest {
  op: "refresh" | "remove" | "recreate" | "create" | "volume_create" | "volume_remove" | "image_remove" | "secret_create" | "secret_remove" | "secret_set";
  workspace: string;
  image: string;
  at: number;
  mounts: readonly { projectName: string; mode: string }[];
  value: string;
}
export interface ContainerView {
  containerName: string;
  workspaceSlug: string;
  imageId: string;
  status: string;
  createdAt: string;
  mounts: readonly { projectName: string; mode: string }[];
}
export interface ImageView {
  imageId: string;
  baseImage: string;
  imageTag: string;
  builtAt: string;
  packages: readonly string[];
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

function orchestratorWorkspaceViews(raw: unknown): WorkspaceView[] {
  return ((raw as any[] | undefined) ?? []).map((workspace: any) => ({
    workspaceSlug: workspace.workspaceSlug ?? "",
    projectName: workspace.mounts?.[0]?.projectName ?? workspace.workspaceSlug ?? "",
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
        projectsRoot: next.projectsRoot,
      });
      const command = next.command;
      if (command === null || command === undefined) return;
      try {
        switch (command.op) {
          case "refresh":
            break;
          case "create":
            await resolver.control("createWorkspace", {
              workspaceSlug: command.workspace,
              imageId: command.image === "" ? undefined : command.image,
              mounts: command.mounts,
            });
            break;
          case "remove":
            await resolver.control("removeContainer", {
              workspaceSlug: command.workspace,
            });
            break;
          case "recreate":
            await resolver.control("recreateContainer", {
              workspaceSlug: command.workspace,
              imageId: command.image === "" ? undefined : command.image,
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
