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
