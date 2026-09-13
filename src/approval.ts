// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { approvalPath, currentCwd } from "./guest-rpc.js";
import { inferMountKind, projectMountDestinationReason } from "./mount-input.js";
import { TOOLS } from "./tool-schemas.js";

// Join top-level parts of an approval reason. List elements within a part
// (packages, mounts) stay comma-joined instead.
export const part = (...items: (string | undefined)[]): string =>
  items.filter((item) => item !== undefined && item !== "").join(" • ");

// Join list elements, capping at 8 with a "+N more" tail.
const LIST_CAP = 8;

function list(items: readonly unknown[], format: (item: unknown) => string): string {
  if (items.length === 0) return "";
  const shown = items.slice(0, LIST_CAP).map(format);
  const extra = items.length - LIST_CAP;
  return extra > 0 ? [...shown, `+${extra} more`].join(", ") : shown.join(", ");
}

// Render a project mount path "team" or "team/src" from project + optional path.
function projectPath(project: string, path?: string): string {
  if (path === undefined || path === "") return project;
  return `${project}/${path.replace(/^\/+/, "")}`;
}

// Render a mount's mode suffix: "(ro)" for read_only, nothing for read_write.
function mountMode(mode: unknown): string {
  return mode === "read_only" ? " (ro)" : "";
}

// Summarize the mount source for container_mount_add/remove.
function mountTarget(args: Record<string, unknown>): string {
  switch (inferMountKind(args)) {
    case "volume":
      return typeof args.volume === "string" ? `volume ${args.volume}` : "";
    case "tmpfs":
      return "tmpfs";
    case "secret":
      return typeof args.secret === "string" ? `secret ${args.secret}` : "";
    default:
      return typeof args.project === "string" ? `directory ${projectPath(args.project, typeof args.path === "string" ? args.path : undefined)}` : "";
  }
}

// Render a single mount item, e.g. "team/src (ro)" or "volume valkey-data → /data".
function replaceMountItem(mount: Record<string, unknown>): string {
  const kind = typeof mount.kind === "string" ? mount.kind : "";
  const destination =
    typeof mount.destination === "string" && mount.destination !== ""
      ? mount.destination
      : undefined;
  const mode = mountMode(mount.mode);
  if (kind === "volume") {
    const volume = typeof mount.volume === "string" ? mount.volume : "";
    if (volume === "") return "";
    return `volume ${volume}${destination === undefined ? "" : ` → ${destination}`}${mode}`;
  }
  if (kind === "tmpfs") {
    return `tmpfs${destination === undefined ? "" : ` at ${destination}`}${mode}`;
  }
  if (kind === "secret") {
    const secret = typeof mount.secret === "string" ? mount.secret : "";
    if (secret === "") return "";
    return `secret ${secret}${destination === undefined ? "" : ` → ${destination}`}${mode}`;
  }
  const project = typeof mount.project === "string" ? mount.project : "";
  if (project === "") return "";
  const path = typeof mount.path === "string" ? mount.path : undefined;
  const item = destination === undefined
    ? projectPath(project, path)
    : `${projectPath(project, path)} → ${destination}`;
  return item + mode;
}

