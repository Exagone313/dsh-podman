// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// The Podman terminal tab's chip: the terminal glyph plus the title the layout
// recorded when the page opened. v1 shows the default title only; the host's
// rename control is a later concern.
import { PluginArtworkTerminal } from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type { ReactNode } from "react";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar-right/client";

export function PodmanTerminalTitle(
  props: PropsRuntime<"sidebar.right.pane.tab.title">,
): ReactNode {
  const { tab } = props.useTabInfo();
  return (
    <span style={CHIP_STYLE}>
      <PluginArtworkTerminal size={14} />
      <span style={TITLE_STYLE}>{tab.title}</span>
    </span>
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
