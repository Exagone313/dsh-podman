// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { approvalPath, currentCwd } from "./guest-rpc.js";
import { inferMountKind, projectMountDestinationReason } from "./mount-input.js";
import { defaultMountMode } from "./mount-enums.js";
import { type ReadOnlyShellDecision } from "./read-only-shell.js";
import { TOOLS } from "./tool-schemas.js";
import {
  renderDenial,
  renderReason,
  type MountFact,
  type ReasonFact,
  type ReasonLocale,
} from "./approval-reasons.js";

// Build the mount fact for one mount object, or undefined when it names no
// source. `readOnly` is the mount's mode when the call carries one; omit it
// when the call does not (removal), so the reason names no mode.
function mountFact(
  mount: Record<string, unknown>,
  readOnly?: boolean,
): MountFact | undefined {
  const inferred = inferMountKind(mount);
  const kind: MountFact["kind"] =
    inferred === "volume" || inferred === "secret" || inferred === "tmpfs"
      ? inferred
      : "project";
  const destination =
    typeof mount.destination === "string" && mount.destination !== ""
      ? mount.destination
      : undefined;
  const source =
    kind === "tmpfs"
      ? ""
      : kind === "volume"
        ? typeof mount.volume === "string" ? mount.volume : ""
        : kind === "secret"
          ? typeof mount.secret === "string" ? mount.secret : ""
          : typeof mount.project === "string"
            ? mount.project
            : "";
  if (kind !== "tmpfs" && source === "") return undefined;
  return {
    kind,
    source,
    ...(destination === undefined ? {} : { destination }),
    ...(readOnly === undefined ? {} : { readOnly }),
  };
}

