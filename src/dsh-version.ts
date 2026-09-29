// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The harness version this plugin runs inside. The dsh app package is not a
// physical dependency of the plugin: the boot loader serves profile plugin
// imports from an in-memory package table, so the plugin asks that table
// (`ctx.pluginPackages`) for the package it runs under. The physical module
// walk below is only a fallback for a development checkout. "" when the
// version cannot be resolved, which the card renders as unknown.
const PACKAGE = "@deepseek-ai/dsh";

// The package lookup surface this module reads: `pluginPackages.packageOf`
// resolves a specifier through the same table the loader uses, so a package
// with no physical node_modules entry still resolves.
export interface PluginPackageLookup {
  packageOf?(
    specifier: string,
    parentURL: string,
  ): { version?: unknown } | undefined;
}

let cached: string | undefined;

export function dshVersion(packages?: PluginPackageLookup): string {
  if (cached !== undefined) return cached;
  const resolved = versionFromPackages(packages) ?? resolveDshVersion();
  // Only a resolved version is cached, so an early lookup without the package
  // table cannot pin "" for the process lifetime.
  if (resolved !== undefined && resolved !== "") cached = resolved;
  return resolved ?? "";
}

// versionFromPackages reads the running app package's manifest version through
// the profile package lookup. It is undefined when the lookup is absent, the
// package is unknown, or the manifest carries no usable version.
export function versionFromPackages(
  packages?: PluginPackageLookup,
): string | undefined {
  const version = packages?.packageOf?.(PACKAGE, import.meta.url)?.version;
  return typeof version === "string" && version !== "" ? version : undefined;
}

// resolveDshVersion walks the physical module search paths, for an install
// whose app package is a real node_modules entry (a source checkout).
function resolveDshVersion(): string | undefined {
  let searchPaths: Array<string | null>;
  try {
    searchPaths = createRequire(import.meta.url).resolve.paths(PACKAGE) ?? [];
  } catch {
    return undefined;
  }
  for (const searchPath of searchPaths) {
    if (searchPath === null) continue;
    const manifest = join(searchPath, PACKAGE, "package.json");
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
