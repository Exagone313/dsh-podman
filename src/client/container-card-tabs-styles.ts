// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import type { Context as ClientContext } from "@deepseek-ai/cordis";

// The class passed to SegmentedTabs for the settings page's tab strip. The
// primitive lays its tabs out as an equal-column grid, which cannot wrap; this
// class turns the same tablist into a wrapping flex strip instead, so all five
// tabs stay visible at phone width without scrolling: each tab keeps a 100px
// basis and grows to share its line. The primitive's sliding indicator is
// absolute inside the strip (it cannot follow a wrapped tab), so it is dropped
// and the selected tab carries its own fill.
export const TABS_CLASS = "dsh-podman-tabs";

export const TABS_STYLES = `
.dsh-podman-tabs.dsh-podman-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.dsh-podman-tabs.dsh-podman-tabs > [role="tab"] {
  flex: 1 1 100px;
  min-width: 0;
  padding: 0 8px;
  font-size: 13px;
  white-space: nowrap;
}
.dsh-podman-tabs.dsh-podman-tabs > span[aria-hidden="true"] {
  display: none;
}
.dsh-podman-tabs.dsh-podman-tabs > [role="tab"][aria-selected="true"] {
  background: var(--dsw-alias-bg-layer-3);
  box-shadow: inset 0 0 0 0.5px var(--dsw-alias-border-l3);
}
`;

/** Inject the tab strip's stylesheet for the owning plugin lifetime. */
export function installTabsStyles(ctx: ClientContext): void {
  if (typeof document === "undefined") return;
  ctx.effect(() => {
    const tag = document.createElement("style");
    tag.dataset.plugin = "@exagone313/dsh-podman";
    tag.textContent = TABS_STYLES;
    document.head.appendChild(tag);
    return () => {
      tag.remove();
    };
  }, "podman: tab strip styles");
}
