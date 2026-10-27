// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
// Importing the client dictionary here also typechecks it under the host
// program, which has no DOM lib: it must stay environment-free data.
import { en, zh } from "./client/locales.js";

// A confirmation that acts on one object must name it. Each call site passes the
// placeholder listed here, so dropping a subject from either language fails.
const SUBJECTS: readonly (readonly [keyof typeof en, string])[] = [
  ["confirmRemoveWorkspace", "workspace"],
  ["confirmRemoveContainer", "workspace"],
  ["confirmRemoveContainer", "container"],
  ["confirmRemovePtc", "container"],
  ["confirmRecreate", "workspace"],
  ["confirmRecreate", "container"],
  ["confirmUpdate", "workspace"],
  ["confirmUpdate", "container"],
  ["confirmRebuildImage", "image"],
  ["confirmRemoveImage", "image"],
  ["confirmRemoveVolume", "volume"],
  ["confirmRemoveSecret", "secret"],
  ["confirmRemoveMount", "mount"],
  ["confirmUnpublishPort", "port"],
];

test("every object-naming confirmation interpolates its subject", () => {
  for (const [key, placeholder] of SUBJECTS) {
    for (const [language, dictionary] of [["en", en], ["zh", zh]] as const) {
      assert.ok(
        dictionary[key].includes(`{${placeholder}}`),
        `${language} ${key} must name {${placeholder}}`,
      );
    }
  }
});

test("the template picker offers editing the existing container", () => {
  // The segmented control's second option opens the chosen container's editor,
  // so both languages name that action rather than a replacement.
  assert.equal(en.templateReplaceContainer, "Edit existing container");
  assert.equal(zh.templateReplaceContainer, "编辑现有容器");
});

test("the draft validation strings exist in both languages with their placeholders", () => {
  const keys: readonly (keyof typeof en)[] = [
    "templateSecretMissing",
    "templateVolumeMissing",
    "templateProjectMissing",
    "templateProjectInvalid",
    "templateChooseProject",
    "templateChooseVolume",
    "templateChooseSecret",
    "templateImageMissing",
    "templateCheckingReferences",
    "templateReferenceMissingOne",
    "templateReferenceMissingMany",
  ];
  for (const key of keys) {
    assert.ok(en[key].length > 0, `en ${key} has wording`);
    assert.ok(zh[key].length > 0, `zh ${key} has wording`);
  }
  // The subject-naming strings keep their placeholder in both languages.
  for (
    const [key, placeholder] of [
      ["templateSecretMissing", "secret"],
      ["templateVolumeMissing", "volume"],
      ["templateProjectMissing", "project"],
      ["templateProjectInvalid", "project"],
      ["templateReferenceMissingMany", "n"],
    ] as const
  ) {
    assert.ok(en[key].includes(`{${placeholder}}`), `en ${key}`);
    assert.ok(zh[key].includes(`{${placeholder}}`), `zh ${key}`);
  }
});

test("the mount destination messages exist in both languages", () => {
  const keys = [
    "mountDestinationRequired",
    "mountDestinationAbsolute",
    "mountDestinationClean",
    "mountDestinationReserved",
  ] as const;
  for (const key of keys) {
    assert.ok(en[key].length > 0, `en ${key} has wording`);
    assert.ok(zh[key].length > 0, `zh ${key} has wording`);
  }
  // The overlap message names the reserved path it refuses in both languages.
  assert.ok(en.mountDestinationReserved.includes("{path}"));
  assert.ok(zh.mountDestinationReserved.includes("{path}"));
  // The clean-path message names the shapes it refuses in both languages.
  for (const dictionary of [en, zh]) {
    assert.match(dictionary.mountDestinationClean, /\.\./);
  }
});

test("the template reference messages name the offending value", () => {
  // One wording per failure, always naming what it is about: a volume, a
  // secret, or the project path the host refused.
  assert.equal(en.templateVolumeMissing, "Volume “{volume}” does not exist.");
  assert.equal(en.templateSecretMissing, "Secret “{secret}” does not exist.");
  assert.equal(
    en.templateProjectMissing,
    "Project “{project}” does not exist under the projects root.",
  );
  assert.equal(
    en.templateProjectInvalid,
    "Project “{project}” is not a valid project path.",
  );
  assert.equal(en.templateChooseVolume, "Choose a volume.");
  assert.equal(en.templateChooseSecret, "Choose a secret.");
  assert.equal(en.templateChooseProject, "Choose a project.");
  // Chinese keeps the same subjects and punctuation shape.
  for (
    const key of [
      "templateVolumeMissing",
      "templateSecretMissing",
      "templateProjectMissing",
      "templateProjectInvalid",
    ] as const
  ) {
    assert.ok(zh[key].includes("“"), `zh ${key} quotes the name`);
    assert.doesNotMatch(zh[key], /…/, `zh ${key} carries no ellipsis`);
  }
});

test("the popup's actions carry no ellipsis", () => {
  // The details popup's Create volume, Create secret and row-action Browse
  // state their action outright; no wording ends in an ellipsis.
  for (const [language, dictionary] of [["en", en], ["zh", zh]] as const) {
    for (
      const key of ["createVolume", "createSecret", "templateBrowse"] as const
    ) {
      assert.doesNotMatch(
        dictionary[key],
        /…/,
        `${language} ${key} has no ellipsis`,
      );
    }
  }
});

test("both languages carry exactly the same keys", () => {
  // The dictionaries are typed as Record<ContainerPluginKey, string>, and this
  // keeps a key added to or removed from one language from drifting silently.
  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
});
