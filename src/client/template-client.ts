// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// The load-template popup's browser half of the host route. The route is served
// on the harness API channel, so a same-origin fetch carries the browser
// session the harness issued for it.

import {
  type TemplateApplyRequest,
  type TemplateApplyView,
  type TemplateBuildRequest,
  type TemplateBuildView,
  type TemplateEntryView,
  type TemplateInspectionView,
  type TemplateInspectRequest,
  type TemplatePublishRequest,
  type TemplatePublishView,
  type TemplateRequest,
  TEMPLATES_PATH,
  type TemplatesListing,
} from "./template-protocol.js";

export interface TemplateClient {
  list(workspace: string, signal?: AbortSignal): Promise<TemplateEntryView[]>;
  inspect(
    request: TemplateInspectRequest,
    signal?: AbortSignal,
  ): Promise<TemplateInspectionView>;
  build(
    request: TemplateBuildRequest,
    signal?: AbortSignal,
  ): Promise<TemplateBuildView>;
  apply(
    request: TemplateApplyRequest,
    signal?: AbortSignal,
  ): Promise<TemplateApplyView>;
  publish(
    request: TemplatePublishRequest,
    signal?: AbortSignal,
  ): Promise<TemplatePublishView>;
}

async function failure(response: Response): Promise<Error> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string" && body.error !== "") {
      return new Error(body.error);
    }
  } catch {
    // A non-JSON body falls through to the status text.
  }
  return new Error(`template request failed (${response.status})`);
}

export function createTemplateClient(): TemplateClient {
  const inspect = async (
    request: TemplateRequest,
    signal?: AbortSignal,
  ): Promise<any> => {
    const response = await fetch(TEMPLATES_PATH, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(request),
      signal,
    });
    if (!response.ok) throw await failure(response);
    return await response.json();
  };
  return {
    async list(workspace: string, signal?: AbortSignal) {
      const url = new URL(TEMPLATES_PATH, globalThis.location.origin);
      url.searchParams.set("workspace", workspace);
      const response = await fetch(url, {
        headers: { accept: "application/json" },
        signal,
      });
      if (!response.ok) throw await failure(response);
      return ((await response.json()) as TemplatesListing).templates;
    },
    inspect: (request, signal) => inspect(request, signal),
    build: (request, signal) => inspect(request, signal),
    apply: (request, signal) => inspect(request, signal),
    publish: (request, signal) => inspect(request, signal),
  };
}
