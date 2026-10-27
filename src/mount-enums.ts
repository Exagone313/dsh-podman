// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

const MOUNT_KINDS: Record<string, string> = {
  project: "MOUNT_KIND_PROJECT",
  tmpfs: "MOUNT_KIND_TMPFS",
  volume: "MOUNT_KIND_VOLUME",
  secret: "MOUNT_KIND_SECRET",
};

const MOUNT_MODES: Record<string, string> = {
  read_only: "MOUNT_MODE_READ_ONLY",
  read_write: "MOUNT_MODE_READ_WRITE",
};

const KIND_FROM_PROTO: Record<string, string> = {
  MOUNT_KIND_PROJECT: "project",
  MOUNT_KIND_TMPFS: "tmpfs",
  MOUNT_KIND_VOLUME: "volume",
  MOUNT_KIND_SECRET: "secret",
};

// The order the container editor's mounts list shows the kinds in: project
// mounts first, then volumes, secrets and tmpfs. The list further splits
// projects and volumes by mode, and the container-template renderer uses this
// kind order alone, keeping the existing sequence within a kind.
export const MOUNT_KIND_ORDER = [
  "project",
  "volume",
  "secret",
  "tmpfs",
] as const;

// mountKindRank returns a kind's position in MOUNT_KIND_ORDER. An unknown kind
// sorts last instead of throwing, since callers also rank values decoded from
// layers this module does not control.
export function mountKindRank(kind: string): number {
  const index = MOUNT_KIND_ORDER.indexOf(
    kind as (typeof MOUNT_KIND_ORDER)[number],
  );
  return index === -1 ? MOUNT_KIND_ORDER.length : index;
}

// The logical names and the proto enum numbers a mount kind can decode to. A
// value reaches a layer in one of several spellings — the enum name with or
// without its MOUNT_KIND_ prefix, the short name, or the number a decoder that
// renders enums as integers produces — so normalisation is table-driven rather
// than inferred from which source field happens to be filled.
const MOUNT_KIND_NAMES: Record<string, string> = {
  project: "project",
  tmpfs: "tmpfs",
  volume: "volume",
  secret: "secret",
};

const MOUNT_KIND_NUMBERS: Record<number, string> = {
  1: "project",
  2: "tmpfs",
  3: "volume",
  4: "secret",
};

const MOUNT_MODE_NAMES: Record<string, string> = {
  read_only: "read_only",
  read_write: "read_write",
};

const MOUNT_MODE_NUMBERS: Record<number, string> = {
  1: "read_only",
  2: "read_write",
};

const MODE_FROM_PROTO: Record<string, string> = {
  MOUNT_MODE_READ_ONLY: "read_only",
  MOUNT_MODE_READ_WRITE: "read_write",
};

export function mountKindToProto(kind: string | undefined): string {
  if (kind === undefined) return "MOUNT_KIND_PROJECT";
  const proto = Object.prototype.hasOwnProperty.call(MOUNT_KINDS, kind)
    ? MOUNT_KINDS[kind]
    : undefined;
  if (proto === undefined) throw new Error(`unknown mount kind: ${kind}`);
  return proto;
}

/**
 * The mount mode to use when a caller does not name one.
 *
 * Adding a mount should not grant write access nobody asked for, so every kind
 * defaults to read-only. tmpfs is the exception: its contents are per-container
 * scratch space and the orchestrator rejects a read-only one outright.
 */
export function defaultMountMode(kind: string | undefined): string {
  return kind === "tmpfs" ? "read_write" : "read_only";
}

/**
 * The mode a mount kind is fixed to, or undefined when the caller chooses.
 *
 * A tmpfs is scratch space and the orchestrator rejects a read-only one; a
 * secret is exposed read-only and carries no mode at all. Project and volume
 * mounts are the ones a caller may switch.
 */
export function forcedMountMode(kind: string | undefined): string | undefined {
  if (kind === "tmpfs") return "read_write";
  if (kind === "secret") return "read_only";
  return undefined;
}

export function mountModeToProto(mode: string | undefined): string {
  const proto = mode !== undefined &&
      Object.prototype.hasOwnProperty.call(MOUNT_MODES, mode)
    ? MOUNT_MODES[mode]
    : undefined;
  if (proto === undefined) throw new Error(`unknown mount mode: ${mode}`);
  return proto;
}

/** The logical mount kind for a proto enum value, or undefined when unspecified. */
export function mountKindFromProto(
  proto: string | undefined,
): string | undefined {
  if (proto === undefined) return undefined;
  return Object.prototype.hasOwnProperty.call(KIND_FROM_PROTO, proto)
    ? KIND_FROM_PROTO[proto]
    : undefined;
}

/** The logical mount mode for a proto enum value, or undefined when unspecified. */
export function mountModeFromProto(
  proto: string | undefined,
): string | undefined {
  if (proto === undefined) return undefined;
  return Object.prototype.hasOwnProperty.call(MODE_FROM_PROTO, proto)
    ? MODE_FROM_PROTO[proto]
    : undefined;
}

// lookupNormalized resolves a value against one short-name table and one enum
// number table, accepting either a string (short or prefixed enum name, or a
// numeric string) or a number. Anything unrecognised uses the fallback, so an
// unknown enum number can never be read as a different kind by accident.
function lookupNormalized(
  value: unknown,
  names: Record<string, string>,
  numbers: Record<number, string>,
  prefix: string,
  fallback: string,
): string {
  if (typeof value === "number") return numbers[value] ?? fallback;
  if (typeof value !== "string") return fallback;
  const short = value.startsWith(prefix)
    ? value.slice(prefix.length).toLowerCase()
    : value.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(names, short)) return names[short];
  const numeric = Number(value);
  if (value !== "" && Number.isInteger(numeric)) {
    return numbers[numeric] ?? fallback;
  }
  return fallback;
}

/**
 * The logical mount kind for any spelling a decode can produce: the short name,
 * the enum name with or without its MOUNT_KIND_ prefix, its numeric string, or
 * the enum number. An unspecified or unknown kind reads as a project mount.
 */
export function normalizeMountKind(kind: unknown): string {
  return lookupNormalized(
    kind,
    MOUNT_KIND_NAMES,
    MOUNT_KIND_NUMBERS,
    "MOUNT_KIND_",
    "project",
  );
}

/**
 * The logical mount mode for any spelling a decode can produce, mirroring
 * normalizeMountKind. An unspecified or unknown mode reads as read-write.
 */
export function normalizeMountMode(mode: unknown): string {
  return lookupNormalized(
    mode,
    MOUNT_MODE_NAMES,
    MOUNT_MODE_NUMBERS,
    "MOUNT_MODE_",
    "read_write",
  );
}
