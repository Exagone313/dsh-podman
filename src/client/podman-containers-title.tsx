// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// The Containers tab's chip: a crate glyph before the tab's registry title.
// Unlike the terminal's chip the title is not live — the tab always shows its
// type's label — so this reads `tab.title` directly. The glyph is drawn here in
// the surrounding ink: the plugin artwork's fixed brand palette belongs to the
// guide card, while a chip has to follow the tab strip's colour.
import type { PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import type { ReactNode } from "react";
import { TabTitleChip } from "./tab-title-chip.js";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar-right/client";

export function PodmanContainersTitle(
  props: PropsRuntime<"sidebar.right.pane.tab.title">,
): ReactNode {
  const { tab } = props.useTabInfo();
  return <TabTitleChip icon={<ContainersGlyph />} title={tab.title} />;
}

// A shipping container in outline: the crate body with three corrugation ribs,
// at the terminal chip glyph's 16px scale and stroke.
function ContainersGlyph(): ReactNode {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
    >
      <rect
        x="2.25"
        y="4.75"
        width="11.5"
        height="6.5"
        rx="1"
        stroke="currentColor"
      />
      <path d="M5.5 6v4M8 6v4M10.5 6v4" stroke="currentColor" />
    </svg>
  );
}
