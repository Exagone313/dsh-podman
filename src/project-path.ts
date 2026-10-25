// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// projectNameFromHostPath maps an absolute host directory to the project path a
// project mount stores — the path relative to the projects root. Returns
// undefined when the directory is not strictly inside the root (the root itself
// is not a project, and neither is a sibling), so a directory browser can only
// ever produce a valid mount.
export function projectNameFromHostPath(
  projectsRoot: string,
  path: string,
): string | undefined {
  const root = stripTrailingSlash(projectsRoot);
  const target = stripTrailingSlash(path);
  if (root === "" || target === "" || target === root) return undefined;
  if (!target.startsWith(`${root}/`)) return undefined;
  return target.slice(root.length + 1);
}

// ProjectPathOrigin is where a project mount's path came from: typed into the
// field, or chosen through the dsh host's directory browser. A browsed value is
// already a directory the browser listed under the projects root, so it needs
// no further shape or existence check.
export type ProjectPathOrigin = "typed" | "browsed";

// ProjectPathRejection is why a typed project path is refused: it is empty, it
// is absolute, a ".." would climb above the projects root, or the host reports
// no directory there.
export type ProjectPathRejection =
  | "empty"
  | "absolute"
  | "escapesRoot"
  | "missing";

// ProjectPathDecision is the outcome of checking a project mount's path: the
// project to add, or the reason the add is refused.
export type ProjectPathDecision =
  | { readonly ok: true; readonly project: string }
  | { readonly ok: false; readonly reason: ProjectPathRejection };

// decideProjectPath accepts or refuses a project mount path from its origin,
// its shape and whether the host reports the directory. It is pure: the caller
// lists hostPathForProjectName(projectsRoot, project) through the dsh host's
// directory picker and passes that result as `directoryExists`. A typed value
// is checked for the same shape the other helpers accept — no absolute path,
// no ".." above the root — and is normalized once accepted, so the project
// stored is the one the host path names. A browsed value skips every check:
// the browser can only yield a directory inside the root it listed.
export function decideProjectPath(check: {
  origin: ProjectPathOrigin;
  project: string;
  directoryExists: boolean;
}): ProjectPathDecision {
  const project = String(check.project ?? "");
  if (check.origin === "browsed") return { ok: true, project };
  if (project.trim() === "") return { ok: false, reason: "empty" };
  if (project.startsWith("/")) return { ok: false, reason: "absolute" };
  const name = normalizeProjectPath(project);
  if (name === undefined) return { ok: false, reason: "escapesRoot" };
  if (name === "") return { ok: false, reason: "empty" };
  if (!check.directoryExists) return { ok: false, reason: "missing" };
  return { ok: true, project: name };
}

// hostPathForProjectName is the inverse: the absolute directory a project path
// names under the projects root, used to open a directory browser where the
// field's current value lives. A value that climbs above the root with ".."
// clamps to the root instead of yielding a path outside it.
export function hostPathForProjectName(
  projectsRoot: string,
  project: string,
): string {
  const root = stripTrailingSlash(projectsRoot);
  const name = normalizeProjectPath(String(project ?? ""));
  if (root === "" || name === undefined || name === "") return root;
  return `${root}/${name}`;
}

function stripTrailingSlash(value: string): string {
  return String(value ?? "").replace(/\/+$/, "");
}

// normalizeProjectPath collapses "." and empty segments and resolves ".."
// lexically. It returns undefined when a ".." would climb above the root, so a
// caller can clamp rather than build an escaping path.
function normalizeProjectPath(project: string): string | undefined {
  const segments: string[] = [];
  for (const segment of project.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return undefined;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/");
}

// confineToRoot clamps a directory to the projects root subtree, so a stale or
// hand-edited project path can never open a browser outside it. A ".." inside
// the root is resolved; one that would escape clamps to the root.
export function confineToRoot(root: string, path: string): string {
  const normalizedRoot = stripTrailingSlash(root);
  const normalizedPath = stripTrailingSlash(path);
  if (normalizedRoot === "" || normalizedPath === normalizedRoot) {
    return normalizedRoot;
  }
  if (!normalizedPath.startsWith(`${normalizedRoot}/`)) {
    return normalizedRoot;
  }
  const name = normalizeProjectPath(
    normalizedPath.slice(normalizedRoot.length + 1),
  );
  if (name === undefined || name === "") return normalizedRoot;
  return `${normalizedRoot}/${name}`;
}

// parentDirectory is the directory one level above `path`, never above the
// projects root.
export function parentDirectory(root: string, path: string): string {
  const normalizedRoot = stripTrailingSlash(root);
  const index = path.lastIndexOf("/");
  if (index <= 0) return normalizedRoot;
  const parent = stripTrailingSlash(path.slice(0, index));
  return parent.length < normalizedRoot.length ? normalizedRoot : parent;
}

// rootCrumbs returns the cumulative paths from the projects root down to `path`
// inclusive, so a breadcrumb trail never renders a segment above the root.
export function rootCrumbs(root: string, path: string): string[] {
  const normalizedRoot = stripTrailingSlash(root);
  const prefix = `${normalizedRoot}/`;
  if (normalizedRoot === "" || !path.startsWith(prefix)) return [];
  const crumbs: string[] = [];
  let accumulated = normalizedRoot;
  for (const segment of path.slice(prefix.length).split("/")) {
    if (segment === "") continue;
    accumulated = `${accumulated}/${segment}`;
    crumbs.push(accumulated);
  }
  return crumbs;
}

// crumbLabel is the display name of one crumb path.
export function crumbLabel(path: string): string {
  const trimmed = stripTrailingSlash(path);
  const name = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return name === "" ? trimmed : name;
}
