// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// What a mount row offers beside its source field, per kind. A project path is
// browsed for on the host; a volume or a secret is created from the row itself
// because the settings storages may not hold one yet; tmpfs mounts no source, so
// its row offers nothing.

import { normalizeMountKind } from "../mount-enums.js";
import type { MountInput } from "./card-protocol.js";
import type { Translation } from "./locales.js";

export type MountSourceAffordance =
  | "browse"
  | "create-volume"
  | "create-secret"
  | "none";

// The one affordance a kind gets. An unknown kind reads as a project mount,
// exactly like normalizeMountKind, so a decoded row cannot end up with none.
export function mountSourceAffordance(kind: unknown): MountSourceAffordance {
  switch (normalizeMountKind(kind)) {
    case "project":
      return "browse";
    case "volume":
      return "create-volume";
    case "secret":
      return "create-secret";
    default:
      return "none";
  }
}

// Whether a creation affordance is refused: the snapshot must let the workspace
// write and no command may be in flight, the same gates the settings storage
// tab applies to its own Create actions.
export function mountSourceCreationDisabled(
  writable: boolean,
  busy: boolean,
): boolean {
  return !writable || busy;
}

// Whether a mount row offers Browse among its own actions rather than beside
// its source field: only an editor row for a project mount whose caller
// threaded a host directory browser down to it. The container block and the
// editor dialogs pass none, so their rows keep exactly the actions they had.
export function mountRowBrowseOffered(
  mode: "view" | "edit",
  kind: unknown,
  onProjectBrowse: (() => void) | undefined,
): boolean {
  return mode === "edit" &&
    normalizeMountKind(kind) === "project" &&
    onProjectBrowse !== undefined;
}

// Whether a row's Browse is disabled: the row's own gate, a read-only workspace
// or a command in flight, the same gates the row's other write actions carry.
export function mountRowBrowseDisabled(
  disabled: boolean,
  writable: boolean,
  busy: boolean,
): boolean {
  return disabled || !writable || busy;
}

// The source a row adopts after a create succeeds, before the refreshed snapshot
// lists it. An empty name clears the source again, which is how a refused create
// restores what the row carried before. A kind without a source — project,
// tmpfs — adopts nothing.
export function createdMountSource(
  kind: unknown,
  name: string,
): Partial<MountInput> | undefined {
  switch (normalizeMountKind(kind)) {
    case "volume":
      return { volume: name };
    case "secret":
      return { secret: name };
    default:
      return undefined;
  }
}

// The draft a volume or secret mount adopts when its source is still empty: the
// first listed storage of that kind. A picker with a non-empty list renders no
// "" option, so the browser would show the first entry while the draft stayed
// empty and Add stayed disabled. Preselecting it stores what the field shows.
// Every other kind, a draft that already carries a value — including one the
// snapshot no longer lists — and an empty list are returned untouched.
export function withPreselectedStorageSource(
  draft: MountInput,
  volumes: readonly { name: string }[],
  secrets: readonly { name: string }[],
): MountInput {
  switch (normalizeMountKind(draft.kind)) {
    case "volume": {
      const first = volumes[0];
      return draft.volume === "" && first !== undefined
        ? { ...draft, volume: first.name }
        : draft;
    }
    case "secret": {
      const first = secrets[0];
      return draft.secret === "" && first !== undefined
        ? { ...draft, secret: first.name }
        : draft;
    }
    default:
      return draft;
  }
}

// What a refused create restores: the source the row carried before it adopted
// the created name. Nothing is restored when the row no longer carries that
// name, so a selection the user changed in the meantime is never clobbered.
export function revertCreatedMountSource(
  current: Pick<MountInput, "kind" | "volume" | "secret">,
  created: string,
  previous: string,
): Partial<MountInput> | undefined {
  const value = normalizeMountKind(current.kind) === "volume"
    ? current.volume
    : current.secret;
  return value === created
    ? createdMountSource(current.kind, previous)
    : undefined;
}

// The reserved container paths this client checks itself: /tmp, which podman
// mounts as the writable tmpfs the guest file API reaches, and the projects
// root, which is reserved for project mounts. The sockets root and the guest
// agent's mount stay server-enforced.
const TMPFS_ROOT = "/tmp";

