// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// The Add-mount popup is rendered in the browser, which this environment has no
// DOM for. The project-path decision itself is exercised directly in
// project-path.test.ts; here the popup is read from a source checkout so the
// wiring — the typed lexical check, the blur-only listing, the Add gate and the
// one error slot — cannot silently regress.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

// A client source file, read only in a source checkout: `pnpm test` runs from
// dist/, where the card's sources are not shipped.
function clientSource(name: string): string | undefined {
  const url = new URL(`../src/client/${name}`, import.meta.url);
  return existsSync(url) ? readFileSync(url, "utf8") : undefined;
}

test("the Add-mount popup validates a typed project path and blocks Add", (t) => {
  const editors = clientSource("container-card-editors.tsx");
  if (editors === undefined) {
    t.skip("not a source checkout");
    return;
  }
  // The path is judged lexically as it is typed, with the same pure decision
  // the submit makes. An absolute or escaping value therefore refuses Add
  // immediately and is worded as the invalid path, while a missing directory
  // is a different mistake with its own wording.
  assert.match(
    editors,
    /const draftProjectDecision = draft\.kind === "project"\s*\? decideProjectPath\(\{\s*origin: projectOrigin,\s*project: draft\.project,\s*directoryExists: true,?\s*\}\)\s*:\s*undefined;/,
  );
  assert.match(
    editors,
    /draftProjectDecision\?\.ok === true && !draftProjectMissing && !listing/,
  );
  assert.match(
    editors,
    /draftProjectError = projectPathError\(t, draftProjectDecision\.reason\)/,
  );
  assert.match(
    editors,
    /reason === "missing"\s*\? "mountProjectPathMissing"\s*: "mountProjectPathInvalid",/,
  );
  // An empty path is a choice still to make: it stays quiet until the field is
  // left or a non-empty value is typed, and Add is already refused because the
  // decision is not ok.
  assert.match(
    editors,
    /if \(draftProjectDecision\.reason !== "empty" \|\| projectTouched\) \{/,
  );
  assert.match(
    editors,
    /setProjectListing\(undefined\);\s*setListing\(false\);\s*setProjectTouched\(patch\.project !== ""\);/,
  );
  // The host is asked only when the field loses focus, through the existing
  // listing helper, and its answer is kept with the value it was started for
  // so a stale listing never marks a newer value. A negative answer shows the
  // missing wording and blocks Add through the same listing state.
  assert.match(
    editors,
    /const checkDraftProject = async \(\): Promise<void> => \{\s*setProjectTouched\(true\);/,
  );
  assert.match(
    editors,
    /const exists = await projectDirectoryExists\(\s*directoryPicker,\s*projectsRoot,\s*project,?\s*\)/,
  );
  assert.match(
    editors,
    /setProjectListing\(\{ project, missing: !exists \}\)/,
  );
  assert.match(
    editors,
    /draftProjectError = t\("mountProjectPathMissing"\)/,
  );
  assert.match(editors, /if \(token !== checkToken\.current\) return;/);
  // A browsed path already names a listed directory, so it skips both checks;
  // the submit-time check stays the final gate for a typed one.
  assert.match(editors, /projectOrigin === "browsed" \|\|/);
  assert.match(
    editors,
    /if \(projectOrigin === "typed" && directoryPicker !== undefined\) \{/,
  );
  assert.match(
    editors,
    /setBrowseError\(projectPathError\(t, decision\.reason\)\);/,
  );
  // The single error slot under the row carries the project message for a
  // project mount and the destination message for every other kind.
  assert.match(
    editors,
    /const draftError = draft\.kind === "project"\s*\? draftProjectError\s*:\s*draftDestinationError;/,
  );
  assert.match(editors, /error=\{draftError\}/);
  // The draft row's own blur runs the listing.
  assert.match(
    editors,
    /onProjectBlur=\{\(\) => void checkDraftProject\(\)\}/,
  );
  // Picking another kind drops the previous project answer and message
  // instead of letting them judge the new source.
  const kindStart = editors.indexOf(
    "const next = emptyMount(event.target.value)",
  );
  const kindEnd = editors.indexOf("</select>", kindStart);
  assert.ok(kindStart >= 0 && kindEnd > kindStart);
  const kindChange = editors.slice(kindStart, kindEnd);
  assert.match(kindChange, /checkToken\.current \+= 1;/);
  assert.match(kindChange, /setProjectListing\(undefined\);/);
  assert.match(kindChange, /setListing\(false\);/);
  assert.match(kindChange, /setProjectTouched\(false\);/);
  // A listing that fails outright leaves the value unchecked instead of
  // reporting it missing.
  const blurStart = editors.indexOf("const checkDraftProject");
  const blurEnd = editors.indexOf("const submit = async", blurStart);
  assert.ok(blurStart >= 0 && blurEnd > blurStart);
  const blur = editors.slice(blurStart, blurEnd);
  assert.match(blur, /catch \{/);
  assert.doesNotMatch(blur, /catch \{[^}]*setProjectListing/);
  assert.match(blur, /setProjectTouched\(true\);/);
  assert.match(
    blur,
    /if \(token === checkToken\.current\) setListing\(false\);/,
  );
});
