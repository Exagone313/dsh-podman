// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// Container selection for the Podman terminal, kept free of React and the DOM so
// it can be unit-tested from the host program.
//
// The workspace is resolved by the host from the Session itself (see
// `terminal-route.ts`) and is never chosen, shown or guessed in the browser;
// this module only turns the card snapshot's container rows into the logical
// names the orchestrator accepts: `""`/"default" for the workspace's default
// container, or a user-chosen name such as `dev`. The podman name
// (`dsh-podman-<slug>-<logical>`) is an internal identifier the API rejects with
// INVALID_ARGUMENT, and only the container rows carry the logical name — a
// workspace row's `containerName` is its default container's podman name, which
// is why it must never be offered as a target.

import type { ContainerView } from "./card-protocol.js";
import type { TerminalShellView } from "./terminal-protocol.js";

/**
 * The named containers selectable for one workspace, sorted.
 *
 * The empty value is not repeated here: the picker's own placeholder already
 * means "the workspace's default container".
 * @param containers - container rows from the card snapshot.
 * @param workspaceSlug - the selected workspace's slug.
 * @returns logical container names, excluding the default.
 */
export function containerOptions(
  containers: readonly ContainerView[],
  workspaceSlug: string | undefined,
): string[] {
  if (workspaceSlug === undefined || workspaceSlug === "") return [];
  const names = new Set<string>();
  for (const container of containers) {
    if (container.workspaceSlug !== workspaceSlug) continue;
    if (container.containerName === "" || container.containerName === "default") {
      continue;
    }
    // A podman name is an internal identifier the API rejects; never offer one.
    if (container.containerName.startsWith("dsh-podman-")) continue;
    names.add(container.containerName);
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

/**
 * The remembered container, but only while the workspace still offers it.
 * @param remembered - the container name the card started last time.
 * @param options - the workspace's selectable container names.
 * @returns the remembered name, or `""` for the workspace's default container.
 */
export function validContainer(
  remembered: string | undefined,
  options: readonly string[],
): string {
  if (remembered === undefined || remembered === "") return "";
  return options.includes(remembered) ? remembered : "";
}

/**
 * The remembered shell, but only while the chosen container still offers it —
 * the same container may have been recreated from another image.
 * @param remembered - the absolute shell path the card started last time.
 * @param shells - the shells the host discovered in the chosen container.
 * @returns the remembered path, or `undefined` when it is gone.
 */
export function validShell(
  remembered: string | undefined,
  shells: readonly TerminalShellView[],
): string | undefined {
  if (remembered === undefined || remembered === "") return undefined;
  return shells.some((shell) => shell.path === remembered) ? remembered : undefined;
}

/**
 * The program name of a shell path.
 * @param path - an absolute shell path such as `/usr/bin/bash`, or absent.
 * @returns the basename, or `undefined` when there is nothing to name.
 */
export function shellName(path: string | undefined): string | undefined {
  if (path === undefined || path === "") return undefined;
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name === "" ? undefined : name;
}