// Build the single-line approval summary shown for a gated tool call.
//
// sessionCwd is used to name the resolved target of a relative path, so the
// prompt describes the file that will actually be touched.
export function summarizeArgs(
  name: string,
  args: Record<string, unknown>,
  sessionCwd?: unknown,
): string {
  const str = (key: string): string | undefined =>
    typeof args[key] === "string" && args[key] !== "" ? (args[key] as string) : undefined;
  const count = (key: string): string | undefined => {
    const value = args[key];
    return Array.isArray(value) && value.length > 0 ? String(value.length) : undefined;
  };
  const listOf = (key: string): string | undefined => {
    const value = args[key];
    if (!Array.isArray(value) || value.length === 0) return undefined;
    return list(value, (item) => String(item));
  };
  const mounts = (): string | undefined => {
    const value = args.mounts;
    if (!Array.isArray(value) || value.length === 0) return undefined;
    const items = value.map((item) =>
      typeof item === "object" && item !== null
        ? replaceMountItem(item as Record<string, unknown>)
        : "",
    ).filter((item) => item !== "");
    if (items.length === 0) return undefined;
    const shown = items.slice(0, LIST_CAP);
    const beyond = items.length - LIST_CAP;
    return beyond > 0 ? `${shown.join(", ")}, +${beyond} more` : shown.join(", ");
  };
  const envKeys = (): string | undefined => {
    const value = args.env;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }
    const keys = Object.keys(value);
    if (keys.length === 0) return undefined;
    return list(keys, (key) => String(key));
  };

  switch (name) {
    case "image_build": {
      const image = str("imageId");
      const parent = str("parent");
      const packages = listOf("packages");
      if (image === undefined) return "";
      const phrase = `build image ${image}${parent === undefined ? "" : ` from ${parent}`}`;
      return part(
        phrase,
        packages === undefined ? undefined : `packages: ${packages}`,
      );
    }
    case "image_rebuild": {
      const image = str("imageId");
      return image === undefined ? "" : `rebuild image ${image}`;
    }
    case "image_rebuild_all":
      return "rebuild all images";
    case "image_remove": {
      const image = str("imageId");
      return image === undefined ? "" : `remove image ${image}`;
    }
    case "container_recreate": {
      const container = str("container");
      const image = str("image");
      const mountItems = mounts();
      const env = envKeys();
      if (container === undefined) return "";
      const phrase = `recreate container ${container}${image === undefined ? "" : ` with ${image}`}`;
      return part(
        phrase,
        mountItems === undefined ? undefined : `mounts: ${mountItems}`,
        env === undefined ? undefined : `env: ${env}`,
      );
    }
    case "container_remove": {
      const container = str("container");
      return container === undefined ? "" : `remove container ${container}`;
    }
    case "container_start": {
      const container = str("container");
      const image = str("image");
      const mountItems = mounts();
      const env = envKeys();
      if (container === undefined) return "";
      const phrase = `start container ${container}${image === undefined ? "" : ` with ${image}`}`;
      return part(
        phrase,
        mountItems === undefined ? undefined : `mounts: ${mountItems}`,
        env === undefined ? undefined : `env: ${env}`,
      );
    }
    case "volume_remove": {
      const name = str("name");
      return name === undefined ? "" : `remove volume ${name}`;
    }
    case "secret_remove": {
      const name = str("name");
      return name === undefined ? "" : `remove secret ${name}`;
    }
    case "container_secret_add": {
      const container = str("container");
      const env = str("env");
      const secret = str("secret");
      if (container === undefined || env === undefined || secret === undefined) {
        return "";
      }
      return `container ${container}: add secret ${secret} as ${env}`;
    }
    case "container_secret_remove": {
      const container = str("container");
      const env = str("env");
      if (container === undefined || env === undefined) return "";
      return `container ${container}: remove secret ${env}`;
    }
    case "container_mount_add":
    case "container_mount_remove": {
      const container = str("container");
      const target = mountTarget(args);
      const destination = str("destination");
      const verb = name === "container_mount_add" ? "mount" : "unmount";
      if (container === undefined || target === "") return "";
      const suffix = destination === undefined ? "" : ` at ${destination}`;
      return `container ${container}: ${verb} ${target}${suffix}${name === "container_mount_add" ? mountMode(args.mode) : ""}`;
    }
    case "container_bash": {
      const container = str("container");
      const command = str("command");
      if (container === undefined || command === undefined) return "";
      return `run shell in container ${container}: ${command}`;
    }
    case "container_exec": {
      const container = str("container");
      const argv = args.argv;
      if (container === undefined || !Array.isArray(argv) || argv.length === 0) return "";
      const words = argv.map((word) => String(word)).slice(0, 8);
      const tail = argv.length > 8 ? " …" : "";
      return `run in container ${container}: ${words.join(" ")}${tail}`;
    }
    case "container_write": {
      const container = str("container");
      const path = str("file_path");
      if (container === undefined || path === undefined) return "";
      return `write ${approvalPath(path, sessionCwd)} in container ${container}`;
    }
    case "container_edit": {
      const container = str("container");
      const path = str("file_path");
      if (container === undefined || path === undefined) return "";
      return `edit ${approvalPath(path, sessionCwd)} in container ${container}`;
    }
    case "daemon_start": {
      const container = str("container");
      const argv = args.argv;
      if (container === undefined || !Array.isArray(argv) || argv.length === 0) return "";
      const named = str("name");
      const words = argv.map((word) => String(word)).slice(0, 8);
      const tail = argv.length > 8 ? " …" : "";
      const command = `${named === undefined ? "" : ` ${named}`}`;
      const uid = typeof args.uid === "number" ? String(args.uid) : undefined;
      const gid = typeof args.gid === "number" ? String(args.gid) : undefined;
      return part(
        `start daemon${command} in container ${container}: ${words.join(" ")}${tail}`,
        uid === undefined ? undefined : `uid: ${uid}`,
        gid === undefined ? undefined : `gid: ${gid}`,
      );
    }
    default:
      return "";
  }
}

// The ask reason, omitted when no summary can be derived so the approval panel
// shows its own localized fallback instead of a blank headline (the panel only
// substitutes for a nullish reason, not an empty string).
function askReason(
  name: string,
  args: Record<string, unknown>,
  sessionCwd?: unknown,
): { reason?: string } {
  const reason = summarizeArgs(name, args, sessionCwd);
  return reason === "" ? {} : { reason };
}

// Decide whether a tool call needs approval. DSH resolves an `ask` decision
// through its approval service (`ctx.get("approval").request(...)`), showing
// the standard approval prompt; without one the call fails closed.
// Approval is per tool, optionally conditional on the call's arguments via a
// tool's `approvalWhen` predicate (e.g. container_start only asks when project
// mounts are supplied).
export function approvalDecision(
  name: string,
  args?: Record<string, unknown>,
  sessionCwd?: unknown,
): { kind: "ask"; reason?: string } | undefined {
  const tool = TOOLS.find((entry) => entry.name === name);
  if (tool === undefined) return undefined;
  if (tool.approval === true) {
    return { kind: "ask", ...askReason(name, args ?? {}, sessionCwd) };
  }
  if (tool.approvalWhen !== undefined && tool.approvalWhen(args ?? {})) {
    return { kind: "ask", ...askReason(name, args ?? {}, sessionCwd) };
  }
  return undefined;
}

