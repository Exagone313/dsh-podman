// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { createSnapshotStore, type SnapshotStore } from "@deepseek-ai/dsh-client-store";
import type {
  SettingsScope,
  SettingsScopeSnapshot,
} from "@deepseek-ai/dsh-client-ui-settings/client";
import type {
  CacheView,
  CardSnapshot,
  CommandOp,
  CommandRequest,
  ContainerView,
  ImageView,
  MountInput,
  SecretView,
  VolumeView,
  WorkspaceView,
} from "./card-protocol.js";
import { createCardClient, type CardClient } from "./card-client.js";
import { type DirectoryPickerFace } from "./directory-picker.js";

export const CONTAINER_NS = "podman";

// The preferences the card edits, mirroring the host's settings namespace.
export interface ContainerSettings {
  defaultImage: string;
  socketsRoot: string;
  uiLocale?: string;
}

export interface ProjectMountView {
  projectName: string;
  destination: string;
  kind: string; // "MOUNT_KIND_PROJECT" | "MOUNT_KIND_TMPFS" | "MOUNT_KIND_VOLUME" | "MOUNT_KIND_SECRET"
  mode: string; // "MOUNT_MODE_READ_ONLY" | "MOUNT_MODE_READ_WRITE"
  volume: string;
  secret: string;
}
export interface ContainerCreateConfig {
  image?: string;
  env?: Record<string, string>;
  mounts?: readonly MountInput[];
  paths?: readonly string[];
  secretEnv?: Record<string, string>;
}

export type {
  CacheView,
  ContainerView,
  ImageView,
  MountInput,
  SecretView,
  VolumeView,
  WorkspaceView,
};

export interface CardState {
  available: boolean;
  writable: boolean;
  busy: boolean;
  notice: string;
  version: string;
  commit: string;
  dshVersion: string;
  orchestratorVersion: string;
  versionState: "ok" | "minor-mismatch" | "major-mismatch";
  defaultImage: string;
  socketsRoot: string;
  socketsRootDraft: string;
  projectsRoot: string;
  // The harness's host-side directory picker, when this deployment mounts one;
  // the card hides the project-mount browse affordance without it. Published
  // through the store (not the slot inject face) because the slot renderer
  // memoizes an entry's inject result for the registration's lifetime, so a
  // value that arrives after the first render would otherwise never appear.
  directoryPicker?: DirectoryPickerFace;
  workspaces: readonly WorkspaceView[];
  containers: readonly ContainerView[];
  images: readonly ImageView[];
  volumes: readonly VolumeView[];
  secrets: readonly SecretView[];
  caches: readonly CacheView[];
}

export interface ContainerCardFace {
  hooks: {
    containerCard: SnapshotStore<CardState>;
  };
  reload: () => void;
  remove: (workspace: string) => void;
  cleanCaches: (mode: string) => void;
  removeWorkspace: (workspace: string) => void;
  recreate: (workspace: string, image: string, env?: Record<string, string>) => void;
  createContainer: (workspace: WorkspaceView, config?: ContainerCreateConfig) => void;
  startContainer: (workspace: WorkspaceView, container: string, config?: ContainerCreateConfig) => void;
  addContainerMount: (workspace: string, container: string, mount: MountInput) => void;
  removeContainerMount: (workspace: string, container: string, mount: MountInput) => void;
  updateContainerMount: (workspace: string, container: string, mount: MountInput) => void;
  setContainerPaths: (workspace: string, container: string, paths: readonly string[]) => void;
  createVolume: (name: string) => void;
  removeVolume: (name: string) => void;
  removeImage: (imageId: string) => void;
  rebuildImage: (imageId: string) => void;
  rebuildAllImages: () => void;
  buildImage: (imageId: string, parent: string, packages: string[]) => void;
  rebuildBaseImage: (name: string) => void;
  pullBaseImage: (name: string) => void;
  setDefaultImage: (name: string) => void;
  createSecret: (name: string, length?: number, charset?: string) => void;
  removeSecret: (name: string) => void;
  setSecret: (name: string, value: string) => void;
  addContainerSecret: (workspace: string, envVar: string, secret: string) => void;
  removeContainerSecret: (workspace: string, envVar: string) => void;
  editSocketsRoot: (text: string) => void;
  saveSocketsRoot: () => void;
  discardSocketsRoot: () => void;
}

