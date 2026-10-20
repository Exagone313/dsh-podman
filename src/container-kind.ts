// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// The logical kinds a container row can carry. The orchestrator gives its
// reserved PTC container the PTC kind; every other row, including one written
// before the marker existed, is an ordinary guest container.
export type ContainerKind = "guest" | "ptc";

const KIND_NAMES: Record<string, ContainerKind> = {
  unspecified: "guest",
  guest: "guest",
  ptc: "ptc",
};

const KIND_NUMBERS: Record<number, ContainerKind> = {
  0: "guest",
  1: "guest",
  2: "ptc",
};

/**
 * The logical kind of a decoded container row. A decoder may produce the enum
 * name with or without its CONTAINER_KIND_ prefix, or the enum number, so the
 * value is normalized here rather than at each consumer. An unspecified or
 * unknown kind reads as guest: it cannot accidentally expose the reserved
 * container as an ordinary one, and every pre-marker row is a guest.
 */
export function containerKindFromProto(kind: unknown): ContainerKind {
  if (typeof kind === "number") return KIND_NUMBERS[kind] ?? "guest";
  if (typeof kind !== "string") return "guest";
  const short = kind.startsWith("CONTAINER_KIND_")
    ? kind.slice("CONTAINER_KIND_".length).toLowerCase()
    : kind.toLowerCase();
  return Object.prototype.hasOwnProperty.call(KIND_NAMES, short)
    ? KIND_NAMES[short]
    : "guest";
}

// isPtcContainer reports whether a row is the orchestrator-owned PTC container.
// Model-facing tool results never expose it; the card renders it from its own
// workspace-less snapshot entry instead of among the workspace containers.
export function isPtcContainer(row: any): boolean {
  return containerKindFromProto(row?.kind) === "ptc";
}
