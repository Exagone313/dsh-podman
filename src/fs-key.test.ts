// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import { normalizeFsKey } from "./fs-key.js";

test("normalizeFsKey collapses redundant separators and dot segments", () => {
  assert.equal(normalizeFsKey("/projects//team/./app"), "/projects/team/app");
  assert.equal(normalizeFsKey("/projects/team/app/"), "/projects/team/app");
  assert.equal(normalizeFsKey("//projects/team"), "/projects/team");
  assert.equal(normalizeFsKey("/"), "/");
});

test("normalizeFsKey collapses parent segments lexically", () => {
  assert.equal(
    normalizeFsKey("/projects/team/../team/app"),
    "/projects/team/app",
  );
  assert.equal(
    normalizeFsKey("/projects/team/app/../../other"),
    "/projects/other",
  );
});

test("normalizeFsKey leaves a symlinked name alone", () => {
  // No realpath is consulted: the key names the path the caller asked for.
  assert.equal(
    normalizeFsKey("/projects/team/link/file"),
    "/projects/team/link/file",
  );
});

test("normalizeFsKey keeps a relative spelling relative", () => {
  assert.equal(normalizeFsKey("app//file"), "app/file");
  assert.equal(normalizeFsKey("./"), ".");
});
