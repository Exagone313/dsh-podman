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
  mounts: readonly { projectName: string; mode: string }[];
}
export interface CommandRequest {
  op: "refresh" | "remove" | "recreate" | "create";
  workspace: string;
  image: string;
  at: number;
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
}

export interface ContainerCardFace {
  hooks: {
    containerCard: SnapshotStore<CardState>;
  };
  reload: () => void;
  remove: (workspace: string) => void;
  recreate: (workspace: string, image: string) => void;
  createContainer: (workspace: WorkspaceView) => void;
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
    };
  }

  private publish(): void {
    this.store.set(this.project());
  }

  private command(
    op: CommandRequest["op"],
    workspace: string,
    image: string,
    mounts: readonly { projectName: string; mode: string }[] = [],
  ): void {
    void this.scope.set("command", { op, workspace, image, at: Date.now(), mounts });
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
      recreate: (workspace, image) =>
        this.command("recreate", workspace, image),
      createContainer: (workspace) =>
        this.command(
          "create",
          workspace.workspaceSlug,
          workspace.imageId || this.scope.getSnapshot().value?.defaultImage || "",
          workspace.mounts,
        ),
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
