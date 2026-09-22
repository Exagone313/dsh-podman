// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// The settings card talks to the host over one authenticated route on the
// harness's connection service. These shapes are shared by both halves, and
// neither the snapshot nor the commands touch the persisted settings document.

// The full route path, harness API prefix included: the connection service
// registers and matches the whole pathname (a path outside `/api/` is refused
// at registration).
export const CARD_PATH = "/api/podman/card";

export interface MountInput {
  kind: string;
  project: string;
  destination: string;
  mode: string;
  volume: string;
  secret: string;
}

export type CommandOp =
  | "remove"
  | "workspace_remove"
  | "recreate"
  | "create"
  | "volume_create"
  | "volume_remove"
  | "image_remove"
  | "secret_create"
  | "secret_remove"
  | "secret_set"
  | "image_rebuild"
  | "image_rebuild_all"
  | "image_build"
  | "image_base_rebuild"
  | "image_base_pull"
  | "container_secret_add"
  | "container_secret_remove"
  | "container_mount_add"
  | "container_mount_remove"
  | "container_mount_update"
  | "container_path_set"
  | "cache_clean";

export interface CommandRequest {
  op: CommandOp;
  workspace: string;
  projectName: string;
  image: string;
  mounts: readonly MountInput[];
  paths: readonly string[];
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
  mounts: readonly {
    projectName: string;
    destination: string;
    kind: string;
    mode: string;
    volume: string;
    secret: string;
  }[];
  paths: readonly string[];
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

/** The live orchestrator state the card renders. Nothing here is persisted. */
export interface CardSnapshot {
  version: string;
  commit: string;
  // The orchestrator's version, or "" when it predates the handshake.
  orchestratorVersion: string;
  versionState: "ok" | "minor-mismatch" | "major-mismatch";
  projectsRoot: string;
  workspaces: readonly WorkspaceView[];
  containers: readonly ContainerView[];
  images: readonly ImageView[];
  volumes: readonly VolumeView[];
  secrets: readonly SecretView[];
  caches: readonly CacheView[];
}

export interface CardCommandResult {
  notice?: string;
}

export interface CardError {
  error: string;
}
