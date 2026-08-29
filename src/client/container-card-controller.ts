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
export interface CommandRequest {
  op: "refresh" | "remove" | "recreate";
  workspace: string;
  image: string;
  at: number;
}
export interface ContainerSettings {
  defaultImage: string;
  socketsRoot: string;
  projectsRoot: string;
  notice: string;
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
  editDefaultImage: (text: string) => void;
  saveDefaultImage: () => void;
  discardDefaultImage: () => void;
}

export class ContainerCardController {
  private readonly store: SnapshotStore<CardState>;
  private draft: string | undefined;

  constructor(private readonly scope: SettingsScope<ContainerSettings>) {
    this.store = createSnapshotStore(this.project());
    scope.subscribe(() => {
      this.publish();
    });
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
      defaultImageDraft: this.draft ?? value?.defaultImage ?? "",
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
  ): void {
    void this.scope.set("command", { op, workspace, image, at: Date.now() });
  }

  inject(): ContainerCardFace {
    return {
      hooks: { containerCard: this.store },
      reload: () => this.command("refresh", "", ""),
      remove: (workspace) => this.command("remove", workspace, ""),
      recreate: (workspace, image) =>
        this.command("recreate", workspace, image),
      editDefaultImage: (text) => {
        this.draft = text;
        this.publish();
      },
      saveDefaultImage: () => {
        const draft = this.draft;
        if (draft === undefined) return;
        void this.scope.set("defaultImage", draft);
      },
      discardDefaultImage: () => {
        this.draft = undefined;
        this.publish();
      },
    };
  }
}

export type { SettingsScopeSnapshot };
