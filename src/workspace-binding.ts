// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import {
  guestClient,
  controlClient,
  closeClients,
  grpc,
  unary,
} from "./grpc/runtime-client.js";
import { isAbsolute, join } from "node:path";
import { VERSION } from "./generated/version.js";

export interface WorkspaceBinding {
  guest: grpc.Client;
  token: string;
  socket: string;
  // The session working directory to use when a command tool is not given an
  // explicit one, or undefined when it is not mounted in the container.
  defaultCwd?: string;
  // refresh re-resolves the binding, dropping any cached credential. A caller
  // that sees the agent reject its token retries once against a refreshed
  // binding instead of failing the turn. Absent on test doubles.
  refresh?: () => Promise<WorkspaceBinding>;
}
export interface BindingConfig {
  socketsRoot: string;
  defaultImage: string;
  projectsRoot: string;
  controlToken: string;
  // Bound on the guest-agent readiness wait, in milliseconds. Defaults to 15s.
  readyTimeoutMs?: number;
}

// The control calls that change a container's mount set or recreate it. A
// successful call invalidates the cached binding for that container (or for
// every container of a removed workspace), because the cached mounts decide
// whether the session directory is exposed as the container's default cwd.
const CONTAINER_MUTATIONS: Record<string, "container" | "workspace"> = {
  startContainer: "container",
  recreateContainer: "container",
  removeContainer: "container",
  addContainerMount: "container",
  removeContainerMount: "container",
  updateContainerMount: "container",
  addContainerSecret: "container",
  removeContainerSecret: "container",
  removeWorkspace: "workspace",
};

