// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import type { Context as ClientContext } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-client-locale/client";
import type {} from "@deepseek-ai/dsh-api-remotes/client";
import type {} from "./slot-contract.js";
import { buildDirectoryPicker } from "./directory-picker.js";
import { ContainerCard } from "./ContainerCard.js";
import { BUILTIN_PROMPT_PREFIX, ReadOnlyApprovalPanel } from "./read-only-approval.js";
import { PodmanToolRow, TOOL_VIEW_KEYS } from "./tool-views.js";
import { installTerminalStyles } from "./terminal-styles.js";
import { installDirectoryStyles } from "./container-card-directory-styles.js";
import {
  CONTAINER_NS,
  ContainerCardController,
  type ContainerSettings,
} from "./container-card-controller.js";
import { en, NS, zh } from "./locales.js";

export type { ContainerCardProps } from "./ContainerCard.js";

export const name = "podman";

export const inject = ["slots", "locale", "configForms"];

export function apply(ctx: ClientContext): void {
  installTerminalStyles(ctx);
  installDirectoryStyles(ctx);
  ctx.effect(
    () => ctx.locale.register(NS, { en, zh }),
    "podman: dictionaries",
  );

  // The shared configuration form for this plugin's own profile entry: the
  // entry id is the plugin row id ("podman"), which is also the namespace the
  // host serves its volatile preferences under.
  const scope = ctx.configForms.get<ContainerSettings>(CONTAINER_NS);

  // Record the active locale (including the browser default, which the host
  // cannot observe) so approval text renders in the session language. The
  // namespace may still be loading when this plugin mounts, so the write also
  // runs on every scope change; the value check keeps it a one-time write.
  const syncLocale = (): void => {
    const snapshot = scope.getSnapshot();
    if (snapshot.status !== "ready" || !snapshot.writable) return;
    const active = ctx.locale.getSnapshot().active;
    if (snapshot.value?.uiLocale === active) return;
    void scope.set("uiLocale", active);
  };
  syncLocale();
  scope.subscribe(syncLocale);
  ctx.effect(() => ctx.on("locale/change", syncLocale), "podman: locale sync");

  const controller = new ContainerCardController(scope);

  // The harness's own directory picker backs the project-mount browse dialog:
  // it lists directories on the dsh host, so a chosen project path is a host
  // path under the projects root — never a container path and never an
  // orchestrator call. Both `remote` and its `directoryPicker` namespace are
  // injected: the namespace is a child service, and reading `ctx.remote.<ns>`
  // through the parent requires injecting the parent too. The face goes to the
  // controller so the card republishes when the service mounts or unmounts; the
  // service is optional, and without it the card hides the browse affordance.
  ctx.inject(["remote", "remote.directoryPicker"], (pickerCtx: any) => {
    controller.setDirectoryPicker(buildDirectoryPicker(pickerCtx.remote));
    pickerCtx.effect(() => () => {
      controller.setDirectoryPicker(undefined);
    }, "podman: directory picker");
  });

  // The Plugins page renders the card as this plugin's own configuration page
  // while the host serves the namespace.
  const t = ctx.locale.bind(NS);
  ctx.effect(
    () =>
      ctx.configForms.whileServed(
        [CONTAINER_NS],
        () =>
          ctx.slots.inject("plugins.item", () =>
            ctx.slots.register(
              {
                name: "plugins.item",
                id: CONTAINER_NS,
                order: 20,
                label: () => t("cardTitle"),
                locale: NS,
                inject: () => controller.inject(),
              },
              ContainerCard,
            )),
      ),
    "podman: settings page",
  );

  // Own the row rendering of every podman tool (instead of the generic
  // "Tool call · <name>" fallback).
  for (const key of TOOL_VIEW_KEYS) {
    ctx.slots.inject("tool.call.toolview", () =>
      ctx.slots.register(
        { name: "tool.call.toolview", key, locale: NS },
        PodmanToolRow,
      ));
  }

  // Take over the composer for this plugin's read-only remount prompts only:
  // "Remount & run" reads correctly there, while the harness's "Allow once"
  // would not. A lower priority renders before the harness's approval panel.
  ctx.slots.inject("conversation.composer", () =>
    ctx.slots.register(
      {
        name: "conversation.composer",
        priority: 0,
        locale: NS,
        select: ({ pendingInteraction }: any) => {
          const pending = pendingInteraction as any;
          return pending?.kind === "approval" &&
              typeof pending.toolName === "string" &&
              pending.toolName.startsWith(BUILTIN_PROMPT_PREFIX)
            ? pending
            : null;
        },
      },
      ReadOnlyApprovalPanel,
    ));
}
