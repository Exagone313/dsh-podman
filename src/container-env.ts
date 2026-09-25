// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// The container environment defaults: one global map, seeded into a container
// when it is created (see mergeDefaultEnv) and left alone by recreates, so a
// value can be removed again by recreating the container without it.

// The reserved prefix the orchestrator refuses on a client-supplied variable;
// a default in that namespace would make container creation fail, so it is
// dropped instead of sent.
const RESERVED_ENV_PREFIX = "DSH_PODMAN";

// mergeDefaultEnv layers the defaults under a container's own environment: the
// caller's entries win per key, and defaults that cannot be applied (an empty
// key, or one in the reserved namespace) are dropped.
export function mergeDefaultEnv(
  defaults: Record<string, string> | undefined,
  env: Record<string, string> | undefined,
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(defaults ?? {})) {
    if (key === "" || key.startsWith(RESERVED_ENV_PREFIX)) continue;
    merged[key] = value;
  }
  return { ...merged, ...(env ?? {}) };
}

// missingDefaultEnv returns the defaults a container does not have yet, so a
// synchronisation can add exactly those and never overwrite an existing value.
export function missingDefaultEnv(
  defaults: Record<string, string> | undefined,
  env: Record<string, string> | undefined,
): Record<string, string> {
  const missing: Record<string, string> = {};
  for (const [key, value] of Object.entries(mergeDefaultEnv(defaults, undefined))) {
    if (!Object.prototype.hasOwnProperty.call(env ?? {}, key)) missing[key] = value;
  }
  return missing;
}

// gitIdentityEnv turns one name and one email into the four variables git
// needs: the author and the committer pair are the same identity.
export function gitIdentityEnv(name: string, email: string): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  };
}

// readGitIdentity reads the name and email back out of an environment map (the
// author pair; the popup writes all four together).
export function readGitIdentity(env: Record<string, string> | undefined): {
  name: string;
  email: string;
} {
  return {
    name: env?.GIT_AUTHOR_NAME ?? "",
    email: env?.GIT_AUTHOR_EMAIL ?? "",
  };
}

// The four keys gitIdentityEnv owns, in a stable order.
export const GIT_IDENTITY_KEYS = [
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
] as const;

// setGitIdentity returns env with the git identity added (name and email
// non-empty) or removed (either empty).
export function setGitIdentity(
  env: Record<string, string>,
  name: string,
  email: string,
): Record<string, string> {
  const next: Record<string, string> = { ...env };
  for (const key of GIT_IDENTITY_KEYS) delete next[key];
  if (name === "" || email === "") return next;
  return { ...next, ...gitIdentityEnv(name, email) };
}
