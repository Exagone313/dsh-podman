// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { mountKindRank } from "./mount-enums.js";

// Whether a mount is the workspace's primary project mount: a project mount
// that names the workspace's own project. The container editor lists that mount
// first and a template exported from the container starts with it, so both read
// this one predicate rather than each deciding for itself.
export function isPrimaryProjectMount(
  mount: { kind: string; project?: string },
  mainProject: string,
): boolean {
  return mount.kind === "project" && mainProject !== "" &&
    mount.project === mainProject;
}

// The mount fields an ordered list reads. The editor draft's MountInput and a
// template's TemplateMountInput both satisfy it, so the editor and the template
// preview share one ordering without either importing the other's module.
export interface OrderedMount {
  kind: string;
  project: string;
  destination: string;
  mode: string;
}

// The category a mount sorts under in an ordered mounts list: the workspace's
// main project mount first, then read-write projects, read-only projects,
// read-write volumes, read-only volumes, secrets and tmpfs. The kind order comes
// from MOUNT_KIND_ORDER, which the template renderer uses too, and the primary
// project mount is the one predicate both list and export use, so the list and
// an exported template never disagree on which mount comes first.
function mountRank(mount: OrderedMount, mainProject: string): number {
  if (isPrimaryProjectMount(mount, mainProject)) return 0;
  const kind = mountKindRank(mount.kind);
  // Only projects and volumes have a mode to split by; a secret and a tmpfs
  // carry one fixed mode, so their single slot leaves a gap that changes
  // nothing.
  const mode = mount.kind === "project" || mount.kind === "volume"
    ? (mount.mode === "read_write" ? 0 : 1)
    : 0;
  return 1 + kind * 2 + mode;
}

// The mounts in the one order both the editors and a container block list them
// in: one category at a time, sorted by mounted path inside the category. Each
// entry keeps the index it has in the draft, so an edit or a removal still
// targets the entry behind the row.
export function orderedMounts<T extends OrderedMount>(
  mounts: readonly T[],
  mainProject: string,
): { mount: T; index: number }[] {
  return mounts
    .map((mount, index) => ({ mount, index }))
    .sort((left, right) => {
      const rank = mountRank(left.mount, mainProject) -
        mountRank(right.mount, mainProject);
      if (rank !== 0) return rank;
      // A stable sort keeps the draft order inside a category when two mounts
      // share a destination.
      const a = left.mount.destination;
      const b = right.mount.destination;
      return a < b ? -1 : a > b ? 1 : 0;
    });
}
