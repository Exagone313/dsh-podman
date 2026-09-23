// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The harness version this plugin runs inside. Every `@deepseek-ai/dsh-*`
// package carries the release version, and the dsh app package is linked into
// the profile's healed node_modules, so it is resolvable from the plugin even
// though it is not a dependency of it. "" when it cannot be resolved, which the
// card renders as unknown.
let cached: string | undefined;

export function dshVersion(): string {
  cached ??= resolveDshVersion() ?? "";
  return cached;
}

// resolveDshVersion walks the module search paths the way the harness resolves
// its own bundles, so a package that does not export ./package.json still
// resolves.
function resolveDshVersion(): string | undefined {
  let searchPaths: Array<string | null>;
  try {
    searchPaths = createRequire(import.meta.url).resolve.paths("@deepseek-ai/dsh") ?? [];
  } catch {
    return undefined;
  }
  for (const searchPath of searchPaths) {
    if (searchPath === null) continue;
    const manifest = join(searchPath, "@deepseek-ai/dsh", "package.json");
    if (!existsSync(manifest)) continue;
    try {
      const parsed = JSON.parse(readFileSync(manifest, "utf8")) as {
        version?: unknown;
      };
      if (typeof parsed.version === "string" && parsed.version !== "") {
        return parsed.version;
      }
    } catch {
      // A malformed manifest is not a version source; keep looking.
    }
  }
  return undefined;
}
