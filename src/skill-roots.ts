// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { isAbsolute, join, relative } from "node:path";

// The local skill roots the harness scans: for one project root its `.dsh/skills`
// and `.agents/skills` directories, plus the two user roots `<dshHome>/skills` and
// `<agentsHome>/skills`. A project root itself is the nearest ancestor of the
// session cwd containing `.git`, else the cwd, so a session running in a
// subdirectory with its own `.git` scans that level.
//
// The local provider resolves each root with `fs.resolve(root)` and no session
// cwd, which a container-backed filesystem can only answer by containment, so
// this plugin reads those roots from the host filesystem instead. Each matcher is
// anchored at a root boundary, so no unrelated path can match.

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

// The two user roots the harness scans, resolved the way it resolves them:
// `$DSH_HOME` or `~/.dsh`, and `$DSH_AGENTS_HOME` or `~/.agents`.
export interface UserSkillRoots {
  readonly dshHome: string;
  readonly agentsHome: string;
}

// isUserSkillPath reports whether path is one of the user skill roots, or lies
// inside one.
export function isUserSkillPath(path: string, roots: UserSkillRoots): boolean {
  if (!isAbsolute(path)) return false;
  return (
    isUnderSkillDir(path, roots.dshHome) ||
    isUnderSkillDir(path, roots.agentsHome)
  );
}

// skillDirFor resolves one user home to its skill directory, or "" when the home
// is unusable, so a missing environment variable cannot widen the matcher.
function skillDirFor(home: string): string {
  return home === "" || !isAbsolute(home) ? "" : join(home, "skills");
}

function isUnderSkillDir(path: string, home: string): boolean {
  const root = skillDirFor(home);
  if (root === "") return false;
  return path === root || path.startsWith(`${root}/`);
}
