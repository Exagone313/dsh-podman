// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

// A client source file, read only in a source checkout: `pnpm test` runs from
// dist/, where the client's sources are not shipped.
function clientSource(name: string): string | undefined {
  const url = new URL(`../src/client/${name}`, import.meta.url);
  return existsSync(url) ? readFileSync(url, "utf8") : undefined;
}

test("the settings card is ordered above the package README", () => {
  const source = clientSource("settings-page-styles.ts");
  if (source === undefined) return;
  // The harness gives the package page's wrapper the bundle name and its
  // configuration section `data-plugin-config`; the rule must target both so no
  // other plugin page or section is reordered. The selector interpolates
  // PLUGIN_PACKAGE in a template literal, so the source carries the placeholder.
  assert.match(
    source,
    /\[data-plugin-detail="\$\{PLUGIN_PACKAGE\}"\] \[data-plugin-config\]/,
  );
  assert.match(source, /order:\s*-1;/);
  // Moving the card must keep the README available below it, not hide it.
  assert.equal(source.includes("data-detail-document"), false);
  assert.match(
    source,
    /import \{ PLUGIN_PACKAGE \} from "\.\/plugin-navigation\.js";/,
  );
});

test("the client entry installs the settings page styles", () => {
  const source = clientSource("index.ts");
  if (source === undefined) return;
  assert.match(source, /installSettingsPageStyles\(ctx\)/);
});