// withTrailingSlash returns path with a trailing separator, so a prefix
// comparison matches whole path components. A path that already ends in one,
// the filesystem root included, is returned unchanged. Plain string operations:
// this module is bundled for the browser, so node:path is not available.
function withTrailingSlash(path: string): string {
  return path.endsWith("/") ? path : `${path}/`;
}

// pathsOverlap reports whether two absolute POSIX paths are equal or whether
// either contains the other, mirroring the orchestrator's nonProjectDestination.
function pathsOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(withTrailingSlash(b)) ||
    b.startsWith(withTrailingSlash(a));
}

// A refused destination, as data rather than a translated string: the locale
// key to show, plus the reserved path it overlaps when that is the reason. The
// container form hands the same shape to its footer.
export interface MountDestinationRejection {
  ok: false;
  key:
    | "mountDestinationRequired"
    | "mountDestinationAbsolute"
    | "mountDestinationClean"
    | "mountDestinationReserved";
  params?: { path: string };
}

export type MountDestinationCheck = { ok: true } | MountDestinationRejection;

// validateMountDestination checks a volume, secret or tmpfs destination the way
// the orchestrator does, minus the paths only the server knows: it must be
// non-empty, absolute and already POSIX-clean (no ".." or "." segment, no
// doubled separator, no trailing slash), and it must not be, contain or sit
// inside /tmp or the container projects root. Project mounts derive their
// destination from the project path and are never checked here.
export function validateMountDestination(
  destination: string,
  projectsRoot: string,
): MountDestinationCheck {
  if (destination === "") {
    return { ok: false, key: "mountDestinationRequired" };
  }
  if (!destination.startsWith("/")) {
    return { ok: false, key: "mountDestinationAbsolute" };
  }
  // "/" is its own clean form; the overlap check refuses it as an ancestor of
  // /tmp, exactly as the orchestrator does.
  if (
    destination !== "/" &&
    (destination.endsWith("/") ||
      destination.includes("//") ||
      destination
        .slice(1)
        .split("/")
        .some((segment) => segment === "." || segment === ".."))
  ) {
    return { ok: false, key: "mountDestinationClean" };
  }
  // The projects root is empty before the snapshot arrives, and a deployment
  // may configure none; only an absolute root can reserve a container path.
  for (const reserved of [TMPFS_ROOT, projectsRoot]) {
    if (reserved === "" || !reserved.startsWith("/")) continue;
    if (pathsOverlap(destination, reserved)) {
      return {
        ok: false,
        key: "mountDestinationReserved",
        params: { path: reserved },
      };
    }
  }
  return { ok: true };
}

// The untranslated reason a non-project mount destination is refused, or
// undefined when it is acceptable. A project mount derives its destination, and
// an unknown kind reads as a project mount like normalizeMountKind, so neither
// is checked.
export function nonProjectDestinationError(
  kind: unknown,
  destination: string,
  projectsRoot: string,
): Translation | undefined {
  if (normalizeMountKind(kind) === "project") return undefined;
  const check = validateMountDestination(destination, projectsRoot);
  if (check.ok) return undefined;
  return check.params === undefined
    ? { key: check.key }
    : { key: check.key, params: check.params };
}

// The first refused destination among a form's mounts, in list order, so the
// footer names the row that has to be fixed first.
export function firstMountDestinationError(
  mounts: readonly Pick<MountInput, "kind" | "destination">[],
  projectsRoot: string,
): Translation | undefined {
  for (const mount of mounts) {
    const error = nonProjectDestinationError(
      mount.kind,
      mount.destination,
      projectsRoot,
    );
    if (error !== undefined) return error;
  }
  return undefined;
}

export interface MountSourceOptions {
  // Whether the selected name is absent from the listed storages, so the row
  // has to carry it itself until the refreshed snapshot includes it.
  missing: boolean;
  // Every value the select offers, the still-unlisted selected name first.
  names: readonly string[];
}

// The options a volume or secret picker offers: the listed names, and the name
// the row already carries when the snapshot does not know it yet. That keeps a
// just-created source selected instead of replacing it with the first candidate.
export function mountSourceOptions(
  selected: string,
  storages: readonly { name: string }[],
): MountSourceOptions {
  const names = storages.map((storage) => storage.name);
  const missing = selected !== "" && !names.includes(selected);
  return { missing, names: missing ? [selected, ...names] : names };
}
