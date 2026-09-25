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
