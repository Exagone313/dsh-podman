// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import { versionFromPackages } from "./dsh-version.js";

test("versionFromPackages reads the app version through the profile lookup", () => {
  const packages = {
    packageOf: (specifier: string, parentURL: string) => {
      assert.equal(specifier, "@deepseek-ai/dsh");
      assert.ok(parentURL.startsWith("file:"), "lookup uses this module's URL");
      return { version: "1.2.3" };
    },
  };
  assert.equal(versionFromPackages(packages), "1.2.3");
});

test("versionFromPackages reports no version when the package is unknown", () => {
  assert.equal(versionFromPackages({ packageOf: () => undefined }), undefined);
});

test("versionFromPackages ignores a missing lookup and unusable versions", () => {
  assert.equal(versionFromPackages(undefined), undefined);
  assert.equal(versionFromPackages({}), undefined);
  assert.equal(
    versionFromPackages({ packageOf: () => ({ version: "" }) }),
    undefined,
  );
  assert.equal(
    versionFromPackages({ packageOf: () => ({ version: 3 }) }),
    undefined,
  );
});
