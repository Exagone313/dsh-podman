// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { randomUUID } from "node:crypto";
import { unaryGuest, writeGuestFile } from "./guest-rpc.js";
import { SPILL_ROOT } from "./output-reader.js";
import type { WorkspaceResolver } from "./workspace-binding.js";

// Tool-result spills live in a subdirectory of the guest's scratch root so they
// never collide with the command-output spills the guest writes directly there.
const TOOL_SPILL_ROOT = `${SPILL_ROOT}/spill`;

// One spill request, mirroring @deepseek-ai/dsh-spill's SaveTextSpill: the
// session that owns the artifact, provenance, a caller-suggested base name, and
// the full text to persist.
export interface SpillRequest {
  owner: { sessionId: string };
  source: unknown;
  suggestedName: string;
  content: string;
}

// The artifact handle a spill policy renders for the model: the container path,
// the exact byte length, and how to read the artifact back.
export interface SpillRef {
  locator: string;
  bytes: number;
  retrievalHint: string;
}

// spillName turns a caller-suggested base name into one safe, collision-free
// path segment. The suggestion is a hint, never a path.
function spillName(suggestedName: unknown): string {
  const safe = String(suggestedName ?? "")
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/\.{2,}/g, "_")
    .replace(/^[.-]+/, "")
    .slice(0, 64);
  return `${randomUUID().replace(/-/g, "")}-${safe === "" ? "spill.txt" : safe}`;
}

// sessionSegment is the per-session directory name. Session ids are not
// guaranteed to be UUIDs (dsh mints `session-<n>`, `<id>-session-<uuid>`, and
// `webhook-<uuid>`, and accepts a caller-supplied id), so the id is encoded
// rather than trusted: a short readable prefix from a safe alphabet plus the
// full id in hex — deterministic, collision-free, and never "." or "..".
export function sessionSegment(sessionId: unknown): string {
  const id = String(sessionId ?? "");
  const encoded = Buffer.from(id, "utf8").toString("hex");
  const readable = id
    .replace(/[^A-Za-z0-9_-]/g, "_")
    .replace(/_{2,}/g, "_")
    .replace(/^[_-]+/, "")
    .slice(0, 24)
    .replace(/[_-]+$/, "");
  if (readable !== "") return `${readable}-${encoded}`;
  return encoded === "" ? "session" : encoded;
}

// createSpillStore backs `ctx.spillStore` with the session's container:
// oversized tool results are written inside the guest, and the locator is the
// container path, so the agent reads them back with `container_read` /
// `container_grep` (the host filesystem is not reachable from a container).
export function createSpillStore(
  ctx: any,
  resolver: WorkspaceResolver,
): { saveText(input: SpillRequest): Promise<SpillRef> } {
  return {
    async saveText(input: SpillRequest): Promise<SpillRef> {
      const sessionId = String(input?.owner?.sessionId ?? "");
      const session = ctx.get("sessions")?.get?.(sessionId);
      const cwd = session?.header?.cwd;
      if (typeof cwd !== "string" || cwd === "") {
        throw new Error(
          `cannot spill a result for session "${sessionId}": no session working directory`,
        );
      }
      const binding = await resolver.resolve(cwd);
      const directory = `${TOOL_SPILL_ROOT}/${sessionSegment(sessionId)}`;
      await unaryGuest(
        { targetKey: directory, displayPath: directory, binding },
        "mkdir",
        { path: directory, parents: true },
      );
      const path = `${directory}/${spillName(input.suggestedName)}`;
      const content = String(input.content ?? "");
      await writeGuestFile(binding, path, content, {
        create: true,
        truncate: true,
      });
      return {
        locator: path,
        bytes: Buffer.byteLength(content, "utf8"),
        retrievalHint:
          "Use container_read with offset/limit, or container_grep this path to search within it.",
      };
    },
  };
}
