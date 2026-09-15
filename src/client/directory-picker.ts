// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import type { DirectoryListing } from "@deepseek-ai/dsh-api-workspace-controller/types";

// The card's view of the harness's host-side directory picker — the service
// behind dsh's own workspace directory selection. It lists directories on the
// dsh host (never in a container and never through the orchestrator), so a
// project path chosen here is a host path under the projects root.
export interface DirectoryPickerFace {
  list(path: string, signal?: AbortSignal): Promise<DirectoryListing>;
}

// A listing failure, carrying the harness's stable code so the dialog can name
// an unavailable backend apart from an unreadable directory.
export class DirectoryPickerError extends Error {
  readonly code: string;
  constructor(failure: { code?: unknown; message?: unknown } | undefined) {
    super(
      typeof failure?.message === "string" && failure.message !== ""
        ? failure.message
        : "directory listing failed",
    );
    this.code = typeof failure?.code === "string" ? failure.code : "";
  }
}

// buildDirectoryPicker adapts the injected Remote namespace to the face, or
// returns undefined when this deployment mounts no directory picker (the card
// then hides the browse affordance and the path stays a plain input).
export function buildDirectoryPicker(remote: any): DirectoryPickerFace | undefined {
  const picker = remote?.directoryPicker;
  if (picker === undefined || typeof picker.list !== "function") return undefined;
  return {
    async list(path: string, signal?: AbortSignal): Promise<DirectoryListing> {
      const result = await picker.list(path, signal);
      if (result?.ok === false) throw new DirectoryPickerError(result.error);
      return result.value as DirectoryListing;
    },
  };
}
