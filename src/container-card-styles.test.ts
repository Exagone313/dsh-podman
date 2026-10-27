// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  templateAction,
  templateActionSelected,
  violetTone,
} from "./client/container-card-styles.js";
import { PTC_CHIP_TONE } from "./client/container-card-ptc.js";

const VIOLET = "#a78bfa";
const VIOLET_FILL = "color-mix(in srgb, #a78bfa 12%, transparent)";

// A client source file, read only in a source checkout: `pnpm test` runs from
// dist/, where the card's sources are not shipped.
function clientSource(name: string): string | undefined {
  const url = new URL(`../src/client/${name}`, import.meta.url);
  return existsSync(url) ? readFileSync(url, "utf8") : undefined;
}

test("the template action uses the PTC and tmpfs violet verbatim", () => {
  // One literal and one fill percentage: the template buttons match the PTC
  // chip and the tmpfs marker exactly rather than merely looking close.
  assert.equal(violetTone.color, VIOLET);
  assert.equal(violetTone.background, VIOLET_FILL);
  assert.deepEqual(templateAction, {
    color: VIOLET,
    borderColor: VIOLET,
    background: VIOLET_FILL,
  });
  // The selected load target keeps the same ink and stroke, with a stronger
  // tint of the same literal.
  assert.equal(templateActionSelected.color, VIOLET);
  assert.equal(templateActionSelected.borderColor, VIOLET);
  assert.equal(
    templateActionSelected.background,
    `color-mix(in srgb, ${VIOLET} 20%, transparent)`,
  );
});

test("the PTC and tmpfs tones read that same violet literal", () => {
  assert.equal(PTC_CHIP_TONE, "violet");
  const shared = clientSource("container-card-shared.tsx");
  if (shared === undefined) return;
  assert.match(
    shared,
    /import \{[^}]*\bvioletTone\b[^}]*\} from "\.\/container-card-styles\.js";/,
  );
  // The violet tone is the shared style itself, so the PTC chip and the tmpfs
  // marker cannot drift from the template actions.
  assert.match(shared, /violet: violetTone,/);
  // tmpfs selects the violet tone; both violet consumers read STATUS_TONES.
  assert.match(shared, /normalized === "tmpfs"\) return "violet";/);
  // No second copy of the literal is left in the card's shared styles.
  assert.equal(shared.includes(VIOLET), false);
});

test("the template popups read the shared violet, never their own literal", () => {
  const source = clientSource("container-card-templates.tsx");
  if (source === undefined) return;
  // Every template action and the picker's chosen row paint with the shared
  // styles, so a new literal cannot drift from the PTC and tmpfs tones.
  assert.equal(source.includes(VIOLET), false);
  assert.match(source, /templateActionSelected/);
  assert.match(source, /templateAction/);
});
