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
  const name = normalizeProjectPath(normalizedPath.slice(normalizedRoot.length + 1));
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
