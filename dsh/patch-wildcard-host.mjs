// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// dsh refuses an unspecified (wildcard) bind since 0.2.1-rc.2; this image needs
// one. Rewrite that single guard in the installed bundle, and fail when the
// guard is missing so a harness bump cannot silently ship an unpatched image.
import { readFileSync, writeFileSync } from "node:fs";

const [target] = process.argv.slice(2);
if (target === undefined) {
  throw new Error(
    "usage: patch-wildcard-host.mjs <dsh-host-webserver/lib/index.js>",
  );
}
const guard = /if \(isWildcardAddress\(\w+\)\) throw new Error\(`webserver: host /;
const source = readFileSync(target, "utf8");
if (!guard.test(source)) {
  throw new Error(
    `dsh wildcard guard not found in ${target}: review this patch for the pinned dsh version`,
  );
}
const patched = source.replace(guard, "if (false) throw new Error(`webserver: host ");
if (patched === source) {
  throw new Error(`failed to patch ${target}`);
}
writeFileSync(target, patched);
console.log(`patched the dsh wildcard guard in ${target}`);