const EMPTY_SNAPSHOT: CardSnapshot = {
  version: "",
  commit: "",
  dshVersion: "",
  orchestratorVersion: "",
  versionState: "ok",
  projectsRoot: "",
  workspaces: [],
  containers: [],
  images: [],
  volumes: [],
  secrets: [],
  caches: [],
};

type DraftableField = "defaultImage" | "socketsRoot";

// The card reads its live state from the host route and its preferences from
// the settings namespace. A command is one request, so nothing is re-delivered
// and no document round-trip is involved.
export class ContainerCardController {
  private readonly store: SnapshotStore<CardState>;
  private readonly drafts = new Map<DraftableField, string>();
  private readonly client: CardClient;
  private snapshot: CardSnapshot = EMPTY_SNAPSHOT;
  // Counts in-flight commands, so overlapping ones cannot clear the busy state
  // early; generation makes a superseded response drop its stale snapshot.
  private pending = 0;
  private generation = 0;
  private notice = "";
  private directoryPicker: DirectoryPickerFace | undefined;

  constructor(
    private readonly scope: SettingsScope<ContainerSettings>,
    client: CardClient = createCardClient(),
  ) {
    this.client = client;
    this.store = createSnapshotStore(this.project());
    scope.subscribe(() => {
      this.publish();
    });
    void this.reload();
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
      busy: this.pending > 0,
      notice: this.notice,
      version: this.snapshot.version,
      commit: this.snapshot.commit,
      dshVersion: this.snapshot.dshVersion,
      orchestratorVersion: this.snapshot.orchestratorVersion,
      versionState: this.snapshot.versionState,
      defaultImage: value?.defaultImage ?? "",
      socketsRoot: value?.socketsRoot ?? "",
      socketsRootDraft: this.draft("socketsRoot", value?.socketsRoot ?? ""),
      projectsRoot: this.snapshot.projectsRoot,
      ...(this.directoryPicker === undefined
        ? {}
        : { directoryPicker: this.directoryPicker }),
      workspaces: this.snapshot.workspaces,
      containers: this.snapshot.containers,
      images: this.snapshot.images,
      volumes: this.snapshot.volumes,
      secrets: this.snapshot.secrets,
      caches: this.snapshot.caches,
    };
  }

  private publish(): void {
    this.store.set(this.project());
  }

  // setDirectoryPicker records the harness's directory picker (or clears it)
  // and republishes, so the card shows or hides the browse affordance.
  setDirectoryPicker(picker: DirectoryPickerFace | undefined): void {
    this.directoryPicker = picker;
    this.publish();
  }

  private command(
    op: CommandOp,
    workspace: string,
    image: string,
    extra: {
      projectName?: string;
      mounts?: readonly MountInput[];
      paths?: readonly string[];
      value?: string;
      env?: Record<string, string>;
      container?: string;
      secret?: string;
      secretEnv?: string;
      length?: number;
      charset?: string;
      packages?: string[];
      secretEnvMap?: Record<string, string>;
      cacheMode?: string;
      mount?: MountInput | null;
    } = {},
  ): void {
    void this.dispatch({
      op,
      workspace,
      image,
      projectName: extra.projectName ?? "",
      mounts: extra.mounts ?? [],
      paths: extra.paths ?? [],
      value: extra.value ?? "",
      env: extra.env ?? {},
      container: extra.container ?? "",
      secret: extra.secret ?? "",
      secretEnv: extra.secretEnv ?? "",
      length: extra.length ?? 0,
      charset: extra.charset ?? "",
      packages: extra.packages ?? [],
      secretEnvMap: extra.secretEnvMap ?? {},
      cacheMode: extra.cacheMode ?? "",
      mount: extra.mount ?? null,
    });
  }

  private async dispatch(request: CommandRequest): Promise<void> {
    const generation = ++this.generation;
    this.pending++;
    this.notice = "";
    this.publish();
    try {
      const result = await this.client.command(request);
      const snapshot = await this.client.snapshot();
      // A reload (or another command) started after this one wins: applying
      // this response would overwrite the fresher state with a stale snapshot.
      if (generation !== this.generation) return;
      this.notice = result.notice ?? "";
      this.snapshot = snapshot;
    } catch (error) {
      if (generation === this.generation) {
        this.notice = error instanceof Error ? error.message : String(error);
      }
    } finally {
      this.pending--;
      this.publish();
    }
  }

  private async reload(): Promise<void> {
    const generation = ++this.generation;
    this.pending++;
    this.publish();
    try {
      const snapshot = await this.client.snapshot();
      if (generation !== this.generation) return;
      this.snapshot = snapshot;
      // A refresh clears the previous action's notice, so reopening the
      // settings does not replay feedback from an earlier session.
      this.notice = "";
    } catch (error) {
      if (generation === this.generation) {
        this.notice = error instanceof Error ? error.message : String(error);
      }
    } finally {
      this.pending--;
      this.publish();
    }
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
      reload: () => {
        void this.reload();
      },
      remove: (workspace) => this.command("remove", workspace, ""),
      cleanCaches: (mode) => this.command("cache_clean", "", "", { cacheMode: mode }),
      removeWorkspace: (workspace) => this.command("workspace_remove", workspace, ""),
      recreate: (workspace, image, env) =>
        this.command("recreate", workspace, image, { ...(env ? { env } : {}) }),
      createContainer: (workspace, config) =>
        this.command(
          "create",
          workspace.workspaceSlug,
          config?.image ?? (workspace.imageId || this.defaultImage() || ""),
          {
            projectName: workspace.projectName,
            ...(config?.mounts && config.mounts.length > 0 ? { mounts: config.mounts } : {}),
            ...(config?.env && Object.keys(config.env).length > 0 ? { env: config.env } : {}),
            ...(config?.paths && config.paths.length > 0 ? { paths: config.paths } : {}),
            ...(config?.secretEnv && Object.keys(config.secretEnv).length > 0 ? { secretEnvMap: config.secretEnv } : {}),
          },
        ),
      startContainer: (workspace, container, config) =>
        this.command(
          "create",
          workspace.workspaceSlug,
          config?.image ?? (workspace.imageId || this.defaultImage() || ""),
          {
            container,
            ...(config?.mounts && config.mounts.length > 0 ? { mounts: config.mounts } : {}),
            ...(config?.env && Object.keys(config.env).length > 0 ? { env: config.env } : {}),
            ...(config?.paths && config.paths.length > 0 ? { paths: config.paths } : {}),
            ...(config?.secretEnv && Object.keys(config.secretEnv).length > 0 ? { secretEnvMap: config.secretEnv } : {}),
          },
        ),
      addContainerMount: (workspace, container, mount) =>
        this.command("container_mount_add", workspace, "", { container, mount }),
      removeContainerMount: (workspace, container, mount) =>
        this.command("container_mount_remove", workspace, "", { container, mount }),
      updateContainerMount: (workspace, container, mount) =>
        this.command("container_mount_update", workspace, "", { container, mount }),
      setContainerPaths: (workspace, container, paths) =>
        this.command("container_path_set", workspace, "", { container, paths }),
      createVolume: (name) => this.command("volume_create", name, ""),
      removeVolume: (name) => this.command("volume_remove", name, ""),
      removeImage: (imageId) => this.command("image_remove", imageId, ""),
      rebuildImage: (imageId) => this.command("image_rebuild", imageId, ""),
      rebuildAllImages: () => this.command("image_rebuild_all", "", ""),
      buildImage: (imageId, parent, packages) =>
        this.command("image_build", imageId, parent, { packages }),
      rebuildBaseImage: (name) => this.command("image_base_rebuild", name, ""),
      pullBaseImage: (name) => this.command("image_base_pull", name, ""),
      setDefaultImage: (name) => {
        this.edit("defaultImage", name);
        this.save("defaultImage");
      },
      createSecret: (name, length, charset) =>
        this.command("secret_create", name, "", {
          ...(length ? { length } : {}),
          ...(charset ? { charset } : {}),
        }),
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
      editSocketsRoot: (text) => this.edit("socketsRoot", text),
      saveSocketsRoot: () => this.save("socketsRoot"),
      discardSocketsRoot: () => this.discard("socketsRoot"),
    };
  }

  private defaultImage(): string {
    return this.scope.getSnapshot().value?.defaultImage ?? "";
  }
}

export type { SettingsScopeSnapshot };
