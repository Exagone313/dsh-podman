// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// The environment and secret environment editors' row model, kept out of the
// components so the rules stay testable: a row owns the draft, so a key that is
// retyped — emptied, or renamed onto a name already used — keeps its place in
// the list until the user removes it, and the parent record is derived from the
// rows whose key is non-empty.

// The order a container block lists an environment map in: by variable name,
// case-insensitively and ascending, so a reload of the snapshot never shuffles
// the rows. The create dialogs seed their draft in it too, so a seeded default
// reads where the block lists it. It is display-only: an edit keeps the row
// order the draft is given, so a staged row never moves.
export function orderedEnvEntries(
  env: Record<string, string>,
): [string, string][] {
  return Object.entries(env).sort(([left], [right]) => {
    const a = left.toLowerCase();
    const b = right.toLowerCase();
    if (a !== b) return a < b ? -1 : 1;
    // Two names that differ only by case still read in one fixed order.
    return left < right ? -1 : left > right ? 1 : 0;
  });
}

// orderedEnvRecord is the same order as a fresh record, so a seeded draft lists
// its rows exactly as the container block shows them.
export function orderedEnvRecord(
  env: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(orderedEnvEntries(env));
}

// One editable variable row: the variable name and its value — the attached
// secret's name for a secret environment variable — plus an id that keeps the
// row's React key stable while its name is retyped, so an input is never
// remounted mid-keystroke.
export interface EnvEditRow {
  id: number;
  key: string;
  value: string;
}

let nextEnvRowId = 0;

// envEditRows wraps a record's entries for editing, in the order a container
// block lists them — by variable name, case-insensitively and ascending — each
// with its own id. This is the one place an editor builds its rows, so the
// dialog opens in the order the block shows and no later change re-sorts them.
export function envEditRows(env: Record<string, string>): EnvEditRow[] {
  return orderedEnvEntries(env).map(([key, value]) => ({
    id: nextEnvRowId++,
    key,
    value,
  }));
}

// emptyEnvRow is the row an editor appends: unnamed and empty, waiting for the
// name that makes it a variable.
export function emptyEnvRow(): EnvEditRow {
  return { id: nextEnvRowId++, key: "", value: "" };
}

// envRecordFromRows derives the variables an editor commits from its rows: a
// row is committed only while its key is non-empty, so a row left unnamed is
// never applied, and a name two rows repeat commits the last of them while the
// duplicate check refuses the apply in the meantime.
export function envRecordFromRows(
  rows: readonly EnvEditRow[],
): Record<string, string> {
  return Object.fromEntries(
    rows.filter((row) => row.key !== "").map((row) => [row.key, row.value]),
  );
}

// Every name a container's environment will hold, across both the environment
// variables and the secret environment variables, each editor contributing its
// rows as they are typed. A name is a conflict when it is empty or when it is
// listed more than once; both end up refused by the dialog's action, so both
// groups check the same list.
export function conflictingEnvNames(names: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const conflicts = new Set<string>();
  for (const name of names) {
    if (name === "") conflicts.add(name);
    else if (seen.has(name)) conflicts.add(name);
    else seen.add(name);
  }
  return conflicts;
}

// The first name the list repeats, in the order given, or undefined when every
// name is distinct. An empty name is left to the required-name message, so the
// duplicate message always names a real variable.
export function firstDuplicateEnvName(
  names: readonly string[],
): string | undefined {
  const seen = new Set<string>();
  for (const name of names) {
    if (name === "") continue;
    if (seen.has(name)) return name;
    seen.add(name);
  }
  return undefined;
}
