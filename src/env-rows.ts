// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// The env editor's record transformations, kept out of the component so the
// rules stay testable: which keys are accepted, and how an edit preserves row
// order. A draft is the row a caller is still typing; it never reaches the
// parent record until its key is non-empty and unused.

export interface EnvDraft {
  key: string;
  value: string;
}

// One rendered row: the committed entries in order, then the pending draft.
export interface EnvRow extends EnvDraft {
  pending: boolean;
}

export function emptyEnvDraft(): EnvDraft {
  return { key: "", value: "" };
}

export function envRows(
  env: Record<string, string>,
  draft: EnvDraft | undefined,
): EnvRow[] {
  const rows: EnvRow[] = Object.entries(env).map(([key, value]) => ({
    key,
    value,
    pending: false,
  }));
  if (draft !== undefined) rows.push({ ...draft, pending: true });
  return rows;
}

// Whether a draft's key can become a variable: non-empty and not already used.
export function envKeyAvailable(
  env: Record<string, string>,
  key: string,
): boolean {
  return key !== "" && !Object.prototype.hasOwnProperty.call(env, key);
}

// commitEnvDraft appends the draft to the record once its key is usable, or
// returns undefined so the caller keeps the row open instead of inventing a
// placeholder variable name.
export function commitEnvDraft(
  env: Record<string, string>,
  draft: EnvDraft,
): Record<string, string> | undefined {
  if (!envKeyAvailable(env, draft.key)) return undefined;
  return { ...env, [draft.key]: draft.value };
}

// Every mutation rebuilds the record in order, so a renamed key stays in place
// instead of jumping to the end.
export function renameEnvKey(
  env: Record<string, string>,
  index: number,
  key: string,
): Record<string, string> {
  const next: Record<string, string> = {};
  Object.entries(env).forEach(([current, value], at) => {
    next[at === index ? key : current] = value;
  });
  return next;
}

export function setEnvValue(
  env: Record<string, string>,
  index: number,
  value: string,
): Record<string, string> {
  const next: Record<string, string> = {};
  Object.entries(env).forEach(([key, current], at) => {
    next[key] = at === index ? value : current;
  });
  return next;
}

export function removeEnvRow(
  env: Record<string, string>,
  index: number,
): Record<string, string> {
  const next: Record<string, string> = {};
  Object.entries(env).forEach(([key, value], at) => {
    if (at !== index) next[key] = value;
  });
  return next;
}
