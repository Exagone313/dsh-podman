// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import { createSpillStore, sessionSegment } from "./spill-store.js";
import { guestFileRecorder } from "./test-support.js";

const SESSION_ID = "2c573001-4171-4900-904b-12a5cc02737a";
const SEGMENT = sessionSegment(SESSION_ID);

function fakeCtx(sessions: Record<string, any>): any {
  return {
    get: (name: string) => name === "sessions" ? { get: (id: string) => sessions[id] } : undefined,
  };
}

function withSession(): any {
  return fakeCtx({ [SESSION_ID]: { header: { cwd: "/projects/team" } } });
}

test("saveText writes a tool-result spill inside the session container", async () => {
  const { writes, mkdirs, resolver } = guestFileRecorder();
  const store = createSpillStore(withSession(), resolver as never);
  const content = "x".repeat(60000);
  const ref = await store.saveText({
    owner: { sessionId: SESSION_ID },
    source: { kind: "tool", toolName: "web_fetch", callId: "c1", label: "result" },
    suggestedName: "web_fetch.txt",
    content,
  });
  assert.equal(mkdirs[0], `/tmp/dsh-podman/spill/${SEGMENT}`);
  assert.equal(writes.length, 1);
  assert.match(
    writes[0].path,
    new RegExp(`^/tmp/dsh-podman/spill/${SEGMENT}/[0-9a-f]{32}-web_fetch\\.txt$`),
  );
  assert.equal(ref.locator, writes[0].path);
  assert.equal(ref.bytes, content.length);
  assert.equal(writes[0].content, content, "the full text is persisted verbatim");
  assert.match(ref.retrievalHint, /container_read/);
});

test("saveText never lets the suggested name escape the spill directory", async () => {
  const { writes, resolver } = guestFileRecorder();
  const store = createSpillStore(withSession(), resolver as never);
  const ref = await store.saveText({
    owner: { sessionId: SESSION_ID },
    source: {},
    suggestedName: "../../etc/passwd",
    content: "x",
  });
  assert.ok(ref.locator.startsWith(`/tmp/dsh-podman/spill/${SEGMENT}/`));
  assert.ok(!ref.locator.includes(".."));
  assert.equal(writes.length, 1);
});

test("sessionSegment neutralizes path-shaped session ids", () => {
  // A session id is not necessarily a UUID, so it must never survive as a path
  // segment that can traverse or collide.
  for (const id of ["..", ".", "../../etc", "a/b", "session-1", "sess..ion", ""]) {
    const segment = sessionSegment(id);
    assert.notEqual(segment, "");
    assert.notEqual(segment, ".");
    assert.notEqual(segment, "..");
    assert.doesNotMatch(segment, /[^A-Za-z0-9_-]/);
    assert.ok(!segment.includes(".."), `${JSON.stringify(id)} -> ${segment}`);
  }
  // Distinct ids never share a directory, even when their readable prefixes do.
  assert.notEqual(sessionSegment("session-1"), sessionSegment("session_1"));
  // The readable prefix is kept for debugging.
  assert.match(sessionSegment("session-42"), /^session-42-/);
  // A UUID-shaped id stays recognizable.
  assert.match(SEGMENT, /^2c573001-4171-4900-904b-[0-9a-f]+$/);
  assert.equal(sessionSegment(SESSION_ID), SEGMENT);
});

test("saveText rejects when the session has no working directory", async () => {
  const { resolver } = guestFileRecorder();
  const store = createSpillStore(fakeCtx({}), resolver as never);
  await assert.rejects(
    () =>
      store.saveText({
        owner: { sessionId: SESSION_ID },
        source: {},
        suggestedName: "a.txt",
        content: "x",
      }),
    /no session working directory/,
  );
});