export class WorkspaceResolver {
  private readonly bindings = new Map<string, Promise<WorkspaceBinding>>();
  // Named containers get their own cache, keyed by "<slug>:<logical name>", so
  // resolving one does not re-run ensureContainer, rebuild a gRPC channel, and
  // wait for readiness on every tool call.
  private readonly containerBindings = new Map<
    string,
    Promise<{ binding: WorkspaceBinding; mounts: readonly any[] }>
  >();
  constructor(
    private readonly config: BindingConfig,
    private readonly registry: any,
  ) {}
  setConfig(patch: Partial<BindingConfig>): void {
    Object.assign(this.config, patch);
  }
  getConfig(): Readonly<BindingConfig> {
    return this.config;
  }
  // dispose closes every cached gRPC channel and drops the cached bindings.
  // Called when the plugin is disposed so a reload does not leak unix sockets.
  dispose(): void {
    this.bindings.clear();
    this.containerBindings.clear();
    closeClients();
  }
  // forgetContainer drops the cached binding for one named container, so the
  // next call re-resolves its row and picks up a changed mount set.
  forgetContainer(slug: string, container: string): void {
    this.containerBindings.delete(`${slug}:${container}`);
  }
  // forgetWorkspace drops every cached container binding of one workspace, so
  // a removed (or recreated) workspace cannot serve stale rows.
  forgetWorkspace(slug: string): void {
    const prefix = `${slug}:`;
    for (const key of [...this.containerBindings.keys()]) {
      if (key.startsWith(prefix)) this.containerBindings.delete(key);
    }
  }
  async resolve(cwd: unknown, signal?: AbortSignal): Promise<WorkspaceBinding> {
    const workspace = await this.workspaceForCwd(cwd);
    const key = workspaceSlug(workspace.id);
    const projectName = projectNameForPath(this.config.projectsRoot, workspace.path);
    const binding = await this.ready(key, projectName, signal);
    // The default container always keeps its project mount, so the session
    // directory is always mounted in it.
    const session = defaultCwdOf(cwd);
    return session === undefined ? binding : { ...binding, defaultCwd: session };
  }
  // Resolve the workspace binding for a filesystem path when the caller did not
  // supply a session working directory. The 0.1.5 `fs.resolve` contract allows
  // `{ signal }` alone, and the workspace that CONTAINS the path is the only
  // sensible owner, so match it by longest canonical-path prefix. A path
  // outside every workspace is not in any container's filesystem, so it is
  // reported as missing rather than failing the caller.
  async resolveForPath(
    path: string,
    cwd: unknown,
    signal?: AbortSignal,
  ): Promise<WorkspaceBinding> {
    if (typeof cwd === "string" && cwd !== "") return this.resolve(cwd, signal);
    if (isAbsolute(path)) {
      const workspace = this.containingWorkspace(path);
      if (workspace !== undefined) {
        return this.resolve(String(workspace.path), signal);
      }
      throw notFoundError(`no DH workspace contains path ${JSON.stringify(path)}`);
    }
    throw new Error(
      `cannot resolve a DH workspace for path ${JSON.stringify(path)}; pass a session working directory`,
    );
  }
  private containingWorkspace(path: string): any | undefined {
    const entries: any[] = this.registry?.list?.() ?? [];
    let match: any | undefined;
    for (const workspace of entries) {
      const root = workspace?.path;
      if (typeof root !== "string" || root === "") continue;
      if (path !== root && !path.startsWith(`${root}/`)) continue;
      if (match === undefined || root.length > String(match.path).length) {
        match = workspace;
      }
    }
    return match;
  }
  private async workspaceForCwd(cwd: unknown): Promise<any> {
    if (typeof cwd !== "string" || cwd === "") {
      throw new Error(
        `cannot resolve a DH workspace without a session working directory (got ${JSON.stringify(cwd)})`,
      );
    }
    const workspace = await this.registry?.resolveByPath?.(cwd);
    if (workspace === undefined) {
      throw new Error(`no DH workspace owns session cwd ${JSON.stringify(cwd)}`);
    }
    return workspace;
  }
  resolveSlug(key: string, signal?: AbortSignal): Promise<WorkspaceBinding> {
    return this.ready(key, key, signal);
  }
  async containerBinding(
    cwd: unknown,
    container: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceBinding> {
    const workspace = await this.workspaceForCwd(cwd);
    const slug = workspaceSlug(workspace.id);
    const key = `${slug}:${container}`;
    let entry = await this.resolveContainerBinding(slug, container, key, signal);
    try {
      entry = {
        binding: await this.ensureAgentReady(entry.binding),
        mounts: entry.mounts,
      };
    } catch {
      this.containerBindings.delete(key);
      await this.recoverContainer(slug, container, signal);
      entry = await this.resolveContainerBinding(slug, container, key, signal);
      entry = {
        binding: await this.ensureAgentReady(entry.binding),
        mounts: entry.mounts,
      };
    }
    const session = defaultCwdOf(cwd);
    if (
      session !== undefined &&
      projectMountCovers(this.config.projectsRoot, entry.mounts, session)
    ) {
      return { ...entry.binding, defaultCwd: session };
    }
    return entry.binding;
  }
  // resolveContainerBinding returns the cached promise for a named container,
  // creating it once. It deliberately stops at an "ensureContainer + build a
  // binding" step: readiness is per-call, so a credential refresh can never
  // recurse through this path.
  private resolveContainerBinding(
    slug: string,
    container: string,
    key: string,
    signal?: AbortSignal,
  ): Promise<{ binding: WorkspaceBinding; mounts: readonly any[] }> {
    let entry = this.containerBindings.get(key);
    if (entry === undefined) {
      entry = this.buildContainerBinding(slug, container, key).catch(
        (error: unknown) => {
          if (this.containerBindings.get(key) === entry) {
            this.containerBindings.delete(key);
          }
          throw error;
        },
      );
      this.containerBindings.set(key, entry);
    }
    return entry;
  }
  private async buildContainerBinding(
    slug: string,
    container: string,
    key: string,
  ): Promise<{ binding: WorkspaceBinding; mounts: readonly any[] }> {
    const row = await this.ensureContainer(slug, container);
    // refresh re-resolves the container row and swaps the cache entry, so a
    // binding whose token rotated is not re-served from the stale cache.
    const refresh = (): Promise<WorkspaceBinding> => {
      const next = this.buildContainerBinding(slug, container, key);
      this.containerBindings.set(key, next);
      return next.then((fresh) => fresh.binding);
    };
    return { binding: this.bindingFor(row, refresh), mounts: row.mounts ?? [] };
  }
  // ready resolves a workspace's default container and waits for its guest
  // agent, recreating the container once when it is reported running but its
  // agent never answers (a crashed agent or a lost socket).
  private async ready(
    key: string,
    projectName: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceBinding> {
    let binding = await this.resolveBinding(key, projectName, signal);
    try {
      return await this.ensureAgentReady(binding);
    } catch {
      this.bindings.delete(key);
      binding = await this.resolveBinding(key, projectName, signal);
      try {
        return await this.ensureAgentReady(binding);
      } catch {
        await this.recoverContainer(key, "default", signal);
        this.bindings.delete(key);
        binding = await this.resolveBinding(key, projectName, signal);
        return await this.ensureAgentReady(binding);
      }
    }
  }
  private readyTimeoutMs(): number {
    const configured = Number(this.config.readyTimeoutMs);
    return Number.isFinite(configured) && configured > 0 ? configured : 15000;
  }
  // bindingFor builds a binding from an orchestrator container row. refresh
  // re-resolves it, so a caller can retry once after the agent rejects a token
  // that went stale (the plugin caches bindings for its lifetime).
  private bindingFor(
    row: any,
    refresh: () => Promise<WorkspaceBinding>,
  ): WorkspaceBinding {
    const socket = row.agentSocketPath as string;
    return {
      guest: guestClient(socket),
      token: row.agentToken as string,
      socket,
      refresh,
    };
  }
  // ensureAgentReady waits for the agent and verifies the credential with a
  // Ping. A rejected credential is refreshed once (re-resolving the binding,
  // which re-runs the orchestrator's ensure) and re-verified, so a token that
  // rotated after the binding was cached does not fail the caller.
  private async ensureAgentReady(
    binding: WorkspaceBinding,
  ): Promise<WorkspaceBinding> {
    await waitForReady(binding.guest, this.readyTimeoutMs());
    try {
      await pingAgent(binding);
      return binding;
    } catch (error) {
      if (
        (error as { code?: unknown })?.code !== grpc.status.UNAUTHENTICATED ||
        binding.refresh === undefined
      ) {
        throw error;
      }
      const refreshed = await binding.refresh();
      await waitForReady(refreshed.guest, this.readyTimeoutMs());
      await pingAgent(refreshed);
      return refreshed;
    }
  }
  // recoverContainer best-effort recreates a container whose agent is
  // unreachable. A failure here is not fatal: the caller's retry surfaces the
  // real readiness failure.
  private async recoverContainer(
    slug: string,
    container: string,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      await this.control("recreateContainer", {
        workspaceSlug: slug,
        container,
      }, signal);
    } catch {
      // Best-effort.
    }
  }
  private resolveBinding(
    key: string,
    projectName: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceBinding> {
    let binding = this.bindings.get(key);
    if (binding === undefined) {
      binding = this.create(key, projectName, signal).catch((error: unknown) => {
        if (this.bindings.get(key) === binding) this.bindings.delete(key);
        throw error;
      });
      this.bindings.set(key, binding);
    }
    return binding;
  }
  private async create(
    slug: string,
    projectName: string,
    signal?: AbortSignal,
  ): Promise<WorkspaceBinding> {
    const control = controlClient(
      join(this.config.socketsRoot, "orchestrator.sock"),
    );
    const controlMetadata = metadata(this.config.controlToken, VERSION);
    try {
      await unary<any>(control, "describeWorkspace", {
        workspaceSlug: slug,
      }, controlMetadata, signal);
    } catch (error: any) {
      if (error.code !== grpc.status.NOT_FOUND) throw error;
      await unary<any>(control, "createWorkspace", {
        workspaceSlug: slug,
        projectName,
        imageId: this.config.defaultImage,
        mounts: [{ projectName, mode: "MOUNT_MODE_READ_WRITE" }],
      }, controlMetadata, signal);
    }
    const row = await this.ensureContainer(slug, "default", signal);
    return this.bindingFor(row, () => {
      this.bindings.delete(slug);
      return this.resolveBinding(slug, projectName);
    });
  }
  // ensureContainer asks the orchestrator for a usable container, recreating it
  // when it is missing, stopped, or runs a guest agent from an outdated image,
  // and returns its row. A container the orchestrator does not know is reported
  // as the caller's missing container.
  private async ensureContainer(
    slug: string,
    container: string,
    signal?: AbortSignal,
  ): Promise<any> {
    try {
      return await this.control("ensureContainer", {
        workspaceSlug: slug,
        container,
      }, signal);
    } catch (error: any) {
      if (error.code !== grpc.status.NOT_FOUND) throw error;
      throw containerNotFound(container, slug);
    }
  }
  async control<T>(
    method: string,
    request: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const result = await unary<T>(
      controlClient(join(this.config.socketsRoot, "orchestrator.sock")),
      method,
      request,
      metadata(this.config.controlToken, VERSION),
      signal,
    );
    this.invalidateAfter(method, request);
    return result;
  }
  // invalidateAfter drops the cached bindings a successful mutation invalidated.
  // Only reachable after the call resolved, so a failed mutation keeps the
  // warm entry it did not change.
  private invalidateAfter(method: string, request: unknown): void {
    const scope = CONTAINER_MUTATIONS[method];
    if (scope === undefined) return;
    const fields = (typeof request === "object" && request !== null
      ? request
      : {}) as { workspaceSlug?: unknown; container?: unknown };
    const slug =
      typeof fields.workspaceSlug === "string" ? fields.workspaceSlug : "";
    if (slug === "") return;
    if (scope === "workspace") {
      this.forgetWorkspace(slug);
      return;
    }
    const container =
      typeof fields.container === "string" ? fields.container : "";
    if (container === "") return;
    this.forgetContainer(slug, container);
  }
}

// notFoundError builds the harness's missing-path error (`FsErrorCode`
// `'FS_NOT_FOUND'`). A path outside every workspace is not part of any
// container's filesystem, so callers must see it as absent: agent-instructions'
// project-root walk probes ancestors above the workspace and only continues
// when this code comes back.
function notFoundError(message: string): Error {
  const error = new Error(message);
  (error as { code?: string }).code = "FS_NOT_FOUND";
  return error;
}

// containerNotFound is the one not-found shape every container tool reports.
export function containerNotFound(container: string, slug?: string): Error {
  const error = new Error(
    slug === undefined
      ? `container ${JSON.stringify(container)} not found`
      : `container ${JSON.stringify(container)} not found in workspace ${JSON.stringify(slug)}`,
  );
  (error as { code?: string }).code = "NOT_FOUND";
  return error;
}

// normalizeToolError gives every tool failure one shape: a message without
// grpc's "<code> <NAME>: " prefix, and a string `code` (the grpc status name
// when the error carried one) so callers can branch without parsing text.
export function normalizeToolError(error: unknown): Error {
  const raw = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown }).code;
  const numericCode = typeof code === "number" ? code : undefined;
  // Only a real gRPC status renders the "<code> <NAME>: " prefix; a plain
  // message that merely looks like one must stay intact.
  const message =
    numericCode === undefined ? raw : raw.replace(/^\d+\s+[A-Z_]+:\s*/, "");
  const name =
    numericCode !== undefined
      ? (grpc.status as unknown as Record<number, string>)[numericCode]
      : typeof code === "string"
        ? code
        : undefined;
  const normalized = new Error(message);
  if (name !== undefined) (normalized as { code?: string }).code = name;
  return normalized;
}

