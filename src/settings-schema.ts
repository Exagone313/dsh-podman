// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import z from "@deepseek-ai/schemastery";

export const CONTAINER_NS = "podman";

// Only real preferences live in the settings namespace, so the settings
// document holds user choices and nothing derived. The live orchestrator state
// and the card's commands travel over the card route instead (see
// card-protocol.ts).
export const settingsSchema = z.object({
  defaultImage: z.string().default(""),
  socketsRoot: z.string().default(""),
  uiLocale: z.string().default(""),
}) as unknown as z<ContainerSettings>;

export interface ContainerSettings {
  defaultImage: string;
  socketsRoot: string;
  uiLocale: string;
}

export interface ContainerSettingsScope {
  get(): ContainerSettings;
  watch(
    callback: (
      next: ContainerSettings,
      prev: ContainerSettings,
    ) => void | Promise<void>,
  ): () => void;
  update(patch: object): Promise<void>;
  replace(section: object): Promise<void>;
}
