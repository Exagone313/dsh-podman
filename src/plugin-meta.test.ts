// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The display name the Plugins page shows comes from the package's exported
// locale metadata. Without the `exports` entry the Host cannot resolve the
// file, and without the `files` entry a packed install has no file to resolve:
// both fall back silently to the scoped package name, so both are asserted.

function localeMeta(language: string): any {
  return JSON.parse(
    readFileSync(new URL(`../locale/${language}.json`, import.meta.url), "utf8"),
  );
}

function manifest(): any {
  return JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
}

test("the locale metadata declares the plugin's display name", () => {
  for (const language of ["en", "zh"]) {
    const meta = localeMeta(language).meta;
    assert.equal(meta.title, "dsh-podman", `${language}: meta.title`);
    assert.equal(
      typeof meta.description,
      "string",
      `${language}: meta.description must be a string`,
    );
    assert.notEqual(
      meta.description.trim(),
      "",
      `${language}: meta.description must not be empty`,
    );
  }
});

test("the locale metadata is exported and shipped", () => {
  const pkg = manifest();
  assert.equal(
    pkg.exports["./locale/*.json"],
    "./locale/*.json",
    "package.json must export the locale metadata",
  );
  assert.ok(
    pkg.files.includes("locale/*.json"),
    "package.json files must ship locale/*.json",
  );
});
