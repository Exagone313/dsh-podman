// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { part } from "./approval.js";
import { defaultMountMode, mountKindToProto, mountModeToProto } from "./mount-enums.js";

// The mount kind for a call: an explicit non-empty `kind` wins, otherwise it is
// inferred from the source field the caller supplied (`secret`/`volume`), since
// `kind` is optional in the mount schemas. Falls back to a project mount.
export function inferMountKind(args: {
  kind?: unknown;
  project?: unknown;
  volume?: unknown;
  secret?: unknown;
}): string {
  if (typeof args.kind === "string" && args.kind !== "") return args.kind;
  if (typeof args.secret === "string" && args.secret !== "") return "secret";
  if (typeof args.volume === "string" && args.volume !== "") return "volume";
  return "project";
}

// The container-side destination a project mount always lands at: the project
// root under projectsRoot plus the optional subpath. The container never gets a
// caller-chosen destination for a project mount.
export function projectMountMirror(
  projectsRoot: string,
  project: string,
  path: unknown,
): string {
  return [projectsRoot, project, path]
    .filter((part) => typeof part === "string" && part !== "")
    .join("/");
}

// The reason to deny a mount item that carries a destination on a project (or
// unnamed) mount, or undefined when the item is allowed. Project mounts never
// take a destination; without one the directory lands at its project root.
export function projectMountDestinationReason(
  projectsRoot: string | undefined,
  args: {
    kind?: unknown;
    project?: unknown;
    path?: unknown;
    destination?: unknown;
  },
): string | undefined {
  if (inferMountKind(args) !== "project") return undefined;
  if (args.destination === undefined || args.destination === "") return undefined;
  const mirror =
    projectsRoot === undefined
      ? ""
      : projectMountMirror(
          projectsRoot,
          typeof args.project === "string" ? args.project : "",
          args.path,
        );
  return mirror === ""
    ? "destination is not supported for project mounts"
    : `destination is not supported for project mounts; the directory always mounts at ${mirror}`;
}

export function mountsFromInput(
  mounts: unknown,
  projectsRoot: string | undefined,
): Record<string, unknown>[] | undefined {
  if (!Array.isArray(mounts) || mounts.length === 0) return undefined;
  return mounts.map((mount: any) => {
    const inferredKind = inferMountKind(mount);
    const destinationReason = projectMountDestinationReason(projectsRoot, mount);
    if (destinationReason !== undefined) throw new Error(destinationReason);
    if (inferredKind === "secret" && mount.mode === "read_write") {
      throw new Error("secret mounts are read-only; omit mode or use read_only");
    }
    const kind = mountKindToProto(inferredKind);
    const mode = mountModeToProto(mount.mode ?? defaultMountMode(inferredKind));
    const result: Record<string, unknown> = { projectName: mount.project ?? "", kind, mode };
    if (mount.path) result.path = mount.path;
    if (inferredKind !== "project" && mount.destination) {
      result.destination = mount.destination;
    }
    if (mount.volume) result.volume = mount.volume;
    if (mount.secret) result.secret = mount.secret;
    return result;
  });
}
