// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { resolveGuestCwd } from "./guest-rpc.js";
import {
  WorkingDirectoryUnreachableError,
  WorkspaceResolver,
} from "./workspace-binding.js";

// workingCwd is the session's effective working directory: the harness's
// working-directory projection when the service is present, otherwise the
// original project from the session header.
export function workingCwd(ctx: any, exec: any): unknown {
  const session = exec?.agent?.session;
  if (session === undefined) return undefined;
  const current = ctx?.get?.("workingDirectory")?.get?.(session);
  return typeof current === "string" && current !== ""
    ? current
    : session?.header?.cwd;
}

// handleWorkingDirectoryAccess validates every change the harness makes and
// records the container binding the mounted path is served by. The recorded
// binding is what lets the harness's fs/subprocess providers, which carry only
// the cwd path, resolve a directory that is not a registered dsh workspace.
//
// An `ensure` on a legacy cwd that no longer resolves recovers the session to
// its original project instead of failing every prompt. Only that specific
// unreachable-directory error is recovered; a container that is merely not
// ready propagates so a transient outage cannot silently reset the cwd.
export async function handleWorkingDirectoryAccess(
  ctx: any,
  resolver: WorkspaceResolver,
  request: any,
  next: () => Promise<string>,
): Promise<string> {
  const session = request?.agent?.session;
  if (session === undefined) return next();
  const header = session?.header?.cwd;
  if (typeof header !== "string" || header === "") return next();
  const service = ctx?.get?.("workingDirectory");
  const current = service?.get?.(session) ?? header;
  if (typeof current !== "string" || current === "") return next();

  if (request?.path === null || request?.path === undefined) {
    // The session's original project is always a registered workspace; the
    // service's own resolve validates it and refreshes the agent credential.
    // Skipping it here avoids a second Ping on every ordinary prompt.
    if (current === header) return next();
    try {
      const binding = await resolver.resolveSessionDirectory(
        header,
        current,
        request?.signal,
      );
      if (current !== header) resolver.recordMountedCwd(current, binding);
      return next();
    } catch (error) {
      if (!(error instanceof WorkingDirectoryUnreachableError)) throw error;
      if (current === header) throw error;
      session.append("working-directory/change", { cwd: header });
      ctx?.logger?.warn?.(
        `podman: working directory ${
          JSON.stringify(current)
        } is not mounted; restored ${JSON.stringify(header)}`,
      );
      return next();
    }
  }

  if (typeof request.path !== "string") return next();
  const target = resolveGuestCwd(request.path, current);
  if (target === undefined || target === header) return next();
  const binding = await resolver.resolveSessionDirectory(
    header,
    target,
    request.signal,
  );
  if (target !== header) resolver.recordMountedCwd(target, binding);
  return next();
}

// registerWorkingDirectoryAccess installs the listener for the harness's
// working-directory service. The injection keeps the plugin loadable in a
// composition that does not provide the service.
export function registerWorkingDirectoryAccess(
  ctx: any,
  resolver: WorkspaceResolver,
): void {
  ctx.inject(["workingDirectory"], (child: any) => {
    child.on(
      "working-directory/access",
      (request: any, next: () => Promise<string>) =>
        handleWorkingDirectoryAccess(child, resolver, request, next),
    );
  });
}
