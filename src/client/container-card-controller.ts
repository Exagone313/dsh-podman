// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import type {
  SettingsScope,
  SettingsScopeSnapshot,
  SnapshotStore,
} from "@deepseek-ai/dsh-client-runtime/client";
import { createSnapshotStore } from "@deepseek-ai/dsh-client-runtime/client";

export const CONTAINER_NS = "podman";

export interface ProjectMountView {
  projectName: string;
  mode: string;
}
export interface ContainerView {
  containerName: string;
  workspaceSlug: string;
  imageId: string;
  status: string;
  createdAt: string;
  mounts: readonly ProjectMountView[];
  env: Record<string, string>;
  secretEnv: Record<string, string>;
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
export interface CommandRequest {
  op: "refresh" | "remove" | "recreate" | "create" | "volume_create" | "volume_remove" | "image_remove" | "secret_create" | "secret_remove" | "secret_set" | "image_rebuild" | "image_rebuild_all" | "container_secret_add" | "container_secret_remove";
  workspace: string;
  image: string;
  at: number;
  mounts: readonly { projectName: string; mode: string }[];
  value: string;
  env: Record<string, string>;
  container: string;
  secret: string;
  secretEnv: string;
  length: number;
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

export interface CardState {
  available: boolean;
  writable: boolean;
  busy: boolean;
  notice: string;
  defaultImage: string;
  defaultImageDraft: string;
  socketsRoot: string;
  socketsRootDraft: string;
  projectsRoot: string;
  projectsRootDraft: string;
  workspaces: readonly WorkspaceView[];
  containers: readonly ContainerView[];
  images: readonly ImageView[];
  volumes: readonly VolumeView[];
  secrets: readonly SecretView[];
}

export interface ContainerCardFace {
  hooks: {
    containerCard: SnapshotStore<CardState>;
  };
  reload: () => void;
  remove: (workspace: string) => void;
  recreate: (workspace: string, image: string, env?: Record<string, string>) => void;
  createContainer: (workspace: WorkspaceView, env?: Record<string, string>) => void;
  createVolume: (name: string) => void;
  removeVolume: (name: string) => void;
  removeImage: (imageId: string) => void;
  rebuildImage: (imageId: string) => void;
  rebuildAllImages: () => void;
  createSecret: (name: string, length?: number) => void;
  removeSecret: (name: string) => void;
  setSecret: (name: string, value: string) => void;
  addContainerSecret: (workspace: string, envVar: string, secret: string) => void;
  removeContainerSecret: (workspace: string, envVar: string) => void;
  editDefaultImage: (text: string) => void;
  saveDefaultImage: () => void;
  discardDefaultImage: () => void;
  editSocketsRoot: (text: string) => void;
  saveSocketsRoot: () => void;
  discardSocketsRoot: () => void;
  editProjectsRoot: (text: string) => void;
  saveProjectsRoot: () => void;
  discardProjectsRoot: () => void;
}

type DraftableField = "defaultImage" | "socketsRoot" | "projectsRoot";

export class ContainerCardController {
  private readonly store: SnapshotStore<CardState>;
  private readonly drafts = new Map<DraftableField, string>();

  constructor(private readonly scope: SettingsScope<ContainerSettings>) {
    this.store = createSnapshotStore(this.project());
    scope.subscribe(() => {
      this.publish();
    });
  }

  private draft(field: DraftableField, current: string): string {
    return this.drafts.get(field) ?? current;
  }

