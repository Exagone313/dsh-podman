// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import {
  GIT_IDENTITY_KEYS,
  gitIdentityEnv,
  mergeDefaultEnv,
  missingDefaultEnv,
  readGitIdentity,
  setGitIdentity,
} from "./container-env.js";

test("mergeDefaultEnv seeds defaults under the container's own env", () => {
  assert.deepEqual(mergeDefaultEnv({ A: "1", B: "2" }, { B: "own", C: "3" }), {
    A: "1",
    B: "own",
    C: "3",
  });
  assert.deepEqual(mergeDefaultEnv(undefined, { A: "1" }), { A: "1" });
  assert.deepEqual(mergeDefaultEnv({ A: "1" }, undefined), { A: "1" });
});

test("mergeDefaultEnv drops empty and reserved defaults", () => {
  assert.deepEqual(
    mergeDefaultEnv({ "": "x", DSH_PODMAN_GUEST_TOKEN: "x", KEEP: "1" }, {}),
    { KEEP: "1" },
  );
  // An explicit value in the reserved namespace is the caller's own doing and
  // is left to the orchestrator's validation.
  assert.deepEqual(mergeDefaultEnv({}, { DSH_PODMAN_GUEST_TOKEN: "x" }), {
    DSH_PODMAN_GUEST_TOKEN: "x",
  });
});

test("missingDefaultEnv reports only the absent keys", () => {
  assert.deepEqual(missingDefaultEnv({ A: "1", B: "2" }, { B: "own" }), { A: "1" });
  assert.deepEqual(missingDefaultEnv({ A: "1" }, { A: "own" }), {});
  assert.deepEqual(missingDefaultEnv(undefined, {}), {});
});

test("git identity fills the author and committer pairs", () => {
  assert.deepEqual(gitIdentityEnv("Elouan", "exa@elou.world"), {
    GIT_AUTHOR_NAME: "Elouan",
    GIT_AUTHOR_EMAIL: "exa@elou.world",
    GIT_COMMITTER_NAME: "Elouan",
    GIT_COMMITTER_EMAIL: "exa@elou.world",
  });
  assert.deepEqual(readGitIdentity(gitIdentityEnv("Elouan", "exa@elou.world")), {
    name: "Elouan",
    email: "exa@elou.world",
  });
  assert.deepEqual(readGitIdentity(undefined), { name: "", email: "" });
});

test("setGitIdentity adds, replaces and clears the four keys", () => {
  const base = { KEEP: "1", GIT_AUTHOR_NAME: "old" };
  const set = setGitIdentity(base, "new", "new@example.com");
  assert.deepEqual(set, { KEEP: "1", ...gitIdentityEnv("new", "new@example.com") });
  for (const key of GIT_IDENTITY_KEYS) assert.ok(key in set);
  // An empty field clears the whole identity, leaving other defaults alone.
  assert.deepEqual(setGitIdentity(set, "", "new@example.com"), { KEEP: "1" });
  assert.deepEqual(setGitIdentity(set, "new", ""), { KEEP: "1" });
  // The input map is not mutated.
  assert.deepEqual(base, { KEEP: "1", GIT_AUTHOR_NAME: "old" });
});
