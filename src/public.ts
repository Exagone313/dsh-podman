// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { isPtcContainer } from "./container-kind.js";
import { mountKindFromProto, mountModeFromProto } from "./mount-enums.js";
import { portProtocolFromProto } from "./publish-port.js";
import { containerNotFound } from "./workspace-binding.js";

// Rebuild API objects so tool results never expose internal fields (see
// AGENTS.md "Security"): only allow-listed attributes reach the model.
export function publicMount(mount: any): Record<string, unknown> {
  const kind = mountKindFromProto(mount?.kind);
  const mode = mountModeFromProto(mount?.mode);
  return {
    ...(mount?.projectName ? { projectName: mount.projectName } : {}),
    ...(mount?.destination ? { destination: mount.destination } : {}),
    ...(mount?.volume ? { volume: mount.volume } : {}),
    ...(mount?.secret ? { secret: mount.secret } : {}),
    ...(kind !== undefined ? { kind } : {}),
    ...(mode !== undefined ? { mode } : {}),
  };
}

/// A published pod port: the address string plus the parts it was built from.
/// The gateway owns the address, so it is echoed rather than assumed.
export function publicPublishedPort(port: any): Record<string, unknown> {
  const protocol = portProtocolFromProto(port?.protocol);
  return {
    ...(protocol !== undefined ? { protocol } : {}),
    port: port?.port ?? 0,
    address: port?.address ?? "",
    hostPort: port?.hostPort ?? 0,
    endpoint: port?.endpoint ?? "",
  };
}

export function publicContainer(row: any): Record<string, unknown> {
  return {
    containerName: row?.containerName ?? "",
    status: row?.status ?? "",
    ...(row?.imageId ? { imageId: row.imageId } : {}),
    mounts: (row?.mounts ?? []).map(publicMount),
    paths: row?.paths ?? [],
    env: row?.env ?? {},
    secretEnv: row?.secretEnv ?? {},
    publishedPorts: (row?.publishedPorts ?? []).map(publicPublishedPort),
  };
}

// publicContainers is the listing shape: the orchestrator-owned PTC container
// is not a container a caller may address, so it never reaches a model-facing
// list. Filtering lives here, with the other allow-list builders, rather than
// in the orchestrator snapshot the settings card renders.
export function publicContainers(
  rows: readonly any[],
): Record<string, unknown>[] {
  return rows.filter((row) => !isPtcContainer(row)).map(publicContainer);
}

// publicContainerResult is the single-container response shape. A mutation
// never legitimately answers with the PTC container — the orchestrator refuses
// every user-addressed mutation on its reserved name — but reporting it as the
// caller's missing container keeps such a row out of every tool result too.
export function publicContainerResult(row: any): Record<string, unknown> {
  if (isPtcContainer(row)) {
    throw containerNotFound(
      String(row?.containerName ?? ""),
      typeof row?.workspaceSlug === "string" ? row.workspaceSlug : undefined,
    );
  }
  return publicContainer(row);
}

export function publicImage(image: any): Record<string, unknown> {
  return {
    imageId: image?.imageId ?? "",
    ...(image?.parent ? { parent: image.parent } : {}),
    packages: image?.packages ?? [],
    isBase: image?.isBase ?? false,
    status: image?.status ?? "",
    ...(image?.primitive ? { primitive: image.primitive } : {}),
    ...(image?.packageManager ? { packageManager: image.packageManager } : {}),
    ...(image?.builtAt ? { builtAt: image.builtAt } : {}),
    basePublic: image?.basePublic ?? false,
    ...(image?.imageTag ? { imageTag: image.imageTag } : {}),
  };
}

export function publicDaemon(info: any): Record<string, unknown> {
  const running = info?.running ?? false;
  return {
    name: info?.name ?? "",
    argv: info?.argv ?? [],
    running,
    // An exit code only means something once the daemon has exited; the proto
    // field defaults to 0 while it runs.
    ...(!running && info?.exitCode !== undefined && info?.exitCode !== null
      ? { exitCode: info.exitCode }
      : {}),
    ...(info?.startedAt ? { startedAt: info.startedAt } : {}),
    ...(info?.stoppedAt ? { stoppedAt: info.stoppedAt } : {}),
    ...(info?.uid !== undefined && info?.uid !== null ? { uid: info.uid } : {}),
    ...(info?.gid !== undefined && info?.gid !== null ? { gid: info.gid } : {}),
    ...(Array.isArray(info?.groups) && info.groups.length > 0
      ? { groups: info.groups }
      : {}),
  };
}
