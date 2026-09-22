// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// How the plugin's version compares with the orchestrator's. A major
// difference means the two halves of the deployment cannot work together; a
// minor/patch difference is compatible but worth surfacing. An orchestrator
// without a comparable version (a local build) accepts any plugin.
export type VersionState = "ok" | "minor-mismatch" | "major-mismatch";

// core returns the leading x.y.z of a version string, or "" when there is
// none. A release build is exactly the tag; a build from a later commit carries
// a git-describe suffix (`1.2.3-4-gabc123`), and a local build may be `dev`.
export function core(value: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(value ?? ""));
  return match === null ? "" : `${match[1]}.${match[2]}.${match[3]}`;
}

// major returns the major component of a version's core, or -1 when the value
// has no parseable core.
export function major(value: string): number {
  const parsed = core(value);
  return parsed === "" ? -1 : Number(parsed.slice(0, parsed.indexOf(".")));
}

// versionState mirrors the orchestrator's own compatibility rule, so the card
// reports exactly what the control plane enforces.
export function versionState(
  plugin: string,
  orchestrator: string,
): VersionState {
  const orchestratorCore = core(orchestrator);
  if (orchestratorCore === "") return "ok";
  const pluginCore = core(plugin);
  if (pluginCore === "") return "major-mismatch";
  if (major(plugin) !== major(orchestrator)) return "major-mismatch";
  return pluginCore === orchestratorCore ? "ok" : "minor-mismatch";
}
