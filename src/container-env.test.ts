// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import {
  commitIdentityAction,
  GIT_IDENTITY_KEYS,
  gitIdentityEnv,
  gitOnlyDrift,
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
  assert.deepEqual(missingDefaultEnv({ A: "1", B: "2" }, { B: "own" }), {
    A: "1",
  });
  assert.deepEqual(missingDefaultEnv({ A: "1" }, { A: "own" }), {});
  assert.deepEqual(missingDefaultEnv(undefined, {}), {});
});

test("git identity fills the author and committer pairs", () => {
  assert.deepEqual(gitIdentityEnv("John Doe", "john.doe@git.example"), {
    GIT_AUTHOR_NAME: "John Doe",
    GIT_AUTHOR_EMAIL: "john.doe@git.example",
    GIT_COMMITTER_NAME: "John Doe",
    GIT_COMMITTER_EMAIL: "john.doe@git.example",
  });
  assert.deepEqual(
    readGitIdentity(gitIdentityEnv("John Doe", "john.doe@git.example")),
    {
      name: "John Doe",
      email: "john.doe@git.example",
    },
  );
  assert.deepEqual(readGitIdentity(undefined), { name: "", email: "" });
});

test("setGitIdentity adds, replaces and clears the four keys", () => {
  const base = { KEEP: "1", GIT_AUTHOR_NAME: "old" };
  const set = setGitIdentity(base, "new", "new@example.com");
  assert.deepEqual(set, {
    KEEP: "1",
    ...gitIdentityEnv("new", "new@example.com"),
  });
  for (const key of GIT_IDENTITY_KEYS) assert.ok(key in set);
  // An empty field clears the whole identity, leaving other defaults alone.
  assert.deepEqual(setGitIdentity(set, "", "new@example.com"), { KEEP: "1" });
  assert.deepEqual(setGitIdentity(set, "new", ""), { KEEP: "1" });
  // The input map is not mutated.
  assert.deepEqual(base, { KEEP: "1", GIT_AUTHOR_NAME: "old" });
});

test("gitOnlyDrift tells an identity-only change apart from other edits", () => {
  const identity = gitIdentityEnv("John Doe", "john.doe@git.example");
  // No drift at all qualifies (there is nothing else to lose by committing).
  assert.equal(gitOnlyDrift(identity, identity), true);
  // Changing or removing the identity alone is git-only.
  assert.equal(
    gitOnlyDrift(identity, setGitIdentity(identity, "New", "new@example.com")),
    true,
  );
  assert.equal(gitOnlyDrift(identity, setGitIdentity(identity, "", "")), true);
  // Any other default drift means the Save button must stay in charge.
  assert.equal(gitOnlyDrift(identity, { ...identity, KEEP: "1" }), false);
  assert.equal(gitOnlyDrift({ KEEP: "1" }, { KEEP: "2" }), false);
  // Removing a non-identity key, or an identity key drifting in the server map
  // while another edit exists, both count as a real diff.
  assert.equal(gitOnlyDrift({ KEEP: "1", ...identity }, identity), false);
});

test("commitIdentityAction applies the popup result without losing edits", () => {
  const saved = gitIdentityEnv("John Doe", "john.doe@git.example");
  const changed = setGitIdentity(saved, "New", "new@example.com");
  // The popup restores the saved identity while the draft still holds the
  // changed one: the pending identity edit is discarded, not kept (regression:
  // the old code returned early and left the changed identity in the draft).
  assert.equal(commitIdentityAction(saved, changed, saved), "discard");
  // No drift at all and an unchanged popup is a no-op discard too.
  assert.equal(commitIdentityAction(saved, saved, saved), "discard");
  // An identity-only change commits straight: nothing else can be lost.
  assert.equal(commitIdentityAction(saved, changed, changed), "save");
  assert.equal(commitIdentityAction(saved, saved, changed), "save");
  // Clearing the identity alone is also git-only.
  assert.equal(commitIdentityAction(saved, changed, {}), "save");
  // Another pending default keeps the result in the draft, whatever the popup
  // does to the identity: change, restore, or clear.
  const withKeep = { ...saved, KEEP: "1" };
  assert.equal(
    commitIdentityAction(saved, withKeep, { ...withKeep, ...changed }),
    "draft",
  );
  assert.equal(commitIdentityAction(saved, withKeep, withKeep), "draft");
  assert.equal(commitIdentityAction(saved, withKeep, { KEEP: "1" }), "draft");
});