// Tools that only read or list and remain safe under a read-only permission.
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "image_list",
  "image_get",
  "container_list",
  "container_read",
  "container_glob",
  "container_grep",
  "container_mount_list",
  "volume_list",
  "secret_list",
  "daemon_list",
  "daemon_logs",
]);

// The agent preset id this plugin ships ("Podman operator mode"). Tools in
// PODMAN_OPS_APPROVAL_TOOLS are gated behind approval only for agents composed
// from this preset, so it can "do other things" (run commands, edit container
// files, start daemons) once the user approves.
export const PODMAN_OPS_PRESET = "podman-ops";

// Tools the Podman operator-mode preset keeps available but approval-gated.
export const PODMAN_OPS_APPROVAL_TOOLS: ReadonlySet<string> = new Set([
  "container_bash",
  "container_exec",
  "container_write",
  "container_edit",
  "daemon_start",
]);

// Every tool this plugin registers, so the permission policy only gates its
// own tools and delegates DSH-native ones (bash, write, ...) to the harness.
const OUR_TOOL_NAMES = new Set(TOOLS.map((tool) => tool.name));

// Fold the session's effective sandbox mode (last `sandbox/mode` wins).
export function foldSandboxMode(
  events: readonly { type: string; data?: { mode?: string } }[],
): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === "sandbox/mode") return event.data?.mode;
  }
  return undefined;
}

// Fold the session's effective approval policy (last `approval/policy` wins).
export function foldApprovalPolicy(
  events: readonly { type: string; data?: { policy?: string } }[],
): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === "approval/policy") return event.data?.policy;
  }
  return undefined;
}

// The `tools/pre-execute` policy, driven by the session's permission knobs:
// - read-only sandbox: only READ_ONLY_TOOLS run; every other plugin tool is
//   denied with a reason. DSH-native tools are delegated so their own sandbox
//   policy applies.
// - approval policy "never" (Full access): run without asking.
// - otherwise (Workspace Write): ask for the approval-gated tools, including
//   the tools the Podman operator-mode preset gates per preset.
export async function preExecutePolicy(
  exec: {
    name: string;
    arguments?: unknown;
    agent?: {
      session?: {
        header?: { agentPreset?: string };
        events?: readonly { type: string; data?: { mode?: string; policy?: string } }[];
      };
    };
  },
  next: () => Promise<unknown>,
  getProjectsRoot?: () => string,
): Promise<unknown> {
  const name = exec.name;
  if (!OUR_TOOL_NAMES.has(name)) return next();
  const events = exec.agent?.session?.events ?? [];
  if (foldSandboxMode(events) === "read-only") {
    if (READ_ONLY_TOOLS.has(name)) return next();
    return {
      kind: "deny",
      reason: `tool "${name}" requires a writable permission (current: read-only)`,
    };
  }
  const args = exec.arguments;
  const parsed =
    typeof args === "object" && args !== null ? (args as Record<string, unknown>) : undefined;
  const projectsRoot = getProjectsRoot?.();
  const denyReason = mountDestinationsReason(name, parsed, projectsRoot);
  if (denyReason !== undefined) {
    return { kind: "deny", reason: denyReason };
  }
  if (foldApprovalPolicy(events) === "never") return next();
  const preset = exec.agent?.session?.header?.agentPreset;
  const sessionCwd = currentCwd(exec);
  if (preset === PODMAN_OPS_PRESET && PODMAN_OPS_APPROVAL_TOOLS.has(name)) {
    return { kind: "ask", ...askReason(name, parsed ?? {}, sessionCwd) };
  }
  return approvalDecision(name, parsed, sessionCwd) ?? next();
}

// The reason to deny a mount-bearing tool call that puts a destination on a
// project (or unnamed) mount, or undefined when the call is allowed. Checks the
// single-item tools (container_mount_add/remove) and the mounts arrays of
// container_start/container_recreate.
export function mountDestinationsReason(
  name: string,
  args: Record<string, unknown> | undefined,
  projectsRoot: string | undefined,
): string | undefined {
  if (args === undefined) return undefined;
  if (name === "container_mount_add" || name === "container_mount_remove") {
    return projectMountDestinationReason(projectsRoot, args);
  }
  if (name === "container_start" || name === "container_recreate") {
    const mounts = args.mounts;
    if (!Array.isArray(mounts)) return undefined;
    for (const item of mounts) {
      if (typeof item !== "object" || item === null) continue;
      const reason = projectMountDestinationReason(projectsRoot, item as Record<string, unknown>);
      if (reason !== undefined) return reason;
    }
  }
  return undefined;
}
