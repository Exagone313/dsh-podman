// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// The Podman terminal tab type's identity. The tab type is registered under
// `PODMAN_TERMINAL_TAB_ID` (its implementation id, unique across registrations
// and equal to this bundle's package name) while `openTab` names
// `PODMAN_TERMINAL_KIND`. Both live here so the registration in index.ts, the
// body and the guide card agree without importing one another.
import type {} from "@deepseek-ai/dsh-client-ui-sidebar-right/client";

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
