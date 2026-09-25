// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// The Podman terminal tab type's identity. The tab type is registered under
// `PODMAN_TERMINAL_TAB_ID` (its implementation id, unique across registrations
// and equal to this bundle's package name) while `openTab` names
// `PODMAN_TERMINAL_KIND`. Both live here so the registration in index.ts, the
// body and the guide card agree without importing one another.
import type {} from "@deepseek-ai/dsh-client-ui-sidebar-right/client";
import type {
  ShortcutBinding,
  ShortcutPlatform,
  ShortcutRuntime,
} from "@deepseek-ai/dsh-client-shortcuts/client";

/** Page kind `openTab` names; unique among the tab types in force. */
export const PODMAN_TERMINAL_KIND = "podman-terminal";

/** Implementation id the body, title and guide card register under. */
export const PODMAN_TERMINAL_TAB_ID = "@exagone313/dsh-podman";

// Parameters a Podman terminal page carries. The guide card opens with a
// verified shell; the shortcut opens with none and the body then derives the
// session's workspace and the workspace's default container.
declare module "@deepseek-ai/dsh-client-ui-sidebar-right/client" {
  interface SidebarRightTabParamsMap {
    "podman-terminal": PodmanTerminalParams;
  }
}

/** Navigation parameters of one Podman terminal page. */
export interface PodmanTerminalParams {
  /** Workspace project name (as the card lists it). */
  readonly workspace?: string;
  /** `""`/`"default"` for the default container, or a named one. */
  readonly container?: string;
  /** Absolute shell path returned by the shells route. */
  readonly shell?: string;
}

// Default keyboard profiles for opening a Podman terminal. The shortcuts
// registry validates every declared default and THROWS on one it does not
// admit, inside apply(), which fails the whole client entry and the web boot —
// so these profiles are load-bearing, not cosmetic:
// - Linux Web admits only Ctrl+/, Ctrl+Shift+, and Ctrl+Shift+. (the browser and
//   system reservation rules), so no `web:linux` default can exist; the harness's
//   own terminal ships none either and is opened from the guide there.
// - macOS Web admits Ctrl+` and Meta+Shift+`, but not Ctrl+Shift+`; Windows Web
//   admits Ctrl+Shift+`. Hence the split between the two Web profiles.
// - The same binding on Desktop is accepted on every platform.
export const PODMAN_TERMINAL_SHORTCUT_DEFAULTS = {
  "desktop:macos": { code: "Backquote", modifiers: ["control", "shift"] },
  "desktop:windows": { code: "Backquote", modifiers: ["control", "shift"] },
  "desktop:linux": { code: "Backquote", modifiers: ["control", "shift"] },
  "web:macos": { code: "Backquote", modifiers: ["meta", "shift"] },
  "web:windows": { code: "Backquote", modifiers: ["control", "shift"] },
} satisfies Partial<
  Record<`${ShortcutRuntime}:${ShortcutPlatform}`, ShortcutBinding>
>;
