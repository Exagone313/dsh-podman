// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import z from "@deepseek-ai/schemastery";

export const CONTAINER_NS = "podman";

const commandSchema = z.object({
  op: z.union([
    z.const("refresh"),
    z.const("remove"),
    z.const("workspace_remove"),
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
    z.const("container_mount_update"),
    z.const("cache_clean"),
  ]),
  workspace: z.string().default(""),
  projectName: z.string().default(""),
  image: z.string().default(""),
  at: z.number().default(0),
  mounts: z.array(z.object({
    kind: z.string().default(""),
    project: z.string().default(""),
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
  cacheMode: z.string().default(""),
  mount: z.union([
    z.object({
      kind: z.string().default(""),
      project: z.string().default(""),
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
  uiLocale: z.string().default(""),
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
  caches: z
    .array(
      z.object({
        manager: z.string().default(""),
        path: z.string().default(""),
        files: z.number().default(0),
        bytes: z.number().default(0),
      }),
    )
    .default([]),
  command: z.union([commandSchema, z.const(null)]).default(null),
}) as unknown as z<ContainerSettings>;

export interface MountInput {
  kind: string;
  project: string;
  destination: string;
  mode: string;
  volume: string;
  secret: string;
}

export interface CommandRequest {
  op: "refresh" | "remove" | "workspace_remove" | "recreate" | "create" | "volume_create" | "volume_remove" | "image_remove" | "secret_create" | "secret_remove" | "secret_set" | "image_rebuild" | "image_rebuild_all" | "container_secret_add" | "container_secret_remove" | "image_build" | "image_base_rebuild" | "image_base_pull" | "container_mount_add" | "container_mount_remove" | "container_mount_update" | "cache_clean";
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
  cacheMode: string;
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

export interface CacheView {
  manager: string;
  path: string;
  files: number;
  bytes: number;
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
  uiLocale: string;
  workspaces: readonly WorkspaceView[];
  containers: readonly ContainerView[];
  images: readonly ImageView[];
  volumes: readonly VolumeView[];
  secrets: readonly SecretView[];
  caches: readonly CacheView[];
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
