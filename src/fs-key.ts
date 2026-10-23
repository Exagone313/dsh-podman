// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// The target key the observation policy records and the stale guards compare.
// One file can reach resolve() through different spellings — a doubled slash, a
// "." segment, a trailing slash, or a ".." left by a relative path — and they
// must share one record, so the key is collapsed lexically. Symbolic links are
// deliberately not resolved: the key is the guest path the caller named, not a
// realpath, and two links to one file stay distinct targets.
export function normalizeFsKey(path: string): string {
  const absolute = path.startsWith("/");
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  const joined = segments.join("/");
  if (absolute) return `/${joined}`;
  return joined === "" ? "." : joined;
}
