// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// One container's editable configuration. A row keeps a draft of this shape,
// compares it with the live snapshot for its dirty state, and applies the draft
// with one footer action. The same helpers drive the label that action shows,
// so the two halves cannot drift.

import type { ContainerView, MountInput } from "./card-protocol.js";
import { mountViewToInput } from "./container-card-shared.js";
import type { ContainerPluginKey } from "./locales.js";

// A port the container should publish. A staged addition has an empty endpoint
// until the gateway answers; a port already published carries the endpoint it
// bound (and the host port it bound), which the editor shows as-is.
export interface PortConfig {
  port: number;
  protocol: string;
  endpoint: string;
  // The host port to ask the gateway for when this entry is published; 0 lets
  // the gateway choose a free one.
  suggestedHostPort: number;
  // The host port the gateway actually bound; 0 until it answers. It is display
  // only: comparing two port lists still compares them by their identity.
  hostPort: number;
}

export interface ContainerConfig {
  image: string;
  env: Record<string, string>;
  mounts: readonly MountInput[];
  paths: readonly string[];
  secretEnv: Record<string, string>;
  ports: readonly PortConfig[];
}

export function containerConfigFrom(container: ContainerView): ContainerConfig {
  return {
    image: container.imageId,
    env: { ...container.env },
    mounts: container.mounts.map(mountViewToInput),
    paths: [...container.paths],
    secretEnv: { ...container.secretEnv },
    ports: container.publishedPorts.map((published) => ({
      port: published.port,
      protocol: published.protocol,
      endpoint: published.endpoint,
      suggestedHostPort: 0,
      hostPort: published.hostPort,
    })),
  };
}

export function recordsEqual(
  a: Record<string, string>,
  b: Record<string, string>,
): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length &&
    keys.every((key) => a[key] === b[key]);
}

// The identity a mount keeps across an edit: its source and destination, but
// not its mode, which the row changes in place.
export function mountKey(mount: MountInput): string {
  if (mount.kind === "tmpfs") return `tmpfs|${mount.destination}`;
  if (mount.kind === "volume") {
    return `volume|${mount.volume}|${mount.destination}`;
  }
  if (mount.kind === "secret") {
    return `secret|${mount.secret}|${mount.destination}`;
  }
  return `project|${mount.project}|${mount.destination}`;
}

export function mountInputsEqual(a: MountInput, b: MountInput): boolean {
  return mountKey(a) === mountKey(b) && a.mode === b.mode;
}

export function mountsEqual(
  a: readonly MountInput[],
  b: readonly MountInput[],
): boolean {
  return a.length === b.length &&
    a.every((mount, index) => mountInputsEqual(mount, b[index]));
}

export function pathsEqual(
  a: readonly string[],
  b: readonly string[],
): boolean {
  return a.length === b.length && a.every((path, index) => path === b[index]);
}

// Ports are compared by identity only: an endpoint is host bookkeeping, not a
// user edit, so a staged publish that the gateway bound is not dirty.
export function portsEqual(
  a: readonly PortConfig[],
  b: readonly PortConfig[],
): boolean {
  return a.length === b.length &&
    a.every((port, index) =>
      port.port === b[index].port && port.protocol === b[index].protocol
    );
}

export function configsEqual(a: ContainerConfig, b: ContainerConfig): boolean {
  return a.image === b.image &&
    recordsEqual(a.env, b.env) &&
    mountsEqual(a.mounts, b.mounts) &&
    pathsEqual(a.paths, b.paths) &&
    recordsEqual(a.secretEnv, b.secretEnv) &&
    portsEqual(a.ports, b.ports);
}

// The stable identity of one configuration group. The comparison, the rebuild
// rule and the staged marker all key off these ids, so renaming a group's label
// — or reusing a locale key elsewhere — can never change which groups a change
// names or whether applying it rebuilds the container.
export type ConfigGroupId =
  | "image"
  | "env"
  | "mounts"
  | "paths"
  | "secretEnv"
  | "ports";

