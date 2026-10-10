// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import { isProjectSkillPath } from "./skill-roots.js";

const ROOT = "/home/user/project";

test("project skill roots and their contents match", () => {
  for (
    const path of [
      `${ROOT}/app/.dsh/skills`,
      `${ROOT}/app/.agents/skills`,
      `${ROOT}/app/.agents/skills/demo`,
      `${ROOT}/app/.agents/skills/demo/SKILL.md`,
      `${ROOT}/app/.agents/skills/demo/scripts/check.sh`,
      // A session may run in a subdirectory whose own `.git` makes it the
      // project root, and the harness then scans that level.
      `${ROOT}/app/sub/.agents/skills/demo.md`,
    ]
  ) {
    assert.equal(isProjectSkillPath(path, ROOT), true, path);
  }
});

test("paths outside the projects root never match", () => {
  for (
    const path of [
      "/.agents/skills/x",
      "/etc/.dsh/skills/x",
      "/home/user/.agents/skills/demo",
      ROOT,
      `${ROOT}/app`,
      "app/.agents/skills",
    ]
  ) {
    assert.equal(isProjectSkillPath(path, ROOT), false, path);
  }
});

test("look-alike paths under the projects root never match", () => {
  for (
    const path of [
      `${ROOT}/app/.ssh/skills/x`,
      `${ROOT}/app/.agents/skills-x`,
      `${ROOT}/app/.agents/skillsystem`,
      `${ROOT}/app/.agents/x/skills`,
      `${ROOT}/app/skills/.agents`,
      `${ROOT}/app/.dsh/.agents/skills.md`,
      `${ROOT}/app/.git`,
    ]
  ) {
    assert.equal(isProjectSkillPath(path, ROOT), false, path);
  }
});

test("an unusable projects root never matches", () => {
  const path = `${ROOT}/app/.agents/skills`;
  assert.equal(isProjectSkillPath(path, ""), false);
  assert.equal(isProjectSkillPath(path, "project"), false);
  assert.equal(isProjectSkillPath("app/.agents/skills", ROOT), false);
});
