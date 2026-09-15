// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { unaryGuest } from "./guest-rpc.js";
import { randomUUID } from "node:crypto";

// The container-local directory the orchestrator mounts read-write for
// command-output spill files. Must match the orchestrator's `spillRoot`.
export const SPILL_ROOT = "/tmp/dsh-podman";

// One bounded full-stream spill the guest writes for a collect-mode stream.
interface SpillSpec {
  path: string;
  maxBytes: number;
}

export interface OutputReader {
  append(data: Buffer): void;
  readFrom(offset: number): {
    text: string;
    nextOffset: number;
    lossy: boolean;
    spillPath?: string;
  };
  // Record the guest's verdict on the on-disk copy.
  setSpillValid(valid: boolean): void;
  // The configured spill path, when one was requested.
  readonly spillPath: string | undefined;
  // Whether the in-memory cap overflowed, so the spill was actually needed.
  readonly spillNeeded: boolean;
}

export function outputReader(
  mode: unknown,
  spill?: SpillSpec,
): OutputReader | undefined {
  if (typeof mode !== "object" || mode === null) return undefined;
  const maxBytes = Number((mode as { maxBytes?: number }).maxBytes);
  if (!Number.isFinite(maxBytes) || maxBytes < 0) return undefined;
  let total = 0;
  let retained = Buffer.alloc(0);
  let spillValid = spill !== undefined;
  return {
    append(data) {
      total += data.length;
      retained = Buffer.concat([retained, data]).subarray(-maxBytes);
    },
    readFrom(offset) {
      const start = Math.max(0, total - retained.length);
      const requested = Math.max(0, Number.isFinite(offset) ? offset : 0);
      const local = Math.max(0, requested - start);
      const lossy = requested < start;
      return {
        text: retained.subarray(local).toString("utf8"),
        nextOffset: total,
        lossy,
        // Advertise the full-stream file only while it can still hold the
        // complete stream, matching the local backend's reader.
        ...(lossy &&
        spill !== undefined &&
        spillValid &&
        total <= spill.maxBytes
          ? { spillPath: spill.path }
          : {}),
      };
    },
    setSpillValid(valid) {
      spillValid = valid;
    },
    get spillPath() {
      return spill?.path;
    },
    get spillNeeded() {
      return total > maxBytes;
    },
  };
}

// spillTargetFor builds the guest spill request for one collect-mode stream, or
// an empty object when the mode requests no spill.
export function spillTargetFor(
  mode: unknown,
  label: string,
): { target?: { path: string; maxBytes: number }; spec?: SpillSpec } {
  const spill = (mode as { spill?: { maxBytes?: number } } | undefined)?.spill;
  const maxBytes = Number(spill?.maxBytes);
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return {};
  const path = `${SPILL_ROOT}/${randomUUID()}.${label}`;
  return { target: { path, maxBytes }, spec: { path, maxBytes } };
}

// splitEnv separates the harness's explicit environment entries from its
// `undefined` tombstones, which a proto string map cannot carry.
export function splitEnv(env: unknown): {
  env: Record<string, string>;
  unsetEnv: string[];
} {
  const set: Record<string, string> = {};
  const unsetEnv: string[] = [];
  if (typeof env === "object" && env !== null) {
    for (const [key, value] of Object.entries(env as Record<string, unknown>)) {
      if (value === undefined) unsetEnv.push(key);
      else set[key] = String(value);
    }
  }
  return { env: set, unsetEnv };
}

// discardUnneededSpill removes a spill the in-memory tail already covered. A
// valid spill that holds output the tail dropped stays for the caller to read,
// and an incomplete one was already removed by the guest.
export function discardUnneededSpill(
  binding: { guest: any; token: string },
  reader: OutputReader | undefined,
): void {
  if (reader === undefined || reader.spillPath === undefined) return;
  if (reader.spillNeeded) return;
  void unaryGuest(
    { binding },
    "delete",
    { path: reader.spillPath, recursive: false },
  ).catch(() => {});
}
