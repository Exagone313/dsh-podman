// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// The client edits are rendered in the browser, which this environment has no
// DOM for. The validator itself is exercised directly in
// container-card-mount-sources.test.ts; here the two components that use it are
// read from a source checkout to keep the wiring — the Add gate, the row's error
// slot and the form's blocking channel — from silently regressing.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

// A client source file, read only in a source checkout: `pnpm test` runs from
// dist/, where the card's sources are not shipped.
function clientSource(name: string): string | undefined {
  const url = new URL(`../src/client/${name}`, import.meta.url);
  return existsSync(url) ? readFileSync(url, "utf8") : undefined;
}

test("the Add-mount popup refuses an invalid destination on every kind", (t) => {
  const editors = clientSource("container-card-editors.tsx");
  if (editors === undefined) {
    t.skip("not a source checkout");
    return;
  }
  // The draft is checked with the shared helper, which validates volume, secret
  // and tmpfs alike and exempts project mounts. Tmpfs no longer renders Add
  // enabled without a destination.
  assert.match(
    editors,
    /import \{[^}]*nonProjectDestinationError[^}]*\} from "\.\/container-card-mount-sources\.js";/,
  );
  assert.match(
    editors,
    /nonProjectDestinationError\(\s*draft\.kind,\s*draft\.destination,\s*projectsRoot,?\s*\)/,
  );
  // A refused destination is folded into canAdd, and Add reads canAdd.
  assert.match(editors, /const canAdd = draftDestination === undefined &&/);
  assert.match(editors, /disabled=\{busy \|\| !canAdd \|\| checking\}/);
  // The message is shown under the row through the shared row's error slot,
  // translated with the reserved path when that is the reason; a project mount
  // puts its own project message there instead.
  assert.match(
    editors,
    /const draftError = draft\.kind === "project"\s*\? draftProjectError\s*:\s*draftDestinationError;/,
  );
  assert.match(editors, /error=\{draftError\}/);
  assert.match(
    editors,
    /t\(draftDestination\.key, draftDestination\.params\)/,
  );
  // The dialog body is not the editor's row list, so the popup wraps its draft
  // row in a column-gap container of its own: the trailing message then sits
  // 8px below the row instead of flush against it.
  assert.match(
    editors,
    /<div style=\{\{ display: "flex", flexDirection: "column", gap: "8px" \}\}>\s*<MountRow\b[\s\S]*?<\/div>\s*<\/Modal>/,
  );
});

test("the container form blocks on a destination and keeps other errors", (t) => {
  const form = clientSource("container-card-form.tsx");
  if (form === undefined) {
    t.skip("not a source checkout");
    return;
  }
  // The form validates its current mounts, and names the first refused one when
  // no variable editor already blocks the action: a field's own reason is never
  // cleared or overridden by the destination.
  assert.match(
    form,
    /firstMountDestinationError\(\s*mounts,\s*projectsRoot,?\s*\)/,
  );
  assert.match(
    form,
    /const blockingKey = blocking\.env \?\? blocking\.secretEnv \?\?\s*mountDestinationBlocking;/,
  );
  assert.match(form, /onBlockingError\?\.\(blockingKey\)/);
  assert.match(form, /return \(\) => onBlockingError\?\.\(undefined\)/);
  // Each listed row gets its own translated destination message through the
  // editor's existing row-error plumbing.
  assert.match(form, /rowError=\{reportMountError\}/);
  assert.match(
    form,
    /nonProjectDestinationError\(\s*mount\.kind,\s*mount\.destination,\s*projectsRoot,?\s*\)/,
  );
  assert.match(
    form,
    /return error === undefined \? undefined : t\(error\.key, error\.params\)/,
  );
});