// Build the locale-independent reason fact for a gated call, or undefined when
// the arguments carry too little to describe the call.
export function reasonFact(
  name: string,
  args: Record<string, unknown>,
  sessionCwd?: unknown,
): ReasonFact | undefined {
  const str = (key: string): string | undefined =>
    typeof args[key] === "string" && args[key] !== "" ? (args[key] as string) : undefined;
  const listOf = (key: string): string[] | undefined => {
    const value = args[key];
    return Array.isArray(value) && value.length > 0
      ? value.map((item) => String(item))
      : undefined;
  };
  const mountItems = (): MountFact[] | undefined => {
    const value = args.mounts;
    if (!Array.isArray(value) || value.length === 0) return undefined;
    const items = value
      .map((item) => {
        if (typeof item !== "object" || item === null) return undefined;
        const mount = item as Record<string, unknown>;
        const mode =
          typeof mount.mode === "string" && mount.mode !== ""
            ? mount.mode
            : defaultMountMode(inferMountKind(mount));
        return mountFact(mount, mode !== "read_write");
      })
      .filter((item): item is MountFact => item !== undefined);
    return items.length === 0 ? undefined : items;
  };
  const mapKeys = (key: string): string[] | undefined => {
    const value = args[key];
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }
    const keys = Object.keys(value);
    return keys.length === 0 ? undefined : keys;
  };
  const envKeys = (): string[] | undefined => mapKeys("env");
  const numberListOf = (key: string): number[] | undefined => {
    const value = args[key];
    return Array.isArray(value) && value.length > 0
      ? value.map((item) => Number(item))
      : undefined;
  };
  // The optional process identity a tool may carry, shared by the tools that
  // can run a process as another user.
  const identityFact = (): { uid?: number; gid?: number; groups?: number[] } => {
    const uid = typeof args.uid === "number" ? args.uid : undefined;
    const gid = typeof args.gid === "number" ? args.gid : undefined;
    const groups = numberListOf("groups");
    return {
      ...(uid === undefined ? {} : { uid }),
      ...(gid === undefined ? {} : { gid }),
      ...(groups === undefined ? {} : { groups }),
    };
  };

  switch (name) {
    case "image_build": {
      const image = str("imageId");
      if (image === undefined) return undefined;
      const parent = str("parent");
      const packages = listOf("packages");
      return {
        kind: "image_build",
        image,
        ...(parent === undefined ? {} : { parent }),
        ...(packages === undefined ? {} : { packages }),
      };
    }
    case "image_rebuild": {
      const image = str("imageId");
      return image === undefined ? undefined : { kind: "image_rebuild", image };
    }
    case "image_rebuild_all":
      return { kind: "image_rebuild_all" };
    case "image_remove": {
      const image = str("imageId");
      return image === undefined ? undefined : { kind: "image_remove", image };
    }
    case "container_recreate":
    case "container_start": {
      const container = str("container");
      if (container === undefined) return undefined;
      const image = str("image");
      const mounts = mountItems();
      const env = envKeys();
      const secretEnv = mapKeys("secretEnv");
      const paths = listOf("paths");
      return {
        kind: name,
        container,
        ...(image === undefined ? {} : { image }),
        ...(mounts === undefined ? {} : { mounts }),
        ...(env === undefined ? {} : { env }),
        ...(secretEnv === undefined ? {} : { secretEnv }),
        ...(paths === undefined ? {} : { paths }),
      };
    }
    case "container_remove": {
      const container = str("container");
      return container === undefined ? undefined : { kind: "container_remove", container };
    }
    case "volume_remove": {
      const volume = str("name");
      return volume === undefined ? undefined : { kind: "volume_remove", name: volume };
    }
    case "secret_remove": {
      const secret = str("name");
      return secret === undefined ? undefined : { kind: "secret_remove", name: secret };
    }
    case "container_secret_add": {
      const container = str("container");
      const env = str("env");
      const secret = str("secret");
      if (container === undefined || env === undefined || secret === undefined) {
        return undefined;
      }
      return { kind: "container_secret_add", container, secret, env };
    }
    case "container_secret_remove": {
      const container = str("container");
      const env = str("env");
      if (container === undefined || env === undefined) return undefined;
      return { kind: "container_secret_remove", container, env };
    }
    case "container_mount_add":
    case "container_mount_remove":
    case "container_mount_update": {
      const container = str("container");
      if (container === undefined) return undefined;
      // Removal carries no mode, so its reason names none; add and update name
      // the mode the call asks for (add defaults it like the mount schema).
      const readOnly =
        name === "container_mount_remove"
          ? undefined
          : (typeof args.mode === "string" && args.mode !== ""
              ? args.mode
              : defaultMountMode(inferMountKind(args))) !== "read_write";
      const mount = mountFact(args, readOnly);
      if (mount === undefined) return undefined;
      return { kind: name, container, mount };
    }
    case "container_path_set": {
      const container = str("container");
      if (container === undefined) return undefined;
      const paths = Array.isArray(args.paths)
        ? args.paths.map((path) => String(path))
        : [];
      return { kind: "container_path_set", container, paths };
    }
    case "container_path_add":
    case "container_path_remove": {
      const container = str("container");
      const path = str("path");
      if (container === undefined || path === undefined) return undefined;
      return { kind: name, container, path };
    }
    case "container_bash": {
      const container = str("container");
      const command = str("command");
      if (container === undefined || command === undefined) return undefined;
      const cwd = str("workdir");
      return {
        kind: "container_bash",
        container,
        command,
        ...(cwd === undefined ? {} : { cwd }),
        ...identityFact(),
      };
    }
    case "container_exec": {
      const container = str("container");
      const argv = listOf("argv");
      if (container === undefined || argv === undefined) return undefined;
      const cwd = str("workdir");
      return {
        kind: "container_exec",
        container,
        argv,
        ...(cwd === undefined ? {} : { cwd }),
        ...identityFact(),
      };
    }
    case "container_write":
    case "container_edit": {
      const container = str("container");
      const path = str("file_path");
      if (container === undefined || path === undefined) return undefined;
      return { kind: name, container, path: approvalPath(path, sessionCwd) };
    }
    case "daemon_start": {
      const container = str("container");
      const argv = listOf("argv");
      if (container === undefined || argv === undefined) return undefined;
      const daemon = str("name");
      return {
        kind: "daemon_start",
        container,
        argv,
        ...(daemon === undefined ? {} : { name: daemon }),
        ...identityFact(),
      };
    }
    default:
      return undefined;
  }
}

