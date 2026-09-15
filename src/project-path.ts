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
// field's current value lives.
export function hostPathForProjectName(
  projectsRoot: string,
  project: string,
): string {
  const root = stripTrailingSlash(projectsRoot);
  const name = stripTrailingSlash(project).replace(/^\/+/, "");
  return name === "" ? root : `${root}/${name}`;
}

function stripTrailingSlash(value: string): string {
  return String(value ?? "").replace(/\/+$/, "");
}

// confineToRoot clamps a directory to the projects root subtree, so a stale or
// hand-edited project path can never open a browser outside it.
export function confineToRoot(root: string, path: string): string {
  const normalizedRoot = stripTrailingSlash(root);
  const normalizedPath = stripTrailingSlash(path);
  if (normalizedRoot === "" || normalizedPath === normalizedRoot) {
    return normalizedRoot;
  }
  return normalizedPath.startsWith(`${normalizedRoot}/`)
    ? normalizedPath
    : normalizedRoot;
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
