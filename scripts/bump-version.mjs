// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// Bump the npm version in package.json, commit it, and tag it. The version must
// be a semver release (x.y.z) or prerelease (x.y.z-<prerelease>). The new
// version must be greater than the current one, except between pre-releases
// (both the current and new versions carry a pre-release suffix). A real bump
// requires a clean working tree and the master branch. Pass --dry-run to only
// validate the version without changing anything. Nothing is pushed.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const raw = process.argv.slice(2);
// npm eats a bare `--dry-run` and forwards only the rest, but sets
// npm_config_dry_run=true for the script; detect both.
const dryRun =
  raw.includes("--dry-run") || process.env.npm_config_dry_run === "true";
const args = raw.filter((arg) => arg !== "--");
const version = args.find((arg) => !arg.startsWith("-"));
const extra = args.filter((arg) => !arg.startsWith("-") && arg !== version);
if (version === undefined || extra.length > 0) {
  console.error("usage: bump-version.mjs [--dry-run] <version>");
  process.exit(1);
}

if (
  !/^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/.test(version)
) {
  console.error(
    `error: invalid version '${version}' (expected x.y.z or x.y.z-prerelease)`,
  );
  process.exit(1);
}

const current = JSON.parse(readFileSync("package.json", "utf8")).version;
if (current === version) {
  console.error(`error: package.json is already at version ${version}`);
  process.exit(1);
}

// Semver comparison: -1 if a < b, 0 if equal, 1 if a > b.
function cmp(a, b) {
  const [baseA, preA] = a.split("-");
  const [baseB, preB] = b.split("-");
  const ma = baseA.split(".").map(Number);
  const mb = baseB.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (ma[i] !== mb[i]) return ma[i] < mb[i] ? -1 : 1;
  }
  if (preA === undefined && preB === undefined) return 0;
  if (preA === undefined) return 1;
  if (preB === undefined) return -1;
  const ia = preA.split(".");
  const ib = preB.split(".");
  for (let i = 0; i < Math.max(ia.length, ib.length); i++) {
    const x = ia[i];
    const y = ib[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn) return Number(x) < Number(y) ? -1 : 1;
    if (xn) return -1;
    if (yn) return 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

// Require the new version to increase, except between pre-releases.
const isPre = (v) => v.includes("-");
if (!(isPre(current) && isPre(version)) && cmp(version, current) <= 0) {
  console.error(
    `error: version ${version} does not increase current version ${current}`,
  );
  process.exit(1);
}

if (dryRun) {
  console.log(
    `dry-run: would set version to ${version}, commit "chore: bump version to ${version}", and tag ${version}`,
  );
  process.exit(0);
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
if (branch !== "master") {
  console.error(`error: must be on 'master', currently on '${branch}'`);
  process.exit(1);
}

if (git(["status", "--porcelain"]) !== "") {
  console.error("error: working tree is not clean");
  process.exit(1);
}

execFileSync("npm", ["pkg", "set", `version=${version}`], { stdio: "inherit" });
git(["add", "package.json"]);
git(["commit", "-m", `chore: bump version to ${version}`]);
git(["tag", version]);

console.log(
  `bumped to ${version} (commit ${git(["rev-parse", "--short", "HEAD"])}, tag ${version}; not pushed)`,
);