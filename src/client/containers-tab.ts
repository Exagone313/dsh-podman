// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// The Containers tab type's identity and the pure half of its open action. The
// tab type is registered under `PODMAN_CONTAINERS_TAB_ID` (its implementation
// id, unique across registrations) while `openTab` names
// `PODMAN_CONTAINERS_KIND`. Both live here so the registration in index.ts and
// the body agree without importing one another, and so the action stays
// testable without the DOM or React.
//
// The panel has no keyboard binding: it opens from its Start panel card or from
// its command, and this module only holds the command's target capture. Keeping
// the open action free of a binding is what lets the command palette entry stay
// without claiming keys the user did not choose.

/** Page kind `openTab` names; unique among the tab types in force. */
export const PODMAN_CONTAINERS_KIND = "podman-containers";

/** Implementation id the body registers under; distinct from the terminal's. */
export const PODMAN_CONTAINERS_TAB_ID = "@exagone313/dsh-podman#containers";

// The part of the right Sidebar this action uses: capture the focused pane, then
// open the panel in it. Generic over the captured target so this module stays
// free of DOM types.
export interface ContainersNavigator<Target> {
  commandTarget(target: unknown): Target | undefined;
  openTabFromTarget(kind: string, target: Target): void;
}

/** What resolving the open action settled on. */
export type ContainersOpenResolution =
  | { readonly status: "blocked" }
  | { readonly status: "handled"; readonly run: () => void };

/**
 * Capture the current pane and prepare to open the Containers panel in it.
 *
 * The capture happens during resolve (the live input target is only valid
 * then); the returned `run` opens the panel at that captured target, so the
 * command opens in the focused pane.
 * @param navigator - the right Sidebar's capture and open face.
 * @param target - the live input element, if any.
 * @returns a blocked resolution without a capturable session, else the run.
 */
export function resolveContainersOpen<Target>(
  navigator: ContainersNavigator<Target>,
  target: unknown,
): ContainersOpenResolution {
  const captured = navigator.commandTarget(target);
  if (captured === undefined) return { status: "blocked" };
  return {
    status: "handled",
    run: () => {
      navigator.openTabFromTarget(PODMAN_CONTAINERS_KIND, captured);
    },
  };
}
