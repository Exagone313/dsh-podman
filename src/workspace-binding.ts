// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import {
  guestClient,
  controlClient,
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
}
export interface BindingConfig {
  socketsRoot: string;
  defaultImage: string;
  projectsRoot: string;
  controlToken: string;
  // Bound on the guest-agent readiness wait, in milliseconds. Defaults to 15s.
  readyTimeoutMs?: number;
}

export class WorkspaceResolver {
  private readonly bindings = new Map<string, Promise<WorkspaceBinding>>();
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
  async resolve(cwd: unknown): Promise<WorkspaceBinding> {
    const workspace = await this.workspaceForCwd(cwd);
    const relativePath = String(workspace.path).replace(
      `${this.config.projectsRoot}/`,
      "",
    );
    const key = workspaceSlug(workspace.id);
    const binding = await this.ready(key, relativePath);
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
  async resolveForPath(path: string, cwd: unknown): Promise<WorkspaceBinding> {
    if (typeof cwd === "string" && cwd !== "") return this.resolve(cwd);
    if (isAbsolute(path)) {
      const workspace = this.containingWorkspace(path);
      if (workspace !== undefined) return this.resolve(String(workspace.path));
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
  resolveSlug(key: string): Promise<WorkspaceBinding> {
    return this.ready(key, key);
  }
  async containerBinding(
    cwd: unknown,
    container: string,
  ): Promise<WorkspaceBinding> {
    const workspace = await this.workspaceForCwd(cwd);
    const slug = workspaceSlug(workspace.id);
    const row = await this.ensureContainer(slug, container);
    const socket = row.agentSocketPath as string;
    const binding: WorkspaceBinding = {
      guest: guestClient(socket),
      token: row.agentToken as string,
      socket,
    };
    const session = defaultCwdOf(cwd);
    if (
      session !== undefined &&
      projectMountCovers(this.config.projectsRoot, row.mounts ?? [], session)
    ) {
      binding.defaultCwd = session;
    }
    await this.ensureReady(binding, slug, container);
    return binding;
  }
  // ready resolves a workspace's default container and waits for its guest
  // agent, recreating the container once when it is reported running but its
  // agent never answers (a crashed agent or a lost socket).
  private async ready(
    key: string,
    projectName: string,
  ): Promise<WorkspaceBinding> {
    let binding = await this.resolveBinding(key, projectName);
    try {
      await waitForReady(binding.guest, this.readyTimeoutMs());
    } catch {
      this.bindings.delete(key);
      binding = await this.resolveBinding(key, projectName);
      try {
        await waitForReady(binding.guest, this.readyTimeoutMs());
      } catch {
        await this.recoverContainer(key, "default");
        this.bindings.delete(key);
        binding = await this.resolveBinding(key, projectName);
        await waitForReady(binding.guest, this.readyTimeoutMs());
      }
    }
    return binding;
  }
  private readyTimeoutMs(): number {
    const configured = Number(this.config.readyTimeoutMs);
    return Number.isFinite(configured) && configured > 0 ? configured : 15000;
  }
  // ensureReady waits for one binding's guest agent and recovers the container
  // once when the wait fails.
  private async ensureReady(
    binding: WorkspaceBinding,
    slug: string,
    container: string,
  ): Promise<void> {
    try {
      await waitForReady(binding.guest, this.readyTimeoutMs());
      return;
    } catch {
      // Recover below.
    }
    await this.recoverContainer(slug, container);
    await waitForReady(binding.guest, this.readyTimeoutMs());
  }
  // recoverContainer best-effort recreates a container whose agent is
  // unreachable. A failure here is not fatal: the caller's retry surfaces the
  // real readiness failure.
  private async recoverContainer(slug: string, container: string): Promise<void> {
    try {
      await this.control("recreateContainer", {
        workspaceSlug: slug,
        container,
      });
    } catch {
      // Best-effort.
    }
  }
  private resolveBinding(
    key: string,
    projectName: string,
  ): Promise<WorkspaceBinding> {
    let binding = this.bindings.get(key);
    if (binding === undefined) {
      binding = this.create(key, projectName).catch((error: unknown) => {
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
  ): Promise<WorkspaceBinding> {
    const control = controlClient(
      join(this.config.socketsRoot, "orchestrator.sock"),
    );
    const controlMetadata = metadata(this.config.controlToken, VERSION);
    try {
      await unary<any>(control, "describeWorkspace", {
        workspaceSlug: slug,
      }, controlMetadata);
    } catch (error: any) {
      if (error.code !== grpc.status.NOT_FOUND) throw error;
      await unary<any>(control, "createWorkspace", {
        workspaceSlug: slug,
        projectName,
        imageId: this.config.defaultImage,
        mounts: [{ projectName, mode: "MOUNT_MODE_READ_WRITE" }],
      }, controlMetadata);
    }
    const row = await this.ensureContainer(slug, "default");
    const socket = row.agentSocketPath as string;
    return {
      guest: guestClient(socket),
      token: row.agentToken as string,
      socket,
    };
  }
  // ensureContainer asks the orchestrator for a usable container, recreating it
  // when it is missing, stopped, or runs a guest agent from an outdated image,
  // and returns its row. A container the orchestrator does not know is reported
  // as the caller's missing container.
  private async ensureContainer(slug: string, container: string): Promise<any> {
    try {
      return await this.control("ensureContainer", {
        workspaceSlug: slug,
        container,
      });
    } catch (error: any) {
      if (error.code !== grpc.status.NOT_FOUND) throw error;
      throw containerNotFound(container, slug);
    }
  }
  async control<T>(method: string, request: unknown): Promise<T> {
    return unary<T>(
      controlClient(join(this.config.socketsRoot, "orchestrator.sock")),
      method,
      request,
      metadata(this.config.controlToken, VERSION),
    );
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
  const message = raw.replace(/^\d+\s+[A-Z_]+:\s*/, "");
  const code = (error as { code?: unknown }).code;
  const name =
    typeof code === "number"
      ? (grpc.status as unknown as Record<number, string>)[code]
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
