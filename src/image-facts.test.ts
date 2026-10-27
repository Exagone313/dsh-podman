// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

// A client source file, read only in a source checkout: `pnpm test` runs from
// dist/, where the card's sources are not shipped.
function clientSource(name: string): string | undefined {
  const url = new URL(`../src/client/${name}`, import.meta.url);
  return existsSync(url) ? readFileSync(url, "utf8") : undefined;
}

test("ImageFacts states the facts every image block shares", (t) => {
  const source = clientSource("image-facts.tsx");
  if (source === undefined) {
    t.skip("not a source checkout");
    return;
  }
  // The name, its status chip and the default pill all sit on the name line.
  assert.match(
    source,
    /<span style=\{containerNameHeading\}>\{imageId\}<\/span>/,
  );
  assert.match(
    source,
    /<StatusChip\s+tone=\{imageStatusTone\(status\)\}\s+label=\{imageStatusLabel\(t, status\)\}\s+\/>/,
  );
  assert.match(
    source,
    /isDefault === true \? <Pill>\{t\("defaultImage"\)\}<\/Pill> : null/,
  );
  // A dated image shows its relative build time with the exact instant as the
  // tooltip; an undated one omits the line rather than printing a placeholder.
  assert.match(source, /\{builtAt === "" \? null : \(/);
  assert.match(source, /<ImageField label=\{t\("built"\)\}>/);
  assert.match(
    source,
    /<span title=\{builtAt\}>\{relativeTimeLabel\(builtAt, locale\)\}<\/span>/,
  );
  // The parent/primitive line is absent when the snapshot names neither: an
  // empty source takes the no-line branch, while a non-empty one still renders
  // the field.
  assert.match(
    source,
    /\{source === ""\s*\? null\s*: <ImageField label=\{t\("parentImage"\)\}>\{source\}<\/ImageField>\}/,
  );
  // Packages are chips on their own line, with the shared empty wording when
  // none were recorded.
  assert.match(
    source,
    /packages\.map\(\(pkg\) => <Chip key=\{pkg\} t=\{t\} label=\{pkg\} \/>\)/,
  );
  assert.match(
    source,
    /if \(packages\.length === 0\) return t\("noPackages"\);/,
  );
  // The packages field is optional: an image with no package list at all omits
  // it, while an image with an empty list still states that none were recorded.
  assert.match(source, /packages\?: readonly string\[\] \| undefined;/);
  assert.match(source, /\{packages === undefined/);
  assert.match(
    source,
    /<ImageField label=\{t\("packages"\)\} ownLine>/,
  );
  // The image's own actions are a slot, so the settings tab can keep its
  // Rebuild/Set default/Remove group without the facts knowing about them.
  assert.match(
    source,
    /\{actions === undefined \? null : <div style=\{rowActions\}>\{actions\}<\/div>\}/,
  );
});

test("the settings images tab renders the shared facts", (t) => {
  const source = clientSource("container-card-images.tsx");
  if (source === undefined) {
    t.skip("not a source checkout");
    return;
  }
  const block = source.slice(
    source.indexOf("function ImageBlock"),
    source.indexOf("export function ImageItem"),
  );
  assert.ok(block.length > 0, "the image block must be found");
  // The block is the shared facts plus its actions: every fact comes from the
  // image snapshot, including its build time and source.
  assert.match(block, /<ImageFacts/);
  assert.match(block, /builtAt=\{image\.builtAt\}/);
  assert.match(block, /source=\{source\}/);
  assert.match(block, /packages=\{image\.packages\}/);
  assert.match(block, /isDefault=\{image\.imageId === defaultImage\}/);
  assert.match(block, /actions=\{actions\}/);
  // The block no longer renders facts itself, so the popup and the tab cannot
  // drift apart.
  assert.doesNotMatch(block, /<StatusChip/);
  assert.doesNotMatch(block, /relativeTimeLabel/);
  assert.doesNotMatch(block, /<ImageField/);
});
