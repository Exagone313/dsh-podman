// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import { isProjectSkillPath, isUserSkillPath } from "./skill-roots.js";

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

const HOMES = { dshHome: "/home/user/.dsh", agentsHome: "/home/user/.agents" };

test("user skill roots and their contents match", () => {
  for (
    const path of [
      "/home/user/.dsh/skills",
      "/home/user/.dsh/skills/demo",
      "/home/user/.dsh/skills/demo/SKILL.md",
      "/home/user/.agents/skills",
      "/home/user/.agents/skills/demo.md",
      "/home/user/.agents/skills/demo/scripts/check.sh",
    ]
  ) {
    assert.equal(isUserSkillPath(path, HOMES), true, path);
  }
});

test("paths outside the user skill roots never match", () => {
  for (
    const path of [
      "/home/user/.dsh",
      "/home/user/.dsh/config.yaml",
      "/home/user/.dsh/skills-x",
      "/home/user/.dsh/skillsystem/demo",
      "/home/user/.agents",
      "/home/user/.agents/skills-x",
      "/home/user/other/skills",
      "/etc/skills",
      ".dsh/skills",
    ]
  ) {
    assert.equal(isUserSkillPath(path, HOMES), false, path);
  }
});

test("an unusable or moved user home never matches", () => {
  const path = "/home/user/.dsh/skills/demo";
  assert.equal(isUserSkillPath(path, { dshHome: "", agentsHome: "" }), false);
  assert.equal(
    isUserSkillPath(path, { dshHome: "relative", agentsHome: "" }),
    false,
  );
  assert.equal(
    isUserSkillPath(path, { dshHome: "/srv/dsh", agentsHome: "" }),
    false,
  );
  assert.equal(
    isUserSkillPath("/srv/dsh/skills/demo", {
      dshHome: "/srv/dsh",
      agentsHome: "",
    }),
    true,
  );
});
