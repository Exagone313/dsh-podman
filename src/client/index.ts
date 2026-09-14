// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import type { Context as ClientContext } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
import type {} from "@deepseek-ai/dsh-client-locale/client";
import type {} from "./slot-contract.js";
import { ContainerCard } from "./ContainerCard.js";
import { PodmanToolRow, TOOL_VIEW_KEYS } from "./tool-views.js";
import { installTerminalStyles } from "./terminal-styles.js";
import {
  CONTAINER_NS,
  ContainerCardController,
  type ContainerSettings,
} from "./container-card-controller.js";
import { NS, en, zh } from "./locales.js";

export type { ContainerCardProps } from "./ContainerCard.js";

export const name = "podman";

export const inject = ["slots", "locale", "settingsScope"];

export function apply(ctx: ClientContext): void {
  installTerminalStyles(ctx);
  ctx.effect(
    () => ctx.locale.register(NS, { en, zh }),
    "podman: dictionaries",
  );

  const scope = ctx.settingsScope.bind({
    namespace: CONTAINER_NS,
    decode: (section) =>
      typeof section === "object" && section !== null
        ? (section as ContainerSettings)
        : undefined,
  });

  // Record the active locale (including the browser default, which the host
  // cannot observe) so approval text renders in the session language.
  const syncLocale = (): void => {
    const snapshot = scope.getSnapshot();
    if (!snapshot.writable) return;
    const active = ctx.locale.getSnapshot().active;
    if (snapshot.value?.uiLocale === active) return;
    void scope.set("uiLocale", active);
  };
  syncLocale();
  ctx.effect(() => ctx.on("locale/change", syncLocale), "podman: locale sync");

  const controller = new ContainerCardController(scope);

  ctx.slots.inject("settings.plugin.item", () =>
    ctx.slots.register(
      {
        name: "settings.plugin.item",
        key: CONTAINER_NS,
        locale: NS,
        inject: () => controller.inject(),
      },
      ContainerCard,
    ),
  );

  // Own the row rendering of every podman tool (instead of the generic
  // "Tool call · <name>" fallback).
  for (const key of TOOL_VIEW_KEYS) {
    ctx.slots.inject("tool.call.toolview", () =>
      ctx.slots.register(
        { name: "tool.call.toolview", key, locale: NS },
        PodmanToolRow,
      ),
    );
  }
}
