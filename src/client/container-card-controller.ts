// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import {
  createSnapshotStore,
  type SnapshotStore,
} from "@deepseek-ai/dsh-client-store";
import type {
  ConfigForm,
  ConfigFormSnapshot,
} from "@deepseek-ai/dsh-client-ui-settings/client";
import {
  bareActionKey,
  type CacheView,
  type CardSnapshot,
  type CommandOp,
  type CommandRequest,
  containerActionKey,
  type ContainerView,
  type ImageView,
  type MountInput,
  type PublishedPortView,
  scopedActionKey,
  type SecretView,
  type VolumeView,
  type WorkspaceView,
} from "./card-protocol.js";
import { type CardClient, createCardClient } from "./card-client.js";
import {
  configNeedsRecreate,
  type ContainerConfig,
  envDiff,
  mountDiff,
  pathsEqual,
  type PortConfig,
  portDiff,
} from "./container-card-config.js";
import { type DirectoryPickerFace } from "./directory-picker.js";
import { versionState as pluginVersionState } from "../version-compat.js";

export const CONTAINER_NS = "podman";

// The preferences the card edits, mirroring the host's settings namespace.
export interface ContainerSettings {
  defaultImage: string;
  uiLocale?: string;
  // The environment seeded into a container when it is created.
  containerEnv?: Record<string, string>;
}

export interface ProjectMountView {
  projectName: string;
  destination: string;
  kind: string; // "project" | "tmpfs" | "volume" | "secret"
  mode: string; // "read_only" | "read_write"
  volume: string;
  secret: string;
}
export interface ContainerCreateConfig {
  image?: string;
  env?: Record<string, string>;
  mounts?: readonly MountInput[];
  paths?: readonly string[];
  secretEnv?: Record<string, string>;
  // The ports the new container should publish once it exists: they are staged
  // with the create and published right after it answers.
  ports?: readonly PortConfig[];
}

export type {
  CacheView,
  ContainerConfig,
  ContainerView,
  ImageView,
  MountInput,
  PublishedPortView,
  SecretView,
  VolumeView,
  WorkspaceView,
};

// One transient command report: the sequence keys the rendered toast so a new
// report restarts its hold, kind picks the failure icon, and text is the host's
// own notice (or an error message), never a dictionary key.
export interface CardToast {
  seq: number;
  kind: "ok" | "error";
  text: string;
}

