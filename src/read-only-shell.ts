// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { currentCwd, sessionWorkspaceSlug } from "./guest-rpc.js";
import { mountKindFromProto, mountKindToProto } from "./mount-enums.js";
import {
  renderDenial,
  renderReason,
  type MountFact,
  type ReasonLocale,
} from "./approval-reasons.js";
import { type WorkspaceResolver } from "./workspace-binding.js";

// The synthetic tool name the read-only remount prompt is raised under. The
// `dsh_podman_builtin_` prefix is reserved for plugin-raised prompts about
// built-in operations, so the browser panel can recognise them without
// mistaking a real tool for one.
export const REMOUNT_TOOL_NAME = "dsh_podman_builtin_remount_read_only";

// The tools the read-only gate covers: the built-in shell and file tools, and
// the plugin's counterparts plus daemons (everything that would otherwise be
// denied by read-only and can run or write through the container's mounts).
export const READ_ONLY_GATED_TOOLS: ReadonlySet<string> = new Set([
  "bash",
  "pwsh",
  "write",
  "edit",
  "container_bash",
  "container_exec",
  "container_write",
  "container_edit",
  "daemon_start",
]);

export type ReadOnlyShellDecision =
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  | undefined;

// A control-plane mount as the container API reports it.
interface ContainerMount {
  projectName?: unknown;
  kind?: unknown;
  mode?: unknown;
  destination?: unknown;
  volume?: unknown;
  secret?: unknown;
}

// The read-only shell gate: under read-only permission, the covered tools run
// once every mount that carries a mode is read-only. Otherwise the user is
// asked (through `approve`) to remount the read-write mounts read-only; on
// approval the container is recreated with the read-only list and the tool runs.
export function createReadOnlyShellGate(deps: {
  resolver: WorkspaceResolver;
  approve: (exec: any, reason: string) => Promise<boolean>;
}): (exec: any, locale: ReasonLocale) => Promise<ReadOnlyShellDecision> {
  return async (exec, locale) => {
    const name = String(exec?.name ?? "");
    if (!READ_ONLY_GATED_TOOLS.has(name)) return undefined;
    const container = containerOf(exec);
    const state = await readContainerMounts(deps.resolver, exec, container);
    // An unreadable container falls through to the caller's plain denial: the
    // gate never widens access it could not verify.
    if (state === undefined) return undefined;
    const remount = state.mounts.filter(
      (mount) => carriesMode(mount.kind) && mount.mode !== "MOUNT_MODE_READ_ONLY",
    );
    if (remount.length === 0) return { kind: "allow" };
    const keep = state.mounts.filter((mount) => !remount.includes(mount));
    const reason = renderReason(locale, {
      kind: "read_only_remount",
      tool: name,
      remount: remount.map(mountFactOf),
      keep: keep.map(mountFactOf),
    });
    if (!(await deps.approve(exec, reason))) {
      return {
        kind: "deny",
        reason: renderDenial(locale, {
          kind: "read_only_remount_declined",
          tool: name,
        }),
      };
    }
    await remountReadOnly(deps.resolver, exec, container, state.mounts);
    return { kind: "allow" };
  };
}

// The logical container a tool call targets: its `container` argument for the
// plugin's tools, the default container for the built-in ones.
function containerOf(exec: any): string {
  const container = exec?.arguments?.container;
  return typeof container === "string" && container !== "" ? container : "default";
}

// Whether a mount kind carries a mode: project and volume mounts do; tmpfs is
// always read-write and secret mounts take none.
function carriesMode(kind: unknown): boolean {
  return (
    kind === undefined ||
    kind === "" ||
    kind === "MOUNT_KIND_PROJECT" ||
    kind === "MOUNT_KIND_VOLUME"
  );
}

// readContainerMounts resolves the workspace and returns the target container's
// mounts, or undefined when the container cannot be read.
async function readContainerMounts(
  resolver: WorkspaceResolver,
  exec: any,
  container: string,
): Promise<{ slug: string; mounts: ContainerMount[] } | undefined> {
  try {
    const slug = await sessionWorkspaceSlug(resolver, currentCwd(exec));
    const result = await resolver.control<{ containers?: any[] }>(
      "listContainers",
      {},
    );
    const row = (result.containers ?? []).find(
      (candidate: any) =>
        candidate.workspaceSlug === slug &&
        candidate.containerName === container,
    );
    if (row === undefined) return undefined;
    return { slug, mounts: (row.mounts ?? []) as ContainerMount[] };
  } catch {
    return undefined;
  }
}

// remountReadOnly recreates the container with every project and volume mount
// read-only; tmpfs stays read-write and secrets carry no mode. One recreate
// replaces the whole list, so the mounts never pass through an inconsistent
// state.
async function remountReadOnly(
  resolver: WorkspaceResolver,
  exec: any,
  container: string,
  mounts: readonly ContainerMount[],
): Promise<void> {
  await resolver.control("recreateContainer", {
    workspaceSlug: await sessionWorkspaceSlug(resolver, currentCwd(exec)),
    container,
    mounts: mounts.map(readOnlyMountRequest),
  });
}

// readOnlyMountRequest maps a stored mount onto the control plane's mount
// message with the mode forced read-only.
function readOnlyMountRequest(mount: ContainerMount): Record<string, unknown> {
  const kind = mountKindFromProto(
    typeof mount.kind === "string" ? mount.kind : undefined,
  );
  const request: Record<string, unknown> = {
    projectName: typeof mount.projectName === "string" ? mount.projectName : "",
    kind: mountKindToProto(kind),
  };
  if (carriesMode(mount.kind)) request.mode = "MOUNT_MODE_READ_ONLY";
  else if (kind === "tmpfs") request.mode = "MOUNT_MODE_READ_WRITE";
  if (typeof mount.destination === "string" && mount.destination !== "") {
    request.destination = mount.destination;
  }
  if (typeof mount.volume === "string" && mount.volume !== "") {
    request.volume = mount.volume;
  }
  if (typeof mount.secret === "string" && mount.secret !== "") {
    request.secret = mount.secret;
  }
  return request;
}

// mountFactOf renders one stored mount as an approval reason fact.
function mountFactOf(mount: ContainerMount): MountFact {
  const resolved = mountKindFromProto(
    typeof mount.kind === "string" ? mount.kind : undefined,
  );
  const kind: MountFact["kind"] =
    resolved === "volume" || resolved === "secret" || resolved === "tmpfs"
      ? resolved
      : "project";
  const destination =
    typeof mount.destination === "string" && mount.destination !== ""
      ? mount.destination
      : undefined;
  const source =
    kind === "volume"
      ? String(mount.volume ?? "")
      : kind === "secret"
        ? String(mount.secret ?? "")
        : kind === "tmpfs"
          ? ""
          : String(mount.projectName ?? "");
  return {
    kind,
    source,
    ...(destination === undefined ? {} : { destination }),
    readOnly: mount.mode === "MOUNT_MODE_READ_ONLY",
  };
}
