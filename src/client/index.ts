// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import type { Context as ClientContext } from "@deepseek-ai/cordis";
import type { ShortcutCommandId } from "@deepseek-ai/dsh-client-shortcuts/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-client-locale/client";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar-right/client";
import type {} from "@deepseek-ai/dsh-api-remotes/client";
import { PluginArtworkTerminal } from "@deepseek-ai/dsh-client-ui-primitives";
import type {} from "./slot-contract.js";
import { buildDirectoryPicker } from "./directory-picker.js";
import { ContainerCard } from "./ContainerCard.js";
import { PodmanTerminal } from "./podman-terminal.js";
import { PodmanTerminalGuide } from "./podman-terminal-guide.js";
import { PodmanTerminalTitle } from "./podman-terminal-title.js";
import { BUILTIN_PROMPT_PREFIX, ReadOnlyApprovalPanel } from "./read-only-approval.js";
import {
  PODMAN_TERMINAL_KIND,
  PODMAN_TERMINAL_SHORTCUT_DEFAULTS,
  PODMAN_TERMINAL_TAB_ID,
} from "./terminal-tab.js";
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

// The plugin's installed package name. The Plugins page keys
// `plugins.bundle.config` by the bundle package name, so it must match
// package.json's `name`.
const PLUGIN_PACKAGE = "@exagone313/dsh-podman";

export const inject = [
  "slots",
  "locale",
  "configForms",
  "sidebarRight",
  "sidebarRightTabs",
  "shortcuts",
];

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

  // The card is the configuration of this plugin's own bundle, so the Plugins
  // page renders it on the installed `@exagone313/dsh-podman` page, above the
  // Components section that lists the rows the bundle declares. The host keys
  // the slot by the package name, so the constant must match package.json.
  // It is contributed only while the Host serves the preferences namespace.
  ctx.effect(
    () =>
      ctx.configForms.whileServed(
        [CONTAINER_NS],
        () =>
          ctx.slots.inject("plugins.bundle.config", () =>
            ctx.slots.register(
              {
                name: "plugins.bundle.config",
                key: PLUGIN_PACKAGE,
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

  // The Podman terminal page: one tab type plus the body/title seats and the
  // guide card that opens it with a verified shell. Closing a tab unmounts the
  // body, whose cleanup aborts the stream while the host keeps the shell
  // retained, so no close handler is registered.
  const t = ctx.locale.bind(NS);
  ctx.effect(
    () =>
      ctx.sidebarRightTabs.register({
        id: PODMAN_TERMINAL_TAB_ID,
        kind: PODMAN_TERMINAL_KIND,
        multiple: true,
        keepMounted: true,
        title: () => t("terminalTabTitle"),
        guide: [{
          id: "new",
          order: 20,
          title: () => t("terminalGuideTitle"),
          description: () => t("terminalGuideDescription"),
          icon: PluginArtworkTerminal,
        }],
      }),
    "podman: terminal type",
  );

  ctx.effect(
    () =>
      ctx.slots.inject("sidebar.right.pane.tab", () =>
        ctx.slots.register(
          {
            name: "sidebar.right.pane.tab",
            key: PODMAN_TERMINAL_TAB_ID,
            locale: NS,
            inject: (sessionId) => ({ ...controller.inject(), sessionId }),
          },
          PodmanTerminal,
        )),
    "podman: terminal body",
  );

  ctx.effect(
    () =>
      ctx.slots.inject("sidebar.right.pane.tab.title", () =>
        ctx.slots.register(
          {
            name: "sidebar.right.pane.tab.title",
            key: PODMAN_TERMINAL_TAB_ID,
            inject: (sessionId) => ({ sessionId }),
          },
          PodmanTerminalTitle,
        )),
    "podman: terminal title",
  );

  ctx.effect(
    () =>
      ctx.slots.inject("sidebar.right.tab.guide.entry", () =>
        ctx.slots.register(
          {
            name: "sidebar.right.tab.guide.entry",
            key: PODMAN_TERMINAL_TAB_ID,
            locale: NS,
            inject: (sessionId) => ({
              ...controller.inject(),
              sessionId,
            }),
          },
          PodmanTerminalGuide,
        )),
    "podman: terminal guide",
  );

  // Ctrl+Shift+` opens a terminal on the session the focused pane belongs to.
  ctx.effect(
    () =>
      ctx.shortcuts.register({
        id: "podman.terminal.new" as ShortcutCommandId,
        label: () => t("terminalShortcut"),
        aliases: ["new podman terminal"],
        defaults: PODMAN_TERMINAL_SHORTCUT_DEFAULTS,
        regions: ["page", "editable", "terminal"],
        modals: [],
        resolve: ({ target }) => {
          const captured = ctx.sidebarRight.commandTarget(target);
          return captured === undefined
            ? { status: "blocked", reason: t("terminalShortcutNoSession") }
            : {
              status: "handled",
              run: () => {
                ctx.sidebarRight.openTabFromTarget(
                  PODMAN_TERMINAL_KIND,
                  captured,
                );
              },
            };
        },
      }),
    "podman: terminal shortcut",
  );
}