export interface CardState {
  available: boolean;
  // Whether the preferences namespace is still loading, ready, or refused
  // (unavailable), so the card can show progress instead of an error.
  loadState: "loading" | "ready" | "unavailable";
  writable: boolean;
  // Whether any command (or a reload) is in flight; page-level actions use it.
  // A control acting on one object asks pendingActions for its own key instead.
  busy: boolean;
  // The keys of the commands currently in flight, sorted and stable between
  // publishes so a control can disable itself (or show progress) for its own
  // command only. See the key builders in card-protocol.ts.
  pendingActions: readonly string[];
  // The command report a toast renders, or null when there is nothing to show.
  toast: CardToast | null;
  notice: string;
  // Whether the current notice reports a failure, which renders it as an alert.
  noticeIsError: boolean;
  version: string;
  commit: string;
  dshVersion: string;
  orchestratorVersion: string;
  orchestratorCommit: string;
  // How the orchestrator's version compares with this plugin's own.
  versionState: "ok" | "minor-mismatch" | "major-mismatch";
  gatewayState: "unknown" | "running" | "absent" | "incompatible";
  gatewayVersion: string;
  gatewayCommit: string;
  // How the gateway's version compares with this plugin's own. The snapshot's
  // own field compares the gateway with the orchestrator, its direct peer; the
  // status table reads every daemon against the plugin's version (the reference
  // row), so the card derives the comparison it shows here. Both rows then flag
  // a deployment where the two daemons share a version the plugin differs from.
  gatewayVersionState: "ok" | "minor-mismatch" | "major-mismatch";
  // Whether the last snapshot fetch reached the orchestrator, so the card's
  // one-liner reports it instead of guessing from the settings namespace.
  orchestratorReady: boolean;
  // Whether any snapshot fetch has settled yet. The orchestrator reads as
  // "unknown" only until this first answer; afterwards ready and not-ready are
  // both facts the snapshot established.
  orchestratorKnown: boolean;
  defaultImage: string;
  // The plugin's active locale, as the client locale service reports it, or ""
  // until the service has answered; date formatting falls back to the runtime
  // default when it is empty.
  locale: string;
  // The default container environment, seeded into new containers (see
  // container-env.ts).
  containerEnv: Record<string, string>;
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
  // Unmount the current toast once its hold ends (or the user dismisses it).
  dismissToast: () => void;
  remove: (workspace: string, container: string) => void;
  cleanCaches: (mode: string) => void;
  removeWorkspace: (workspace: string) => void;
  recreate: (
    workspace: string,
    container: string,
    image: string,
    env?: Record<string, string>,
  ) => void;
  createContainer: (
    workspace: WorkspaceView,
    config?: ContainerCreateConfig,
  ) => void;
  startContainer: (
    workspace: WorkspaceView,
    container: string,
    config?: ContainerCreateConfig,
  ) => void;
  addContainerMount: (
    workspace: string,
    container: string,
    mount: MountInput,
  ) => void;
  removeContainerMount: (
    workspace: string,
    container: string,
    mount: MountInput,
  ) => void;
  updateContainerMount: (
    workspace: string,
    container: string,
    mount: MountInput,
  ) => void;
  setContainerPaths: (
    workspace: string,
    container: string,
    paths: readonly string[],
  ) => void;
  // Expose a container port on the host's loopback; an omitted host port lets the
  // gateway choose a free one, which the notice then names.
  publishContainerPort: (
    workspace: string,
    container: string,
    port: number,
    suggestedHostPort?: number,
  ) => void;
  unpublishContainerPort: (
    workspace: string,
    container: string,
    port: number,
    protocol: string,
  ) => void;
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
  addContainerSecret: (
    workspace: string,
    container: string,
    envVar: string,
    secret: string,
  ) => void;
  removeContainerSecret: (
    workspace: string,
    container: string,
    envVar: string,
  ) => void;
  // Replace the default environment (the git popup and the generic editor both
  // go through this).
  saveContainerEnv: (env: Record<string, string>) => void;
  // Add the default environment to the existing containers that are missing it;
  // an empty workspace covers every container.
  applyDefaultEnv: (workspace: string) => void;
  // Apply a container's saved configuration: every group is staged on the host
  // and the container is recreated only when the change reaches what it runs.
  applyContainerConfig: (
    workspace: string,
    container: string,
    base: ContainerConfig,
    next: ContainerConfig,
  ) => void;
}

const EMPTY_SNAPSHOT: CardSnapshot = {
  version: "",
  commit: "",
  dshVersion: "",
  orchestratorVersion: "",
  orchestratorCommit: "",
  versionState: "ok",
  gatewayState: "unknown",
  gatewayVersion: "",
  gatewayCommit: "",
  gatewayVersionState: "ok",
  projectsRoot: "",
  workspaces: [],
  containers: [],
  images: [],
  volumes: [],
  secrets: [],
  caches: [],
};

type DraftableField = "defaultImage";

// The optional fields one command carries; every field the request shape needs
// has a safe empty default, so a caller names only what it uses.
interface CommandExtra {
  projectName?: string;
  mounts?: readonly MountInput[];
  paths?: readonly string[];
  value?: string;
  env?: Record<string, string>;
  container?: string;
  secret?: string;
  secretEnvName?: string;
  length?: number;
  charset?: string;
  packages?: string[];
  secretEnv?: Record<string, string>;
  cacheMode?: string;
  mount?: MountInput | null;
  port?: number;
  protocol?: string;
  suggestedHostPort?: number;
}

