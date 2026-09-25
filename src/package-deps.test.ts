// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

// Every harness dependency must be an exact version: the set moves together
// with the supported dsh release, and a caret quietly allowed the manifest to
// drift a release behind the image.
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const SECTIONS = ["devDependencies", "peerDependencies"] as const;

function manifest(): Record<string, Record<string, string>> {
  return JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
}

test("every @deepseek-ai specifier is an exact version", () => {
  const pkg = manifest();
  for (const section of SECTIONS) {
    for (const [name, specifier] of Object.entries(pkg[section] ?? {})) {
      if (!name.startsWith("@deepseek-ai/")) continue;
      assert.match(
        String(specifier),
        EXACT_VERSION,
        `${section}: "${name}": "${specifier}" must be an exact version`,
      );
    }
  }
});

test("every peer dependency is declared optional", () => {
  const pkg = manifest() as unknown as {
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  };
  for (const name of Object.keys(pkg.peerDependencies ?? {})) {
    assert.equal(
      pkg.peerDependenciesMeta?.[name]?.optional,
      true,
      `peerDependenciesMeta["${name}"].optional must be true`,
    );
  }
});

test("every @deepseek-ai/dsh-* specifier matches ARG DSH_VERSION", (context) => {
  const containerfile = new URL("../Containerfile.dsh", import.meta.url);
  if (!existsSync(containerfile)) {
    context.skip("not a source checkout");
    return;
  }
  const match = /^ARG\s+DSH_VERSION=(\S+)/m.exec(
    readFileSync(containerfile, "utf8"),
  );
  assert.ok(match, "Containerfile.dsh must declare ARG DSH_VERSION");
  const dshVersion = match[1];
  assert.match(dshVersion, EXACT_VERSION, "ARG DSH_VERSION must be exact");
  const pkg = manifest();
  for (const section of SECTIONS) {
    for (const [name, specifier] of Object.entries(pkg[section] ?? {})) {
      if (!name.startsWith("@deepseek-ai/dsh-")) continue;
      assert.equal(
        specifier,
        dshVersion,
        `${section}: "${name}": "${specifier}" must match ARG DSH_VERSION (${dshVersion})`,
      );
    }
  }
});
