// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import z from "@deepseek-ai/schemastery";
import type { WorkspaceResolver } from "./workspace-binding.js";

export const CONTAINER_NS = "podman";

const commandSchema = z.object({
  op: z.union([z.const("refresh"), z.const("remove"), z.const("recreate")]),
  workspace: z.string().default(""),
  image: z.string().default(""),
  at: z.number().default(0),
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
  command: z.union([commandSchema, z.const(null)]).default(null),
}) as unknown as z<ContainerSettings>;

export interface CommandRequest {
  op: "refresh" | "remove" | "recreate";
  workspace: string;
  image: string;
  at: number;
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
export interface WorkspaceView {
  workspaceSlug: string;
  projectName: string;
  containerName: string;
  imageId: string;
  status: string;
  createdAt: string;
}
export interface ContainerSettings {
  defaultImage: string;
  socketsRoot: string;
  projectsRoot: string;
  notice: string;
  workspaces: readonly WorkspaceView[];
  containers: readonly ContainerView[];
  images: readonly ImageView[];
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

export function installContainerSettings(
  ctx: any,
  resolver: WorkspaceResolver,
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
        const [containers, images, workspaces] = await Promise.all([
          resolver.control("listContainers", {}),
          resolver.control("listImages", {}),
          resolver.control("listWorkspaces", {}),
        ]);
        await scope.update({
          containers: (containers as any).containers ?? [],
          images: (images as any).images ?? [],
          workspaces: (((workspaces as any).workspaces ?? []) as any[]).map(
            (workspace) => ({
              workspaceSlug: workspace.workspaceSlug ?? "",
              projectName: workspace.mounts?.[0]?.projectName ?? workspace.workspaceSlug ?? "",
              containerName: workspace.containerName ?? "",
              imageId: workspace.imageId ?? "",
              status: workspace.status ?? "",
              createdAt: workspace.createdAt ?? "",
            }),
          ),
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
