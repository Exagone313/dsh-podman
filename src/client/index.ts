// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import type { Context as ClientContext } from "@deepseek-ai/cordis";
import type {
  ShortcutCommand,
  ShortcutCommandId,
} from "@deepseek-ai/dsh-client-shortcuts/client";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-settings/client";
import type {} from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-client-locale/client";
import type {} from "@deepseek-ai/dsh-client-ui-plugin-manager/client";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar-right/client";
import type {} from "@deepseek-ai/dsh-api-remotes/client";
import {
  PluginArtworkDefault,
  PluginArtworkTerminal,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type {} from "./slot-contract.js";
import { buildDirectoryPicker } from "./directory-picker.js";
import { ContainerCard } from "./ContainerCard.js";
import { ContainerCardToast } from "./container-card-toast.js";
import { PodmanContainers } from "./podman-containers.js";
import { PodmanContainersGuide } from "./podman-containers-guide.js";
import { PodmanTerminal } from "./podman-terminal.js";
import { PodmanTerminalGuide } from "./podman-terminal-guide.js";
import { PodmanTerminalTitle } from "./podman-terminal-title.js";
import {
  BUILTIN_PROMPT_PREFIX,
  ReadOnlyApprovalPanel,
} from "./read-only-approval.js";
import {
  PODMAN_CONTAINERS_KIND,
  PODMAN_CONTAINERS_TAB_ID,
  resolveContainersOpen,
} from "./containers-tab.js";
import { PLUGIN_PACKAGE, setPluginNavigation } from "./plugin-navigation.js";
import {
  PODMAN_TERMINAL_KIND,
  PODMAN_TERMINAL_SHORTCUT_DEFAULTS,
  PODMAN_TERMINAL_SHORTCUT_FALLBACK_DEFAULTS,
  PODMAN_TERMINAL_TAB_ID,
} from "./terminal-tab.js";
import { PodmanToolRow, TOOL_VIEW_KEYS } from "./tool-views.js";
import { installTerminalStyles } from "./terminal-styles.js";
import { installDirectoryStyles } from "./container-card-directory-styles.js";
import { installDialogStyles } from "./container-card-dialog-styles.js";
import { installFieldStyles } from "./container-card-field-styles.js";
import { installTableStyles } from "./container-card-table-styles.js";
import { installTabsStyles } from "./container-card-tabs-styles.js";
import { installContainersPanelStyles } from "./podman-containers-styles.js";
import {
  CONTAINER_NS,
  ContainerCardController,
  type ContainerSettings,
} from "./container-card-controller.js";
import { en, NS, zh } from "./locales.js";

export type { ContainerCardProps } from "./ContainerCard.js";

export const name = "podman";

export const inject = [
  "slots",
  "locale",
  "configForms",
  "sidebarRight",
  "sidebarRightTabs",
  "shortcuts",
];

// A failed optional registration must not take the whole client entry down: the
// plugin still activates, and the next activation retries the registration. The
// first failure of each part is reported once, with a prefix naming that part,
// instead of once per retry.
const registrationFailures = new Set<string>();

/**
 * Report one failed registration, once per part.
 * @param part - short name of the registration that failed.
 * @param error - the refusal the registry raised.
 */
function reportRegistrationFailure(part: string, error: unknown): void {
  if (registrationFailures.has(part)) return;
  registrationFailures.add(part);
  console.error(`podman: ${part} registration failed; continuing:`, error);
}

export function apply(ctx: ClientContext): void {
  // Capture the locale service and its translator once, while this plugin's
  // context is active — the same way the card and terminal seats use the
  // framework-injected `t`. A thunk, subscriber or event handler can run after
  // a reload, when reading `ctx.locale` again throws `cannot get required
  // service "locale" in inactive context`; closing over the captured face and
  // its bound translator keeps every later call service-lookup-free.
  const locale = ctx.locale;
  const t = locale.bind(NS);
  // Shortcut resolvers run later, outside this apply pass; the right Sidebar's
  // face is captured here so those handlers never resolve the service through
  // the context again.
  const sidebarRight = ctx.sidebarRight;

  installTerminalStyles(ctx);
  installDirectoryStyles(ctx);
  installDialogStyles(ctx);
  installFieldStyles(ctx);
  installTableStyles(ctx);
  installTabsStyles(ctx);
  installContainersPanelStyles(ctx);
  ctx.effect(
    () => locale.register(NS, { en, zh }),
    "podman: dictionaries",
  );

  // The shared configuration form for this plugin's own profile entry: the
  // entry id is the plugin row id ("podman"), which is also the namespace the
  // host serves its volatile preferences under.
  const scope = ctx.configForms.get<ContainerSettings>(CONTAINER_NS);

  const controller = new ContainerCardController(scope);

  // The Containers pane's settings action opens this bundle's own page on the
  // Plugins panel. The service is optional: the plugin-manager client UI
  // provides it from a lazily mounted slot, so making it a required injection
  // would deactivate this whole plugin whenever that UI goes away. The sidebar
  // body is given the card face, not the plugin context, so the apply closure
  // records the face here; while it is missing the pane hides the action.
  ctx.inject(["pluginNavigation"], (navCtx: ClientContext) => {
    navCtx.effect(() => {
      setPluginNavigation(navCtx.pluginNavigation);
      return () => setPluginNavigation(undefined);
    }, "podman: plugin navigation");
  });

  // Record the active locale (including the browser default, which the host
  // cannot observe) so approval text renders in the session language, and hand
  // it to the card so every dated row is formatted in it. The namespace may
  // still be loading when this plugin mounts, so the write also runs on every
  // scope change; the value check keeps it a one-time write. The service is
  // captured above: this subscriber can outlive a reload, and must not read
  // `ctx.locale` then.
  const syncLocale = (): void => {
    const active = locale.getSnapshot().active;
    controller.setLocale(active);
    const snapshot = scope.getSnapshot();
    if (snapshot.status !== "ready" || !snapshot.writable) return;
    if (snapshot.value?.uiLocale === active) return;
    void scope.set("uiLocale", active);
  };
  syncLocale();
  // The settings scope's store outlives this plugin's context, so the
  // subscription is effect-owned: a leaked listener would fire after a reload.
  ctx.effect(
    () => scope.subscribe(syncLocale),
    "podman: settings locale sync",
  );
  ctx.effect(() => ctx.on("locale/change", syncLocale), "podman: locale sync");

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

  // The card's command feedback lives in the frame-wide overlay layer, so a
  // report raised on the settings page is still visible after the user
  // navigates away. It renders nothing while no report is pending.
  ctx.effect(
    () =>
      ctx.slots.inject("shell.overlay", () =>
        ctx.slots.register(
          {
            name: "shell.overlay",
            id: "podman.card-toast",
            inject: () => controller.inject(),
          },
          ContainerCardToast,
        )),
    "podman: card toast",
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
  // retained, so no close handler is registered. Its copy reads the translator
  // captured at the top of `apply`, like every other registration here.
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
      ctx.slots.inject(
        "sidebar.right.tab.guide.entry",
        () =>
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
          ),
      ),
    "podman: terminal guide",
  );

  // The workspace Containers panel: a second tab type of its own, scoped to the
  // Session's workspace. Its guide entry sits after the terminal's, so both
  // appear on the Start panel; its body registers under its own id. Each piece
  // is guarded so a refused registration (a taken id or kind, a seat that moved)
  // hides only that piece instead of failing the whole client entry.
  ctx.effect(
    () => {
      try {
        return ctx.sidebarRightTabs.register({
          id: PODMAN_CONTAINERS_TAB_ID,
          kind: PODMAN_CONTAINERS_KIND,
          multiple: false,
          keepMounted: true,
          title: () => t("containersTabTitle"),
          guide: [{
            id: "containers",
            order: 21,
            title: () => t("containersGuideTitle"),
            description: () => t("containersGuideDescription"),
            icon: PluginArtworkDefault,
          }],
        });
      } catch (error) {
        reportRegistrationFailure("containers tab type", error);
        return () => {};
      }
    },
    "podman: containers type",
  );

  ctx.effect(
    () =>
      ctx.slots.inject("sidebar.right.pane.tab", () => {
        try {
          return ctx.slots.register(
            {
              name: "sidebar.right.pane.tab",
              key: PODMAN_CONTAINERS_TAB_ID,
              locale: NS,
              inject: (sessionId) => ({ ...controller.inject(), sessionId }),
            },
            PodmanContainers,
          );
        } catch (error) {
          reportRegistrationFailure("containers tab body", error);
          return () => {};
        }
      }),
    "podman: containers body",
  );

  ctx.effect(
    () =>
      ctx.slots.inject("sidebar.right.tab.guide.entry", () => {
        try {
          return ctx.slots.register(
            {
              name: "sidebar.right.tab.guide.entry",
              key: PODMAN_CONTAINERS_TAB_ID,
              locale: NS,
            },
            PodmanContainersGuide,
          );
        } catch (error) {
          reportRegistrationFailure("containers guide", error);
          return () => {};
        }
      }),
    "podman: containers guide",
  );

  // The command opens the panel on the session the focused pane belongs to. It
  // deliberately carries no keyboard binding: the panel is reached from its
  // Start panel card or from this command. A refused registration is reported
  // and the rest of the plugin still loads.
  const containersCommand: Omit<ShortcutCommand, "defaults"> = {
    id: "podman.containers.open" as ShortcutCommandId,
    label: () => t("containersCommand"),
    aliases: ["containers", "workspace containers"],
    regions: ["page", "editable", "terminal"],
    modals: [],
    resolve: ({ target }) => {
      const resolution = resolveContainersOpen(sidebarRight, target);
      return resolution.status === "blocked"
        ? { status: "blocked", reason: t("terminalShortcutNoSession") }
        : { status: "handled", run: resolution.run };
    },
  };
  ctx.effect(
    () => {
      try {
        return ctx.shortcuts.register({
          ...containersCommand,
          defaults: {},
        });
      } catch (error) {
        reportRegistrationFailure("containers command", error);
        return () => {};
      }
    },
    "podman: containers command",
  );

  // Ctrl+` opens a terminal on the session the focused pane belongs to: the
  // built-in terminal's own binding, freed by disabling that client UI. A
  // refused registration (the built-in enabled again, or another command
  // owning the keys) falls back to a distinct binding instead of failing the
  // whole client entry.
  const terminalShortcut: Omit<ShortcutCommand, "defaults"> = {
    id: "podman.terminal.new" as ShortcutCommandId,
    label: () => t("terminalShortcut"),
    aliases: ["new terminal", "shell"],
    regions: ["page", "editable", "terminal"],
    modals: [],
    resolve: ({ target }) => {
      const captured = sidebarRight.commandTarget(target);
      return captured === undefined
        ? { status: "blocked", reason: t("terminalShortcutNoSession") }
        : {
          status: "handled",
          run: () => {
            sidebarRight.openTabFromTarget(PODMAN_TERMINAL_KIND, captured);
          },
        };
    },
  };
  ctx.effect(
    () => {
      try {
        return ctx.shortcuts.register({
          ...terminalShortcut,
          defaults: PODMAN_TERMINAL_SHORTCUT_DEFAULTS,
        });
      } catch {
        return ctx.shortcuts.register({
          ...terminalShortcut,
          defaults: PODMAN_TERMINAL_SHORTCUT_FALLBACK_DEFAULTS,
        });
      }
    },
    "podman: terminal shortcut",
  );
}