// The key a dispatched command is tracked under; see the builders in
// card-protocol.ts. The switch is exhaustive, so adding a CommandOp without a
// key is a compile error. Naming operations carry their single identifier in
// the request's `workspace` field, mirroring how the face methods dispatch them.
function commandKey(request: CommandRequest): string {
  switch (request.op) {
    case "remove":
    case "recreate":
    case "create":
    case "container_mount_add":
    case "container_mount_remove":
    case "container_mount_update":
    case "container_path_set":
    case "container_secret_add":
    case "container_secret_remove":
    case "container_publish_port":
    case "container_unpublish_port":
      return containerActionKey(
        request.op,
        request.workspace,
        request.container,
      );
    case "cache_clean":
      return scopedActionKey(request.op, request.cacheMode);
    case "image_rebuild_all":
      return bareActionKey(request.op);
    case "default_env_sync":
      // A sync names the workspace it targets, and an empty workspace means
      // every container; keying the two apart keeps the in-flight set stable
      // whichever the dialog asks for.
      return scopedActionKey(
        request.op,
        request.workspace === "" ? "all" : request.workspace,
      );
    case "workspace_remove":
    case "volume_create":
    case "volume_remove":
    case "image_remove":
    case "image_rebuild":
    case "image_build":
    case "image_base_rebuild":
    case "image_base_pull":
    case "secret_create":
    case "secret_remove":
    case "secret_set":
      return scopedActionKey(request.op, request.workspace);
  }
}

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
  // How many in-flight commands share each action key, plus the sorted key list
  // published on CardState (stable identity while the set is unchanged).
  private readonly pendingKeys = new Map<string, number>();
  private pendingActions: readonly string[] = [];
  private generation = 0;
  private notice = "";
  // Whether the last snapshot fetch (a reload or a finished command) reached
  // the orchestrator.
  private orchestratorReady = false;
  // Whether any fetch has settled, which is what turns the orchestrator's
  // readiness from unknown into a fact.
  private orchestratorKnown = false;
  private toast: CardToast | null = null;
  private toastSeq = 0;
  private directoryPicker: DirectoryPickerFace | undefined;
  // The plugin's active locale, recorded from the client locale service so a
  // row can date itself in the reader's own language.
  private locale = "";

  // Whether the notice currently published reports a failure rather than a
  // result, so the card can announce it as an alert.
  private noticeIsError = false;

  constructor(
    private readonly scope: ConfigForm<ContainerSettings>,
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
      loadState: snapshot.status === "ready" && value !== undefined
        ? "ready"
        : snapshot.status === "loading"
        ? "loading"
        : "unavailable",
      writable: snapshot.writable,
      busy: this.pending > 0,
      pendingActions: this.pendingActions,
      toast: this.toast,
      notice: this.notice,
      noticeIsError: this.noticeIsError,
      version: this.snapshot.version,
      commit: this.snapshot.commit,
      dshVersion: this.snapshot.dshVersion,
      orchestratorVersion: this.snapshot.orchestratorVersion,
      orchestratorCommit: this.snapshot.orchestratorCommit,
      versionState: this.snapshot.versionState,
      gatewayState: this.snapshot.gatewayState,
      gatewayVersion: this.snapshot.gatewayVersion,
      gatewayCommit: this.snapshot.gatewayCommit,
      gatewayVersionState: this.snapshot.gatewayVersion === ""
        ? "ok"
        : pluginVersionState(
          this.snapshot.version,
          this.snapshot.gatewayVersion,
        ),
      orchestratorReady: this.orchestratorReady,
      orchestratorKnown: this.orchestratorKnown,
      defaultImage: value?.defaultImage ?? "",
      locale: this.locale,
      containerEnv: value?.containerEnv ?? {},
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

  // setLocale records the active locale (the browser default included) and
  // republishes, so every dated row is re-rendered in it.
  setLocale(locale: string): void {
    if (this.locale === locale) return;
    this.locale = locale;
    this.publish();
  }

  private beginAction(key: string): void {
    this.pendingKeys.set(key, (this.pendingKeys.get(key) ?? 0) + 1);
    this.pendingActions = [...this.pendingKeys.keys()].sort();
  }

  private endAction(key: string): void {
    const remaining = (this.pendingKeys.get(key) ?? 0) - 1;
    if (remaining > 0) this.pendingKeys.set(key, remaining);
    else this.pendingKeys.delete(key);
    this.pendingActions = [...this.pendingKeys.keys()].sort();
  }

  // showToast publishes one command report; an empty notice means there is
  // nothing to say (a successful command that reported no result).
  private showToast(kind: "ok" | "error", text: string): void {
    if (text === "") return;
    this.toastSeq += 1;
    this.toast = { seq: this.toastSeq, kind, text };
  }

  private request(
    op: CommandOp,
    workspace: string,
    image: string,
    extra: CommandExtra = {},
  ): Promise<boolean> {
    return this.dispatch({
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
      secretEnvName: extra.secretEnvName ?? "",
      length: extra.length ?? 0,
      charset: extra.charset ?? "",
      packages: extra.packages ?? [],
      secretEnv: extra.secretEnv ?? {},
      cacheMode: extra.cacheMode ?? "",
      mount: extra.mount ?? null,
      port: extra.port ?? 0,
      protocol: extra.protocol ?? "",
      suggestedHostPort: extra.suggestedHostPort ?? 0,
    });
  }

  private command(
    op: CommandOp,
    workspace: string,
    image: string,
    extra: CommandExtra = {},
  ): void {
    void this.request(op, workspace, image, extra);
  }

  // The create request's optional fields, taken from a dialog draft: an empty
  // group is omitted rather than sent, so the orchestrator keeps its own
  // default.
  private createExtra(
    config: ContainerCreateConfig | undefined,
    base: CommandExtra,
  ): CommandExtra {
    return {
      ...base,
      ...(config?.mounts && config.mounts.length > 0
        ? { mounts: config.mounts }
        : {}),
      ...(config?.env && Object.keys(config.env).length > 0
        ? { env: config.env }
        : {}),
      ...(config?.paths && config.paths.length > 0
        ? { paths: config.paths }
        : {}),
      ...(config?.secretEnv && Object.keys(config.secretEnv).length > 0
        ? { secretEnv: config.secretEnv }
        : {}),
    };
  }

  // Create a container from a dialog draft and publish the ports that draft
  // staged: publishing needs the container to exist, so it waits for the create
  // to answer, and a refused create publishes nothing.
  private create(
    workspace: string,
    image: string,
    extra: CommandExtra,
    ports: readonly PortConfig[],
  ): void {
    void this.request("create", workspace, image, extra).then((ok) => {
      if (!ok) return;
      for (const port of ports) {
        this.command("container_publish_port", workspace, "", {
          container: extra.container ?? "",
          port: port.port,
          protocol: port.protocol,
          ...(port.suggestedHostPort > 0
            ? { suggestedHostPort: port.suggestedHostPort }
            : {}),
        });
      }
    });
  }

  private async dispatch(request: CommandRequest): Promise<boolean> {
    const key = commandKey(request);
    const generation = ++this.generation;
    this.pending++;
    this.beginAction(key);
    this.publish();
    try {
      const result = await this.client.command(request);
      const snapshot = await this.client.snapshot();
      // The fetch itself succeeded, so the orchestrator answered, whatever the
      // generation check below decides about applying its snapshot.
      this.orchestratorReady = true;
      this.orchestratorKnown = true;
      // A reload (or another command) started after this one wins: applying
      // this response would overwrite the fresher state with a stale snapshot.
      if (generation !== this.generation) return true;
      this.snapshot = snapshot;
      this.showToast("ok", result.notice ?? "");
      return true;
    } catch (error) {
      if (generation === this.generation) {
        this.showToast(
          "error",
          error instanceof Error ? error.message : String(error),
        );
      }
      return false;
    } finally {
      this.pending--;
      this.endAction(key);
      this.publish();
    }
  }

  private async reload(): Promise<void> {
    const generation = ++this.generation;
    this.pending++;
    this.publish();
    try {
      const snapshot = await this.client.snapshot();
      this.orchestratorReady = true;
      this.orchestratorKnown = true;
      if (generation !== this.generation) return;
      this.snapshot = snapshot;
      // A refresh clears the previous load failure, so reopening the settings
      // does not replay feedback from an earlier session.
      this.notice = "";
      this.noticeIsError = false;
    } catch (error) {
      if (generation === this.generation) {
        const text = error instanceof Error ? error.message : String(error);
        // The banner keeps the load failure visible for as long as the card
        // lasts; the toast announces it once.
        this.orchestratorReady = false;
        this.orchestratorKnown = true;
        this.notice = text;
        this.noticeIsError = true;
        this.showToast("error", text);
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

  // Apply a container's draft on the host, one group at a time, so the change
  // takes effect. Each dispatch reports its own failure and never rejects, so
  // one refused change does not strand the rest; the recreate runs last, only
  // when the image or the environment changed, since those are the two fields
  // it carries.
  private async applyConfig(
    workspace: string,
    container: string,
    base: ContainerConfig,
    next: ContainerConfig,
  ): Promise<void> {
    const mounts = mountDiff(base.mounts, next.mounts);
    for (const mount of mounts.removed) {
      await this.request("container_mount_remove", workspace, "", {
        container,
        mount,
      });
    }
    for (const mount of mounts.updated) {
      await this.request("container_mount_update", workspace, "", {
        container,
        mount,
      });
    }
    for (const mount of mounts.added) {
      await this.request("container_mount_add", workspace, "", {
        container,
        mount,
      });
    }
    // A secret env var has no in-place update: a changed value is detached and
    // reattached, so the variable never keeps a stale secret name.
    const secrets = envDiff(base.secretEnv, next.secretEnv);
    const detach = [
      ...secrets.removed,
      ...secrets.changed.map(([envVar]) => envVar),
    ];
    for (const secretEnvName of detach) {
      await this.request("container_secret_remove", workspace, "", {
        container,
        secretEnvName,
      });
    }
    for (
      const [secretEnvName, secret] of [...secrets.added, ...secrets.changed]
    ) {
      await this.request("container_secret_add", workspace, "", {
        container,
        secretEnvName,
        secret,
      });
    }
    if (!pathsEqual(base.paths, next.paths)) {
      await this.request("container_path_set", workspace, "", {
        container,
        paths: [...next.paths],
      });
    }
    const ports = portDiff(base.ports, next.ports);
    for (const published of ports.removed) {
      await this.request("container_unpublish_port", workspace, "", {
        container,
        port: published.port,
        protocol: published.protocol,
      });
    }
    for (const published of ports.added) {
      await this.request("container_publish_port", workspace, "", {
        container,
        port: published.port,
        protocol: published.protocol,
        ...(published.suggestedHostPort > 0
          ? { suggestedHostPort: published.suggestedHostPort }
          : {}),
      });
    }
    // The recreate command is what carries a new image or environment. Every
    // other group is applied by the commands above, and a mount or a secret
    // environment variable recreates the container on its own, so the recreate
    // only runs when one of the two fields it applies changed.
    if (configNeedsRecreate(base, next)) {
      await this.request("recreate", workspace, next.image, {
        container,
        env: next.env,
      });
    }
  }

  inject(): ContainerCardFace {
    return {
      hooks: { containerCard: this.store },
      reload: () => {
        void this.reload();
      },
      dismissToast: () => {
        this.toast = null;
        this.publish();
      },
      remove: (workspace, container) =>
        this.command("remove", workspace, "", { container }),
      cleanCaches: (mode) =>
        this.command("cache_clean", "", "", { cacheMode: mode }),
      removeWorkspace: (workspace) =>
        this.command("workspace_remove", workspace, ""),
      recreate: (workspace, container, image, env) =>
        this.command("recreate", workspace, image, {
          container,
          ...(env ? { env } : {}),
        }),
      createContainer: (workspace, config) =>
        this.create(
          workspace.workspaceSlug,
          config?.image ?? (workspace.imageId || this.defaultImage() || ""),
          this.createExtra(config, { projectName: workspace.projectName }),
          config?.ports ?? [],
        ),
      startContainer: (workspace, container, config) =>
        this.create(
          workspace.workspaceSlug,
          config?.image ?? (workspace.imageId || this.defaultImage() || ""),
          this.createExtra(config, { container }),
          config?.ports ?? [],
        ),
      addContainerMount: (workspace, container, mount) =>
        this.command("container_mount_add", workspace, "", {
          container,
          mount,
        }),
      removeContainerMount: (workspace, container, mount) =>
        this.command("container_mount_remove", workspace, "", {
          container,
          mount,
        }),
      updateContainerMount: (workspace, container, mount) =>
        this.command("container_mount_update", workspace, "", {
          container,
          mount,
        }),
      setContainerPaths: (workspace, container, paths) =>
        this.command("container_path_set", workspace, "", { container, paths }),
      publishContainerPort: (workspace, container, port, suggestedHostPort) =>
        this.command("container_publish_port", workspace, "", {
          container,
          port,
          ...(suggestedHostPort ? { suggestedHostPort } : {}),
        }),
      unpublishContainerPort: (workspace, container, port, protocol) =>
        this.command("container_unpublish_port", workspace, "", {
          container,
          port,
          protocol,
        }),
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
      addContainerSecret: (workspace, container, envVar, secret) =>
        this.command("container_secret_add", workspace, "", {
          container,
          secretEnvName: envVar,
          secret,
        }),
      removeContainerSecret: (workspace, container, envVar) =>
        this.command("container_secret_remove", workspace, "", {
          container,
          secretEnvName: envVar,
        }),
      saveContainerEnv: (env) => {
        void this.scope.set("containerEnv", env);
      },
      applyDefaultEnv: (workspace) =>
        this.command("default_env_sync", workspace, ""),
      applyContainerConfig: (workspace, container, base, next) => {
        void this.applyConfig(workspace, container, base, next);
      },
    };
  }

  private defaultImage(): string {
    return this.scope.getSnapshot().value?.defaultImage ?? "";
  }
}

export type { ConfigFormSnapshot };
