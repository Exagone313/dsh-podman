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
  const proto = mode !== undefined && Object.prototype.hasOwnProperty.call(MOUNT_MODES, mode)
    ? MOUNT_MODES[mode]
    : undefined;
  if (proto === undefined) throw new Error(`unknown mount mode: ${mode}`);
  return proto;
}

/** The logical mount kind for a proto enum value, or undefined when unspecified. */
export function mountKindFromProto(proto: string | undefined): string | undefined {
  if (proto === undefined) return undefined;
  return Object.prototype.hasOwnProperty.call(KIND_FROM_PROTO, proto)
    ? KIND_FROM_PROTO[proto]
    : undefined;
}

/** The logical mount mode for a proto enum value, or undefined when unspecified. */
export function mountModeFromProto(proto: string | undefined): string | undefined {
  if (proto === undefined) return undefined;
  return Object.prototype.hasOwnProperty.call(MODE_FROM_PROTO, proto)
    ? MODE_FROM_PROTO[proto]
    : undefined;
}
