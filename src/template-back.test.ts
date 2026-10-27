// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { en, zh } from "./client/locales.js";

// A client source file, read only in a source checkout: `pnpm test` runs from
// dist/, where the card's sources are not shipped.
function clientSource(name: string): string | undefined {
  const url = new URL(`../src/client/${name}`, import.meta.url);
  return existsSync(url) ? readFileSync(url, "utf8") : undefined;
}

// sliceBetween returns the source between two markers, asserting both exist in
// that order. It keeps one modal's checks from matching another's code.
function sliceBetween(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end);
  assert.ok(from >= 0, `${start} is present`);
  assert.ok(to > from, `${end} follows ${start}`);
  return source.slice(from, to);
}

test("both editors offer Back only when supplied, before their other action", (t) => {
  const create = clientSource("container-card-create-modal.tsx");
  const edit = clientSource("container-card-edit-modal.tsx");
  if (create === undefined || edit === undefined) {
    t.skip("not a source checkout");
    return;
  }
  for (
    const [name, source, other] of [
      ["create", create, 't("cancel")'],
      ["edit", edit, 't("discard")'],
    ] as const
  ) {
    // The prop is optional, so an editor opened outside the template flow can
    // never render the action.
    assert.match(source, /onBack\?: \(\) => void;/);
    assert.match(source, /\{onBack === undefined \? null : \(/);
    // Back is the harness's outlined small button and reuses the popup's own
    // Back label; it comes before Cancel/Discard.
    assert.match(
      source,
      /<Button\s+variant="outline"\s+size="sm"\s+onClick=\{requestBack\}\s*>\s*\{t\("templateBack"\)\}/,
    );
    const back = source.indexOf('t("templateBack")');
    const sibling = source.indexOf(other);
    assert.ok(back >= 0, `${name} renders a Back label`);
    assert.ok(
      sibling > back,
      `${name}'s Back sits before ${other}`,
    );
  }
  // The row passes Back to the edit dialog only for a template prefill and
  // hands it the configuration the template supplied.
  const row = clientSource("container-card-row.tsx");
  if (row === undefined) return;
  assert.match(
    row,
    /onBack=\{prefill === undefined \|\| onEditBack === undefined\s*\? undefined/,
  );
  assert.match(row, /backBaseline=\{prefill\?\.config\}/);
  assert.match(row, /setOpen\(false\);\s*onEditBack\(\);/);
});

test("an untouched draft goes Back at once, a changed one asks first", (t) => {
  const create = clientSource("container-card-create-modal.tsx");
  const edit = clientSource("container-card-edit-modal.tsx");
  if (create === undefined || edit === undefined) {
    t.skip("not a source checkout");
    return;
  }
  // The create modal already measures its draft against the pristine template
  // configuration, name included; the edit modal compares against the config
  // its row received with the prefill.
  assert.match(
    create,
    /const dirty = name !== "" \|\| !configsEqual\(draft, pristine\);/,
  );
  assert.match(
    create,
    /const requestBack = \(\): void => \{\s*if \(dirty\) setConfirmBack\(true\);\s*else onBack\?\.\(\);/,
  );
  assert.match(
    edit,
    /const backDirty = backBaseline !== undefined &&\s*!configsEqual\(draft, backBaseline\);/,
  );
  assert.match(
    edit,
    /if \(backDirty\) setConfirmBack\(true\);\s*else onBack\?\.\(\);/,
  );
  for (const source of [create, edit]) {
    // A confirmation's cancel only dismisses it, leaving the editor open with
    // its changes; its discard action is what calls Back.
    assert.match(source, /onCancel=\{\(\) => setConfirmBack\(false\)\}/);
    assert.match(source, /onDiscard=\{discardAndBack\}/);
    assert.match(
      source,
      /const discardAndBack = \(\): void => \{\s*setConfirmBack\(false\);\s*onBack\?\.\(\);/,
    );
  }
  // configsEqual is the one comparison behind that decision: it compares every
  // field group the editor can edit, so a change to any of them counts.
  const config = clientSource("container-card-config.ts");
  if (config === undefined) return;
  const equals = sliceBetween(
    config,
    "export function configsEqual",
    "// The stable identity",
  );
  for (
    const field of ["image", "env", "mounts", "paths", "secretEnv", "ports"]
  ) {
    assert.match(equals, new RegExp(`\\b${field}\\b`));
  }
});

test("the workspace records the popup draft and reopens it on Back", (t) => {
  const workspace = clientSource("container-card-workspace.tsx");
  if (workspace === undefined) {
    t.skip("not a source checkout");
    return;
  }
  assert.match(
    workspace,
    /const \[templateResume, setTemplateResume\] = useState<TemplateResume \| null>\(\s*null,\s*\);/,
  );
  // Continue stores the payload the details popup hands up.
  assert.match(
    workspace,
    /onContinue=\{\(mode, container, config, source, resume\) => \{\s*setTemplateOpen\(false\);\s*setTemplateResume\(resume \?\? null\);/,
  );
  // The edit editor's Back drops the one-shot prefill and reopens the popup on
  // that payload; the create editor's Back closes it without creating.
  assert.match(
    workspace,
    /onEditBack=\{templateResume === null \? undefined : \(\) => \{[\s\S]*?setEditPrefill\(null\);[\s\S]*?setTemplateOpen\(true\);/,
  );
  assert.match(
    workspace,
    /onBack=\{templateResume === null \|\| createPrefill === null\s*\? undefined\s*: \(\) => \{[\s\S]*?setCreateOpen\(null\);[\s\S]*?setCreatePrefill\(null\);[\s\S]*?setTemplateOpen\(true\);/,
  );
  // Closing the popup resets it, and the flow's own ends do too: a successful
  // edit Apply and the create editor's close or create.
  assert.match(
    workspace,
    /onClose=\{\(\) => \{\s*setTemplateOpen\(false\);\s*setTemplateResume\(null\);/,
  );
  assert.match(
    workspace,
    /const applied = await onApplyContainerConfig[\s\S]*?setTemplateResume\(null\);/,
  );
  const clears = workspace.match(/setTemplateResume\(null\)/g) ?? [];
  assert.ok(
    clears.length >= 4,
    "the popup close, apply, create close and create clear the payload",
  );
});

test("the popup reopens on its recorded details and prefers that draft", (t) => {
  const modal = clientSource("container-card-templates.tsx");
  if (modal === undefined) {
    t.skip("not a source checkout");
    return;
  }
  // The payload carries the selection, the draft and the whole destination
  // choice, so nothing depends on the editor's own state.
  assert.match(
    modal,
    /export interface TemplateResume \{[\s\S]*?selection: TemplateSelection;[\s\S]*?draft: TemplateEditorConfig;[\s\S]*?mode: "create" \| "replace";[\s\S]*?replaceTarget: string;[\s\S]*?replaceFilter: string;\s*\}/,
  );
  assert.match(modal, /resume\?: TemplateResume \| null;/);
  // A resume opens the details step directly instead of the picker.
  assert.match(
    modal,
    /if \(resume === undefined \|\| resume === null\) return;\s*setSelection\(resume\.selection\);\s*setStage\("details"\);/,
  );
  // Only the selection the payload was recorded for takes its initial state.
  assert.match(modal, /initialDraft=\{resumeActive\?\.draft\}/);
  assert.match(modal, /initialMode=\{resumeActive\?\.mode\}/);
  assert.match(modal, /initialReplaceTarget=\{resumeActive\?\.replaceTarget\}/);
  assert.match(modal, /initialReplaceFilter=\{resumeActive\?\.replaceFilter\}/);
  const details = sliceBetween(
    modal,
    "function TemplateDetailsModal",
    "export function LoadTemplateModal",
  );
  // The provided draft seeds the popup instead of the template's own plan...
  assert.match(details, /setDraft\(initialDraft \?\? null\)/);
  assert.match(details, /setMode\(initialMode \?\? "create"\)/);
  assert.match(details, /setReplaceTarget\(\s*initialReplaceTarget \?\?/);
  assert.match(details, /setReplaceFilter\(initialReplaceFilter \?\? ""\)/);
  // ...while the template is still inspected, so the image state and storage
  // lists describe the moment the popup reopened.
  assert.match(details, /actionsRef\.current\.inspectTemplate\(/);
  assert.match(
    details,
    /setDraft\(\(previous\) =>\s*previous \?\?\s*templateConfigForEditor\(/,
  );
  assert.doesNotMatch(details, /setDraft\(null\)/);
  // The resumed draft's project paths are checked once on open, like a freshly
  // seeded draft's.
  assert.match(details, /void checkProjects\(initialDraft\);/);
  // Continue hands the popup state up again for a later Back; the replace
  // source is the inspection's canonical document, the resume selection the one
  // the popup was opened on.
  assert.match(
    details,
    /const source = \{ name: inspection\.name, yaml: inspection\.yaml \};\s*const resume: TemplateResume = \{\s*selection: selection \?\? source,\s*draft: currentDraft,\s*mode,\s*replaceTarget,\s*replaceFilter,\s*\};/,
  );
  assert.match(details, /undefined,\s*resume,/);
  assert.match(details, /source,\s*resume,/);
});

test("Back reuses the existing templateBack label in both locales", () => {
  assert.equal(en.templateBack, "Back");
  assert.equal(zh.templateBack, "返回");
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
});