  private project(): CardState {
    const snapshot = this.scope.getSnapshot();
    const value = snapshot.value;
    return {
      available: snapshot.status === "ready" && value !== undefined,
      writable: snapshot.writable,
      busy: value?.command !== null && value?.command !== undefined,
      notice: value?.notice ?? "",
      defaultImage: value?.defaultImage ?? "",
      defaultImageDraft: this.draft("defaultImage", value?.defaultImage ?? ""),
      socketsRoot: value?.socketsRoot ?? "",
      socketsRootDraft: this.draft("socketsRoot", value?.socketsRoot ?? ""),
      projectsRoot: value?.projectsRoot ?? "",
      projectsRootDraft: this.draft("projectsRoot", value?.projectsRoot ?? ""),
      workspaces: value?.workspaces ?? [],
      containers: value?.containers ?? [],
      images: value?.images ?? [],
      volumes: value?.volumes ?? [],
      secrets: value?.secrets ?? [],
    };
  }

  private publish(): void {
    this.store.set(this.project());
  }

  private command(
    op: CommandRequest["op"],
    workspace: string,
    image: string,
    extra: {
      mounts?: readonly { projectName: string; mode: string }[];
      value?: string;
      env?: Record<string, string>;
      container?: string;
      secret?: string;
      secretEnv?: string;
      length?: number;
    } = {},
  ): void {
    void this.scope.set("command", {
      op, workspace, image, at: Date.now(),
      mounts: extra.mounts ?? [],
      value: extra.value ?? "",
      env: extra.env ?? {},
      container: extra.container ?? "",
      secret: extra.secret ?? "",
      secretEnv: extra.secretEnv ?? "",
      length: extra.length ?? 0,
    });
  }

  private edit(field: DraftableField, text: string): void {
    this.drafts.set(field, text);
    this.publish();
  }

  private save(field: DraftableField): void {
    const draft = this.drafts.get(field);
    if (draft === undefined) return;
    void this.scope.set(field, draft);
  }

  private discard(field: DraftableField): void {
    this.drafts.delete(field);
    this.publish();
  }

  inject(): ContainerCardFace {
    return {
      hooks: { containerCard: this.store },
      reload: () => this.command("refresh", "", ""),
      remove: (workspace) => this.command("remove", workspace, ""),
      recreate: (workspace, image, env) =>
        this.command("recreate", workspace, image, { ...(env ? { env } : {}) }),
      createContainer: (workspace, env) =>
        this.command(
          "create",
          workspace.workspaceSlug,
          workspace.imageId || this.scope.getSnapshot().value?.defaultImage || "",
          {
            mounts: workspace.mounts,
            ...(env ? { env } : {}),
          },
        ),
      createVolume: (name) => this.command("volume_create", name, ""),
      removeVolume: (name) => this.command("volume_remove", name, ""),
      removeImage: (imageId) => this.command("image_remove", imageId, ""),
      rebuildImage: (imageId) => this.command("image_rebuild", imageId, ""),
      rebuildAllImages: () => this.command("image_rebuild_all", "", ""),
      createSecret: (name, length) =>
        this.command("secret_create", name, "", { ...(length ? { length } : {}) }),
      removeSecret: (name) => this.command("secret_remove", name, ""),
      setSecret: (name, value) =>
        this.command("secret_set", name, "", { value }),
      addContainerSecret: (workspace, envVar, secret) =>
        this.command("container_secret_add", workspace, "", {
          container: "default",
          secretEnv: envVar,
          secret,
        }),
      removeContainerSecret: (workspace, envVar) =>
        this.command("container_secret_remove", workspace, "", {
          container: "default",
          secretEnv: envVar,
        }),
      editDefaultImage: (text) => this.edit("defaultImage", text),
      saveDefaultImage: () => this.save("defaultImage"),
      discardDefaultImage: () => this.discard("defaultImage"),
      editSocketsRoot: (text) => this.edit("socketsRoot", text),
      saveSocketsRoot: () => this.save("socketsRoot"),
      discardSocketsRoot: () => this.discard("socketsRoot"),
      editProjectsRoot: (text) => this.edit("projectsRoot", text),
      saveProjectsRoot: () => this.save("projectsRoot"),
      discardProjectsRoot: () => this.discard("projectsRoot"),
    };
  }
}

export type { SettingsScopeSnapshot };
