// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  harnessVersionFromManifest,
  pinnedDshVersion,
  versionFromPackages,
} from "./dsh-version.js";

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

test("harnessVersionFromManifest reads the pinned harness dependency", () => {
  assert.equal(
    harnessVersionFromManifest({
      peerDependencies: { "@deepseek-ai/dsh-subprocess": "1.2.3" },
    }),
    "1.2.3",
  );
});

test("harnessVersionFromManifest reports no version when it is not pinned", () => {
  for (
    const manifest of [
      undefined,
      null,
      {},
      { peerDependencies: {} },
      { peerDependencies: { "@deepseek-ai/dsh-subprocess": "" } },
      { peerDependencies: { "@deepseek-ai/dsh-subprocess": 3 } },
      { peerDependencies: { "@deepseek-ai/other": "1.2.3" } },
    ]
  ) {
    assert.equal(
      harnessVersionFromManifest(manifest),
      "",
      `unexpected version for ${JSON.stringify(manifest)}`,
    );
  }
});

test("pinnedDshVersion matches Containerfile.dsh's ARG DSH_VERSION", (context) => {
  const containerfile = new URL("../Containerfile.dsh", import.meta.url);
  if (!existsSync(containerfile)) {
    context.skip("not a source checkout");
    return;
  }
  const match = /^ARG\s+DSH_VERSION=(\S+)/m.exec(
    readFileSync(containerfile, "utf8"),
  );
  assert.ok(match, "Containerfile.dsh must declare ARG DSH_VERSION");
  assert.equal(pinnedDshVersion(), match[1]);
});
