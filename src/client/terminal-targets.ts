// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// Target selection for the Podman terminal, kept free of React and the DOM so
// it can be unit-tested from the host program.
//
// The tab always targets the workspace its Session runs in: a Session belongs to
// one workspace, whose side panes — and terminals — are its own, so the client
// never asks for a workspace. The host still receives that project name, and the
// orchestrator addresses a container by its **logical** name: `""`/"default" for
// the workspace's default container, or a user-chosen name such as `dev`. The
// podman name (`dsh-podman-<slug>-<logical>`) is an internal identifier the API
// rejects with INVALID_ARGUMENT, and only the container rows carry the logical
// name — a workspace row's `containerName` is its default container's podman
// name, which is why it must never be offered as a target.

import type { ContainerView, WorkspaceView } from "./card-protocol.js";

/** The Session state the terminal needs: only its working directory. */
export interface PodmanSessionState {
  readonly header?: { readonly cwd?: string } | undefined;
}

/**
 * The standard Session share `ui-session` contributes to every session-scope
 * slot's props. It is optional here because that package is not a dependency of
 * this one, so its declaration merge is absent; the runtime supplies the hook.
 */
export interface SessionStandardShare {
  /** Selector over the current Session's state. */
  readonly useSession?: <T>(selector: (state: PodmanSessionState) => T) => T;
}

// A stable stand-in keeps the selector-hook call unconditional even if the
// share is missing; the runtime binding always supplies the real hook.
const noSession = (
  _selector: (state: PodmanSessionState) => unknown,
): undefined => undefined;

/**
 * The current Session's working directory.
 * @param share - the optional standard Session share.
 * @returns the directory, or `undefined` when no Session exposes one.
 */
export function useSessionCwd(
  share: SessionStandardShare["useSession"],
): string | undefined {
  const useSession = share ?? noSession;
  return useSession((state) => state.header?.cwd);
}

/** The workspace's project name, when `cwd` is `<projectsRoot>/<projectName>/…`. */
function projectNameFromCwd(
  cwd: string | undefined,
  projectsRoot: string,
): string | undefined {
  if (cwd === undefined || cwd === "" || projectsRoot === "") return undefined;
  const prefix = projectsRoot.endsWith("/") ? projectsRoot : `${projectsRoot}/`;
  if (!cwd.startsWith(prefix)) return undefined;
  const name = cwd.slice(prefix.length).split("/")[0] ?? "";
  return name === "" ? undefined : name;
}

/**
 * The workspace the Session runs in.
 *
 * There is deliberately no fallback: a directory outside the projects root, a
 * directory at the root itself, or a project that is not a registered workspace
 * all answer `undefined`, and the caller reports that rather than starting a
 * terminal in a workspace the Session does not belong to.
 * @param workspaces - workspace rows from the card snapshot.
 * @param cwd - the Session's working directory.
 * @param projectsRoot - the host's projects root.
 * @returns the matching workspace's project name, or `undefined`.
 */
export function sessionWorkspace(
  workspaces: readonly WorkspaceView[],
  cwd: string | undefined,
  projectsRoot: string,
): string | undefined {
  const fromCwd = projectNameFromCwd(cwd, projectsRoot);
  if (fromCwd === undefined) return undefined;
  return workspaces.some((workspace) => workspace.projectName === fromCwd) ? fromCwd : undefined;
}

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
