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

// The reserved logical name of the one shared, orchestrator-owned PTC
// container. It belongs to no workspace, so it is rendered from its own
// snapshot entry rather than among a workspace's containers.
export const PTC_CONTAINER_NAME = "ptc";

// The one image id the orchestrator reserves for the shared PTC image. It is
// not stored among the images, and the container names it even before it
// exists: the card reads the expected image from the snapshot rather than
// guessing it.
export const PTC_IMAGE_ID = "ptc";

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
  | "ptc_remove"
  | "ptc_recreate"
  | "ptc_build"
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
  | "container_publish_port"
  | "container_unpublish_port"
  | "container_path_set"
  | "default_env_sync"
  | "cache_clean";

// The stable identity of one in-flight command: its operation plus the
// identifiers it acts on, e.g. "remove:team:default" or "volume_create:data".
// The controller keys its in-flight set with these builders and every control
// looks its own command up in CardState.pendingActions, so both halves must
// derive the key the same way. Identifiers never contain ":" (container and
// volume names, workspace slugs, cache modes), while an image id may, which is
// why keys are only ever compared whole.
export function containerActionKey(
  op: CommandOp,
  workspace: string,
  container: string,
): string {
  return `${op}:${workspace}:${container}`;
}

export function scopedActionKey(op: CommandOp, scope: string): string {
  return `${op}:${scope}`;
}

export function bareActionKey(op: CommandOp): string {
  return op;
}

// The operations keyed by containerActionKey(op, workspace, container), so a
// container row can tell whether any command on its own container is in flight.
const CONTAINER_OPS: readonly CommandOp[] = [
  "remove",
  "recreate",
  "create",
  "container_mount_add",
  "container_mount_remove",
  "container_mount_update",
  "container_path_set",
  "container_secret_add",
  "container_secret_remove",
  "container_publish_port",
  "container_unpublish_port",
];

export function containerActionPending(
  pendingActions: readonly string[],
  workspace: string,
  container: string,
): boolean {
  return CONTAINER_OPS.some((op) =>
    pendingActions.includes(containerActionKey(op, workspace, container))
  );
}

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
  secretEnvName: string;
  length: number;
  charset: string;
  packages: string[];
  secretEnv: Record<string, string>;
  cacheMode: string;
  mount: MountInput | null;
  // The container port a publish/unpublish command names, its transport, and the host
  // port to prefer (0 asks the gateway to choose a free one).
  port: number;
  protocol: string;
  suggestedHostPort: number;
}

// A published container port as the card renders it: the endpoint the gateway
// chose plus the parts it was built from.
export interface PublishedPortView {
  protocol: string;
  port: number;
  address: string;
  hostPort: number;
  endpoint: string;
}

export interface ContainerView {
  // The container's LOGICAL name ("default", "dev", …): the only identifier the
  // orchestrator accepts in a container field and the one every card action and
  // control request uses. The podman name (dsh-podman-<slug>-<logical>) is
  // internal and is rejected with INVALID_ARGUMENT if it is sent instead.
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
  publishedPorts: readonly PublishedPortView[];
}

// The one shared PTC container, rendered by the card outside any workspace.
// Unlike a workspace container it has no slug, and its state says "absent"
// when the orchestrator holds no record for it: the container is created
// lazily on first use, so a missing one is a normal state, not an error.
export interface PtcView {
  containerName: string;
  kind: "ptc";
  state: "running" | "stopped" | "absent";
  imageId: string;
  createdAt: string;
}

export function absentPtcView(): PtcView {
  return {
    containerName: PTC_CONTAINER_NAME,
    kind: "ptc",
    state: "absent",
    // The container does not exist yet, but its image does: naming it keeps the
    // card's image field filled instead of requiring the client to guess.
    imageId: PTC_IMAGE_ID,
    createdAt: "",
  };
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
  // NOT a usable container target: this is the workspace's default container's
  // PODMAN name (dsh-podman-<slug>-default), which comes straight from the
  // orchestrator's legacy workspace row and is rejected with INVALID_ARGUMENT
  // when sent back. Use ContainerView.containerName (logical) instead.
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
  // The harness (dsh) version the plugin runs inside, or "" when unknown.
  dshVersion: string;
  // The orchestrator's version, or "" when it predates the handshake.
  orchestratorVersion: string;
  // The orchestrator's short commit, or "" when it predates the handshake.
  orchestratorCommit: string;
  versionState: "ok" | "minor-mismatch" | "major-mismatch";
  // The optional port-publishing gateway. "unknown" means the orchestrator
  // predates the status RPC or has not probed the gateway yet, which the card
  // renders neutrally: the gateway is not required.
  gatewayState: "unknown" | "running" | "absent" | "incompatible";
  gatewayVersion: string;
  gatewayCommit: string;
  // How the gateway's major version compares with the orchestrator's, its
  // direct peer. Absent or unparseable reads as "ok".
  gatewayVersionState: "ok" | "minor-mismatch" | "major-mismatch";
  projectsRoot: string;
  workspaces: readonly WorkspaceView[];
  // The shared, workspace-less PTC container, always present (absent when the
  // orchestrator holds no record for it).
  ptc: PtcView;
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