// The label each group reads with in the staged marker, keyed by the group's
// stable id.
export const configGroupLabels: Record<ConfigGroupId, ContainerPluginKey> = {
  image: "image",
  env: "envTitle",
  mounts: "mountsTitle",
  paths: "pathsTitle",
  secretEnv: "containerSecretsTitle",
  ports: "portsTitle",
};

// The field groups that differ between the live configuration and the staged
// one, by their stable ids, in the order the recreate label names them.
export function configChangedKeys(
  base: ContainerConfig,
  next: ContainerConfig,
): ConfigGroupId[] {
  const groups: ConfigGroupId[] = [];
  if (base.image !== next.image) groups.push("image");
  if (!recordsEqual(base.env, next.env)) groups.push("env");
  if (!mountsEqual(base.mounts, next.mounts)) groups.push("mounts");
  if (!pathsEqual(base.paths, next.paths)) groups.push("paths");
  if (!recordsEqual(base.secretEnv, next.secretEnv)) groups.push("secretEnv");
  if (!portsEqual(base.ports, next.ports)) groups.push("ports");
  return groups;
}

// The groups whose change rebuilds the container: the recreate command carries
// a new image or environment, and a mount or a secret environment variable is
// applied by a command that recreates the container itself. A PATH addition and
// a published port are the two groups the running container takes on its own.
const REBUILD_GROUPS: readonly ConfigGroupId[] = [
  "image",
  "env",
  "mounts",
  "secretEnv",
];

// Whether applying a staged copy rebuilds the container, terminating what runs
// inside it. It names the rebuilds-container groups by their stable ids, never
// by a locale key, so a PATH-only change can never be mistaken for one.
export function configRebuildsContainer(
  base: ContainerConfig,
  next: ContainerConfig,
): boolean {
  return configChangedKeys(base, next).some((id) =>
    REBUILD_GROUPS.includes(id)
  );
}

// Whether applying a staged copy needs the recreate command itself, which is
// what carries the new image and environment. Every other group is either
// applied in place or recreated by its own command, so the apply never sends a
// redundant recreate.
export function configNeedsRecreate(
  base: ContainerConfig,
  next: ContainerConfig,
): boolean {
  return base.image !== next.image || !recordsEqual(base.env, next.env);
}

export interface MountDiff {
  added: MountInput[];
  removed: MountInput[];
  updated: MountInput[];
}

// Pair each staged mount with a live one by identity, so an added, removed, or
// mode-changed mount is recognised even when its neighbours shifted.
export function mountDiff(
  base: readonly MountInput[],
  next: readonly MountInput[],
): MountDiff {
  const used = base.map(() => false);
  const added: MountInput[] = [];
  const updated: MountInput[] = [];
  for (const mount of next) {
    const index = base.findIndex((live, at) =>
      !used[at] && mountKey(live) === mountKey(mount)
    );
    if (index === -1) {
      added.push(mount);
      continue;
    }
    used[index] = true;
    if (base[index].mode !== mount.mode) updated.push(mount);
  }
  return {
    added,
    removed: base.filter((_, index) => !used[index]),
    updated,
  };
}

export interface EnvDiff {
  added: [string, string][];
  removed: string[];
  changed: [string, string][];
}

export function envDiff(
  base: Record<string, string>,
  next: Record<string, string>,
): EnvDiff {
  const added: [string, string][] = [];
  const changed: [string, string][] = [];
  const removed: string[] = [];
  for (const [key, value] of Object.entries(next)) {
    if (!(key in base)) added.push([key, value]);
    else if (base[key] !== value) changed.push([key, value]);
  }
  for (const key of Object.keys(base)) {
    if (!(key in next)) removed.push(key);
  }
  return { added, removed, changed };
}

export interface PortDiff {
  added: PortConfig[];
  removed: PortConfig[];
}

export function portDiff(
  base: readonly PortConfig[],
  next: readonly PortConfig[],
): PortDiff {
  const key = (port: PortConfig): string => `${port.port}/${port.protocol}`;
  const baseKeys = new Set(base.map(key));
  const nextKeys = new Set(next.map(key));
  return {
    added: next.filter((port) => !baseKeys.has(key(port))),
    removed: base.filter((port) => !nextKeys.has(key(port))),
  };
}
