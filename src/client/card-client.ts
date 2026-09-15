// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// The card's browser half of the host route. The route sits below the harness
// API path, so a same-origin fetch carries the browser session the harness
// issued for `/api`.

import {
  CARD_ROUTE,
  type CardCommandResult,
  type CardSnapshot,
  type CommandRequest,
} from "./card-protocol.js";

const CARD_URL = `/api${CARD_ROUTE}`;

export interface CardClient {
  snapshot(): Promise<CardSnapshot>;
  command(request: CommandRequest): Promise<CardCommandResult>;
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
  return new Error(`card request failed (${response.status})`);
}

export function createCardClient(): CardClient {
  return {
    async snapshot(): Promise<CardSnapshot> {
      const response = await fetch(CARD_URL, {
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw await failure(response);
      return (await response.json()) as CardSnapshot;
    },
    async command(request: CommandRequest): Promise<CardCommandResult> {
      const response = await fetch(CARD_URL, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({ command: request }),
      });
      if (!response.ok) throw await failure(response);
      return (await response.json()) as CardCommandResult;
    },
  };
}
