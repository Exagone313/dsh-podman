// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// The Podman terminal tab's chip, mirroring the built-in terminal's: the line
// glyph plus the running shell's name. The name is the host's (published by the
// tab body when it connects), the shell the page opened with before that, or the
// registry title while neither is known.
import type { InjectFace, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import { type ReactNode, useSyncExternalStore } from "react";
import type { PodmanTerminalParams } from "./terminal-tab.js";
import { shellName } from "./terminal-targets.js";
import { subscribeTerminalTitles, terminalTitle } from "./terminal-titles.js";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar-right/client";

/** Session identity the session-scope title registration injects. */
export interface PodmanTerminalTitleInjected {
  readonly sessionId: string;
}

export function PodmanTerminalTitle(
  props:
    & PropsRuntime<"sidebar.right.pane.tab.title">
    & InjectFace<PodmanTerminalTitleInjected>,
): ReactNode {
  const { tab } = props.useTabInfo();
  const params = tab.navigation.params as PodmanTerminalParams | undefined;
  // Only the session-scope identity is available here, so the store is keyed the
  // same way the host retains a terminal.
  const key = `${props.sessionId}:${tab.id}`;
  const fallback = shellName(params?.shell) ?? tab.title;
  const title = useSyncExternalStore(
    subscribeTerminalTitles,
    () => terminalTitle(key) ?? fallback,
  );
  return (
    <span style={CHIP_STYLE}>
      <TerminalGlyph />
      <span style={TITLE_STYLE}>{title}</span>
    </span>
  );
}

// The built-in tab chip's 16px terminal prompt, drawn in the surrounding ink
// instead of the plugin artwork's fixed brand palette.
function TerminalGlyph(): ReactNode {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3 4L7 8L3 12" stroke="currentColor" />
      <path d="M9 12H13" stroke="currentColor" />
    </svg>
  );
}

const CHIP_STYLE: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "4px",
  minWidth: 0,
};

const TITLE_STYLE: React.CSSProperties = {
  overflow: "hidden",
  whiteSpace: "nowrap",
  textOverflow: "ellipsis",
};
