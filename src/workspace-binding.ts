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
    const key = workspaceSlug(String(workspace.id));
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
    const slug = workspaceSlug(String(workspace.id));
    const result = await this.control<any>("listContainers", {});
    const row = containerRowFor(result.containers ?? [], slug, container);
    if (row === undefined) {
      throw new Error(`container "${container}" not found in workspace`);
    }
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
    return binding;
  }
  private async ready(
    key: string,
    projectName: string,
  ): Promise<WorkspaceBinding> {
    let binding = await this.resolveBinding(key, projectName);
    try {
      await waitForReady(binding.guest);
    } catch {
      this.bindings.delete(key);
      binding = await this.resolveBinding(key, projectName);
      await waitForReady(binding.guest);
    }
    return binding;
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
    const controlMetadata = metadata(this.config.controlToken);
    let workspace: any;
    try {
      workspace = await unary<any>(control, "describeWorkspace", {
        workspaceSlug: slug,
      }, controlMetadata);
    } catch (error: any) {
      if (error.code !== grpc.status.NOT_FOUND) throw error;
      workspace = await unary<any>(control, "createWorkspace", {
        workspaceSlug: slug,
        projectName,
        imageId: this.config.defaultImage,
        mounts: [{ projectName, mode: "MOUNT_MODE_READ_WRITE" }],
      }, controlMetadata);
    }
    const socket = workspace.agentSocketPath as string;
    return {
      guest: guestClient(socket),
      token: workspace.agentToken as string,
      socket,
    };
  }
  async control<T>(method: string, request: unknown): Promise<T> {
    return unary<T>(
      controlClient(join(this.config.socketsRoot, "orchestrator.sock")),
      method,
      request,
      metadata(this.config.controlToken),
    );
  }
}

// The harness's missing-path code (`FsErrorCode` `'FS_NOT_FOUND'`, raised by
// the local backend for a nonexistent path). A path outside every workspace is
// not part of any container's filesystem, so callers must see it as absent:
// agent-instructions' project-root walk probes ancestors above the workspace
// and only continues when this code comes back.
function notFoundError(message: string): Error {
  const error = new Error(message);
  (error as { code?: string }).code = "FS_NOT_FOUND";
  return error;
}

function waitForReady(agent: grpc.Client): Promise<void> {
  return new Promise((resolve, reject) => {
    agent.waitForReady(Date.now() + 15000, (error) =>
      error ? reject(error) : resolve(),
    );
  });
}

export function workspaceSlug(session: unknown): string {
  const value =
    typeof session === "string"
      ? session
      : ((session as any)?.workspace?.name ??
        (session as any)?.workspaceName ??
        (session as any)?.projectName ??
        (session as any)?.id ??
        "default");
  const raw = String(value);
  const parts = raw.split(/[\\/]+/);
  const safe = parts.includes("..")
    ? parts.filter((part) => part !== "." && part !== "..").join("-") ||
      "default"
    : raw;
  return (
    safe
      .replace(/[^a-zA-Z0-9_.-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, fifty) || "default"
  );
}
const fifty = 50;
export function containerRowFor(
  containers: any[],
  slug: string,
  container: string,
): any | undefined {
  return containers.find(
    (row: any) =>
      row.workspaceSlug === slug && row.containerName === container,
  );
}
export function metadata(token: string): grpc.Metadata {
  const result = new grpc.Metadata();
  if (token !== "") {
    result.set("authorization", `bearer ${token}`);
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
    const base = `${projectsRoot}/${mount.projectName}`;
    const destination = mount.path ? `${base}/${mount.path}` : base;
    return path === destination || path.startsWith(`${destination}/`);
  });
}

// isProjectMount reports whether a proto mount is a project mount. An unset
// kind is the project default.
function isProjectMount(mount: any): boolean {
  const kind = mount?.kind;
  return kind === undefined || kind === "" || kind === "MOUNT_KIND_PROJECT";
}
