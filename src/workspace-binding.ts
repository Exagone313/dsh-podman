import {
  agentClient,
  controlClient,
  grpc,
  unary,
} from "./grpc/runtime-client.js";

export interface WorkspaceBinding {
  agent: grpc.Client;
  token: string;
  socket: string;
}
export interface BindingConfig {
  controlSocket: string;
  defaultImage: string;
  projectsRoot: string;
}

export class WorkspaceResolver {
  private readonly bindings = new Map<string, Promise<WorkspaceBinding>>();
  constructor(
    private readonly config: BindingConfig,
    private readonly registry: any,
  ) {}
  async resolve(cwd: unknown): Promise<WorkspaceBinding> {
    const workspace = await this.registry?.resolveByPath?.(String(cwd));
    if (workspace === undefined) {
      throw new Error(
        `no DH workspace owns session cwd ${JSON.stringify(cwd)}`,
      );
    }
    const relativePath = String(workspace.path).replace(
      `${this.config.projectsRoot}/`,
      "",
    );
    const key = workspaceSlug(String(workspace.id));
    return this.resolveBinding(key, relativePath);
  }
  resolveSlug(key: string): Promise<WorkspaceBinding> {
    return this.resolveBinding(key, key);
  }
  private resolveBinding(
    key: string,
    projectName: string,
  ): Promise<WorkspaceBinding> {
    let binding = this.bindings.get(key);
    if (binding === undefined) {
      binding = this.create(key, projectName);
      this.bindings.set(key, binding);
    }
    return binding;
  }
  private async create(
    slug: string,
    projectName: string,
  ): Promise<WorkspaceBinding> {
    const control = controlClient(this.config.controlSocket);
    let workspace: any;
    try {
      workspace = await unary<any>(control, "describeWorkspace", {
        workspaceSlug: slug,
      });
    } catch (error: any) {
      if (error.code !== grpc.status.NOT_FOUND) throw error;
      workspace = await unary<any>(control, "createWorkspace", {
        workspaceSlug: slug,
        imageId: this.config.defaultImage,
        mounts: [{ projectName, mode: "MOUNT_MODE_READ_WRITE" }],
      });
    }
    const socket = workspace.agentSocketPath as string;
    return {
      agent: agentClient(socket),
      token: workspace.agentToken as string,
      socket,
    };
  }
  async control<T>(method: string, request: unknown): Promise<T> {
    return unary<T>(controlClient(this.config.controlSocket), method, request);
  }
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
export function metadata(token: string): grpc.Metadata {
  const result = new grpc.Metadata();
  result.set("authorization", `bearer ${token}`);
  return result;
}
