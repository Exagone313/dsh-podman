// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import { relativeTimeLabel } from "./client/relative-time.js";

const NOW = Date.parse("2026-10-20T12:00:00Z");

function at(secondsAgo: number): string {
  return new Date(NOW - secondsAgo * 1000).toISOString();
}

test("a creation under a minute reads in seconds, never as today", () => {
  assert.equal(relativeTimeLabel(at(0), "en", NOW), "1 second ago");
  assert.equal(relativeTimeLabel(at(0.5), "en", NOW), "1 second ago");
  assert.equal(relativeTimeLabel(at(5), "en", NOW), "5 seconds ago");
  assert.equal(relativeTimeLabel(at(59), "en", NOW), "59 seconds ago");
});

test("the first minute still switches to minutes", () => {
  assert.equal(relativeTimeLabel(at(60), "en", NOW), "1 minute ago");
  assert.equal(relativeTimeLabel(at(90), "en", NOW), "1 minute ago");
});

test("a clock ahead of the browser reads as a fresh creation", () => {
  assert.equal(
    relativeTimeLabel(new Date(NOW + 5000).toISOString(), "en", NOW),
    "1 second ago",
  );
});

test("a stamp the browser cannot read is returned unchanged", () => {
  assert.equal(
    relativeTimeLabel("not a timestamp", "en", NOW),
    "not a timestamp",
  );
});

test("an elapsed day still reads as yesterday", () => {
  assert.equal(relativeTimeLabel(at(24 * 60 * 60), "en", NOW), "yesterday");
});
