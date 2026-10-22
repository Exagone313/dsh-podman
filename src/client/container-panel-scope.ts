// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// The workspace scope of the Containers panel, kept free of React and the DOM so
// it can be unit-tested from the host program.
//
// A Session belongs to exactly one workspace and its side panes are that
// workspace's own, so the panel never offers a workspace picker: the host route
// resolves the session's workspace once (`fetchTerminalTarget`, the same route
// the terminal uses) and this helper reduces the card snapshot to the rows that
// workspace may show. A row without a slug and the shared, workspace-less PTC
// container are never part of any workspace, and another workspace's rows are
// never shown — even when the snapshot is the whole deployment's state.

import { type ContainerView, PTC_CONTAINER_NAME } from "./card-protocol.js";
import type { TerminalTargetView } from "./terminal-protocol.js";

/**
 * The containers the Containers panel lists for one resolved workspace.
 *
 * The default container sorts first, as it does in the settings card, and the
 * named ones follow in name order. An unknown session (no resolved target, or a
 * target with no slug) has no workspace to scope to and yields nothing.
 * @param containers - container rows from the card snapshot.
 * @param target - the host-resolved workspace, or undefined until it arrives.
 * @returns that workspace's containers only.
 */
export function containersInWorkspace(
  containers: readonly ContainerView[],
  target: TerminalTargetView | undefined,
): ContainerView[] {
  if (target === undefined || target.workspaceSlug === "") return [];
  const workspaceSlug = target.workspaceSlug;
  return containers
    .filter((container) =>
      container.workspaceSlug === workspaceSlug &&
      // Defensive: a row without a workspace belongs to no scope, and the
      // shared PTC container belongs to none by definition.
      container.workspaceSlug !== "" &&
      container.containerName !== "" &&
      container.containerName !== PTC_CONTAINER_NAME
    )
    .sort(byDefaultThenName);
}

// The default container first, then the named ones in a stable order.
function byDefaultThenName(left: ContainerView, right: ContainerView): number {
  const leftDefault = left.containerName === "default";
  const rightDefault = right.containerName === "default";
  if (leftDefault !== rightDefault) return leftDefault ? -1 : 1;
  return left.containerName.localeCompare(right.containerName);
}
