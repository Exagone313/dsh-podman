// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { isAbsolute, relative } from "node:path";

// The local skill roots the harness scans for one project root: its
// `.dsh/skills` and `.agents/skills` directories. The project root itself is the
// nearest ancestor of the session cwd containing `.git`, else the cwd, so a
// session running in a subdirectory with its own `.git` scans that level.
//
// The local provider resolves each root with `fs.resolve(root)` and no session
// cwd, which a container-backed filesystem can only answer by containment, so
// this plugin reads those roots from the host filesystem instead. The matcher is
// anchored at the projects root and requires the boundary segment, so no path
// outside a project's skill directory can match, whatever its depth.

// isProjectSkillPath reports whether path is a project skill root, or lies
// inside one, for a project under projectsRoot.
export function isProjectSkillPath(
  path: string,
  projectsRoot: string,
): boolean {
  if (!isAbsolute(path) || projectsRoot === "" || !isAbsolute(projectsRoot)) {
    return false;
  }
  const relativePath = relative(projectsRoot, path);
  if (
    relativePath === "" ||
    relativePath.startsWith("..") ||
    isAbsolute(relativePath)
  ) {
    return false;
  }
  const segments = relativePath.split("/");
  for (let index = 0; index < segments.length - 1; index += 1) {
    const parent = segments[index];
    if (
      (parent === ".dsh" || parent === ".agents") &&
      segments[index + 1] === "skills"
    ) {
      return true;
    }
  }
  return false;
}