function waitForReady(agent: grpc.Client, timeoutMs = 15000): Promise<void> {
  return new Promise((resolve, reject) => {
    agent.waitForReady(Date.now() + timeoutMs, (error) =>
      error ? reject(error) : resolve(),
    );
  });
}

// pingAgent makes the guest readiness call, which also exercises the credential
// (the agent's auth interceptor guards every call, Ping included). Unlike
// waitForReady, which only proves connectivity, it fails when the token is
// rejected — which is exactly what a rotated credential looks like.
function pingAgent(binding: WorkspaceBinding): Promise<void> {
  return new Promise((resolveDone, reject) => {
    (binding.guest as any).ping(
      {},
      metadata(binding.token),
      (error: Error | null) => (error ? reject(error) : resolveDone()),
    );
  });
}

// workspaceSlug validates the workspace id that names this workspace's pod
// (dsh-podman-<slug>) and containers (dsh-podman-<slug>-<logical>). It must be
// a UUID so a container name can never collide with a pod name.
export function workspaceSlug(id: unknown): string {
  const value = String(id ?? "");
  if (!UUID_PATTERN.test(value)) {
    throw new Error(
      `invalid workspace id ${JSON.stringify(value)}: expected a UUID`,
    );
  }
  return value.toLowerCase();
}
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// metadata builds the call metadata. The plugin version is sent on control
// calls so the orchestrator can refuse an incompatible plugin; guest calls omit
// it, since the guest agent does not check it.
export function metadata(token: string, pluginVersion?: string): grpc.Metadata {
  const result = new grpc.Metadata();
  if (token !== "") {
    result.set("authorization", `bearer ${token}`);
  }
  if (pluginVersion !== undefined && pluginVersion !== "") {
    result.set("x-dsh-podman-plugin-version", pluginVersion);
  }
  return result;
}

