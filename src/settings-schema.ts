// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { type Volatile } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";

export const CONTAINER_NS = "podman";

// Only real preferences live in the plugin config, so the profile document
// holds user choices and nothing derived. The live orchestrator state and the
// card's commands travel over the card route instead (see card-protocol.ts).
//
// Every field is volatile: an edit commits in place without reloading the
// plugin, so every consumer reads a value through its `Volatile` reference
// instead of caching what it held at apply time. The socket and projects roots
// are not preferences: the orchestrator reads them from the environment, so
// they stay env-only on the plugin side too.
export interface Config {
  defaultImage: Volatile<string>;
  uiLocale: Volatile<string>;
  // The environment seeded into a container when it is created; a recreate is
  // authoritative, so a value can be removed again. See container-env.ts.
  containerEnv: Volatile<Record<string, string>>;
}

export const Config = z.object({
  defaultImage: z.string().default("").volatile(),
  uiLocale: z.string().default("").volatile(),
  containerEnv: z.dict(z.string()).default({}).volatile(),
}) as unknown as z<Config>;
