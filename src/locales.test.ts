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
