// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import type { ClientContext } from "@deepseek-ai/dsh-client-runtime/client";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
import type {} from "@deepseek-ai/dsh-client-locale/client";
import type {} from "./slot-contract.js";
import { ContainerCard } from "./ContainerCard.js";
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
}