// defaultCwdOf returns the session working directory as a usable container
// path, or undefined when it is unset.
function defaultCwdOf(cwd: unknown): string | undefined {
  return typeof cwd === "string" && cwd !== "" ? cwd : undefined;
}

// projectNameForPath maps a dsh workspace's host path to the project path a
// mount stores: the path relative to the projects root. It is a prefix test,
// not a String.replace, so a root that appears later in the path cannot corrupt
// the name, and a workspace outside the root fails with a clear error instead
// of silently producing an absolute "project name".
function projectNameForPath(projectsRoot: string, path: unknown): string {
  const root = String(projectsRoot ?? "").replace(/\/+$/, "");
  const value = String(path ?? "").replace(/\/+$/, "");
  if (root === "" || value === root) return "";
  if (!value.startsWith(`${root}/`)) {
    throw new Error(
      `workspace path ${JSON.stringify(value)} is not under the projects root ${JSON.stringify(root)}`,
    );
  }
  return value.slice(root.length + 1);
}

// projectMountCovers reports whether a project mount of a container makes the
// given container path reachable: the mount destination itself or a path below
// it.
function projectMountCovers(
  projectsRoot: string,
  mounts: readonly any[],
  path: string,
): boolean {
  return mounts.some((mount) => {
    if (!isProjectMount(mount)) return false;
    const destination = `${projectsRoot}/${mount.projectName}`;
    return path === destination || path.startsWith(`${destination}/`);
  });
}

// isProjectMount reports whether a proto mount is a project mount. An unset
// kind is the project default.
function isProjectMount(mount: any): boolean {
  const kind = mount?.kind;
  return kind === undefined || kind === "" || kind === "MOUNT_KIND_PROJECT";
}