// Build the single-line approval summary shown for a gated tool call.
//
// sessionCwd is used to name the resolved target of a relative path, so the
// prompt describes the file that will actually be touched. `locale` selects
// the language; it defaults to English.
export function summarizeArgs(
  name: string,
  args: Record<string, unknown>,
  sessionCwd?: unknown,
  locale: ReasonLocale = "en",
): string {
  const fact = reasonFact(name, args, sessionCwd);
  return fact === undefined ? "" : renderReason(locale, fact);
}

// The ask reason, omitted when no summary can be derived so the approval panel
// shows its own localized fallback instead of a blank headline (the panel only
// substitutes for a nullish reason, not an empty string).
function askReason(
  name: string,
  args: Record<string, unknown>,
  sessionCwd?: unknown,
  locale: ReasonLocale = "en",
): { reason?: string } {
  const reason = summarizeArgs(name, args, sessionCwd, locale);
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
  locale: ReasonLocale = "en",
): { kind: "ask"; reason?: string } | undefined {
  const tool = TOOLS.find((entry) => entry.name === name);
  if (tool === undefined) return undefined;
  if (tool.approval === true) {
    return { kind: "ask", ...askReason(name, args ?? {}, sessionCwd, locale) };
  }
  if (tool.approvalWhen !== undefined && tool.approvalWhen(args ?? {})) {
    return { kind: "ask", ...askReason(name, args ?? {}, sessionCwd, locale) };
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

// Every tool this plugin registers.
const OUR_TOOL_NAMES = new Set(TOOLS.map((tool) => tool.name));

// The harness's built-in tools that touch the container's filesystem or spawn
// processes in it. The harness fences these with its fs sandbox and its
// bash/pwsh sandbox executors, but this plugin replaces ctx.fs/ctx.subprocess
// and unwraps the landlock-run fence, so nothing else enforces read-only for
// them. Deny them here instead. `pwsh` exists only on Windows; the other
// built-ins that can reach the container (`subagent`, `workflow`, `ralph`)
// delegate to child agents that inherit the session's mode, so this policy
// already covers them.
const BUILTIN_FILE_TOOLS = new Set(["write", "edit", "bash", "pwsh"]);

// The session facts the policy needs. A session exposes no raw event array and
// its header only names the preset it STARTED with, so the caller reads these
// from the harness's own services (sandbox policy, approval policy, and the
// agent-preset projection).
export interface SessionFacts {
  /** Effective sandbox mode ("read-only", "workspace-write", …). */
  mode?: string;
  /** Effective approval policy ("ask", "never", …). */
  policy?: string;
  /** The preset the session currently runs. */
  preset?: string;
}

// The `tools/pre-execute` policy, driven by the session's permission knobs:
// - read-only sandbox: the built-in shell/file tools and their container
//   counterparts run only when the read-only shell gate allows them (every
//   mount is read-only); every other mutating tool is denied with a reason.
// - approval policy "never" (Full access): run without asking.
// - otherwise (Workspace Write): ask for the approval-gated tools, including
//   the tools the Podman operator-mode preset gates per preset.
export async function preExecutePolicy(
  exec: {
    name: string;
    arguments?: unknown;
    agent?: { session?: unknown };
  },
  next: () => Promise<unknown>,
  getProjectsRoot?: () => string,
  getLocale?: () => ReasonLocale,
  readSession?: (session: unknown) => SessionFacts,
  readOnlyShell?: (
    exec: unknown,
    locale: ReasonLocale,
  ) => Promise<ReadOnlyShellDecision>,
): Promise<unknown> {
  const name = exec.name;
  const locale = getLocale?.() ?? "en";
  const session = exec.agent?.session;
  const facts = session === undefined ? {} : readSession?.(session) ?? {};
  if (facts.mode === "read-only" && readOnlyShell !== undefined) {
    const gated = await readOnlyShell(exec, locale);
    // `allow` delegates so the rest of the pre-execute waterfall still runs.
    if (gated?.kind === "allow") return next();
    if (gated !== undefined) return gated;
  }
  if (facts.mode === "read-only" && BUILTIN_FILE_TOOLS.has(name)) {
    return {
      kind: "deny",
      reason: renderDenial(locale, { kind: "read_only_builtin", tool: name }),
    };
  }
  if (!OUR_TOOL_NAMES.has(name)) return next();
  if (facts.mode === "read-only") {
    if (READ_ONLY_TOOLS.has(name)) return next();
    return {
      kind: "deny",
      reason: renderDenial(locale, { kind: "read_only", tool: name }),
    };
  }
  const args = exec.arguments;
  const parsed =
    typeof args === "object" && args !== null ? (args as Record<string, unknown>) : undefined;
  const projectsRoot = getProjectsRoot?.();
  const denyReason = mountDestinationsReason(name, parsed, projectsRoot, locale);
  if (denyReason !== undefined) {
    return { kind: "deny", reason: denyReason };
  }
  if (facts.policy === "never") return next();
  const sessionCwd = currentCwd(exec);
  if (facts.preset === PODMAN_OPS_PRESET && PODMAN_OPS_APPROVAL_TOOLS.has(name)) {
    return { kind: "ask", ...askReason(name, parsed ?? {}, sessionCwd, locale) };
  }
  return approvalDecision(name, parsed, sessionCwd, locale) ?? next();
}

// The reason to deny a mount-bearing tool call that puts a destination on a
// project (or unnamed) mount, or undefined when the call is allowed. Checks the
// single-item tools (container_mount_add/remove) and the mounts arrays of
// container_start/container_recreate.
export function mountDestinationsReason(
  name: string,
  args: Record<string, unknown> | undefined,
  projectsRoot: string | undefined,
  locale: ReasonLocale = "en",
): string | undefined {
  if (args === undefined) return undefined;
  if (name === "container_mount_add" || name === "container_mount_remove" || name === "container_mount_update") {
    return projectMountDestinationReason(projectsRoot, args, locale);
  }
  if (name === "container_start" || name === "container_recreate") {
    const mounts = args.mounts;
    if (!Array.isArray(mounts)) return undefined;
    for (const item of mounts) {
      if (typeof item !== "object" || item === null) continue;
      const reason = projectMountDestinationReason(
        projectsRoot,
        item as Record<string, unknown>,
        locale,
      );
      if (reason !== undefined) return reason;
    }
  }
  return undefined;
}

// The harness's sandbox-escalation reason prefix. `approveEscalation` builds it
// as `escalate sandbox to <mode>: <justification>` in English regardless of the
// UI language (it is the asker's audit reason, not localized copy), and every
// escalating tool (bash, pwsh, the fs tools) goes through that one helper.
export const SANDBOX_ESCALATION_REASON_PREFIX = "escalate sandbox to ";

// Whether an approval request is the harness asking to widen the sandbox mode
// for one call. In this deployment the sandbox is bypassed inside the container
// (the plugin replaces ctx.subprocess/ctx.fs and unwraps the landlock-run
// fence), so the grant changes nothing and the prompt is noise. Matching the
// reason rather than the tool name keeps a real approval for the same tool
// from ever being claimed: if the wording changes, the prompt simply returns.
export function isSandboxEscalation(request: unknown): boolean {
  const reason = (request as { reason?: unknown } | undefined)?.reason;
  return (
    typeof reason === "string" &&
    reason.startsWith(SANDBOX_ESCALATION_REASON_PREFIX)
  );
}
