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

export function mountKindToProto(kind: string | undefined): string {
  if (kind === undefined) return "MOUNT_KIND_PROJECT";
  const proto = Object.prototype.hasOwnProperty.call(MOUNT_KINDS, kind)
    ? MOUNT_KINDS[kind]
    : undefined;
  if (proto === undefined) throw new Error(`unknown mount kind: ${kind}`);
  return proto;
}

export function mountModeToProto(mode: string | undefined): string {
  const proto =
    mode !== undefined && Object.prototype.hasOwnProperty.call(MOUNT_MODES, mode)
      ? MOUNT_MODES[mode]
      : undefined;
  if (proto === undefined) throw new Error(`unknown mount mode: ${mode}`);
  return proto;
}
