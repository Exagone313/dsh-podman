// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import type { Context as ClientContext } from "@deepseek-ai/cordis";
import { TABLE_CARD_CLASS } from "./container-card-table-styles.js";

// The class on the workspace containers panel's own wrapper. The panel renders
// the settings page's WorkspaceSection, whose card keeps everything it draws in
// the panel — its fill, its padding and the rules between its own rows — but not
// its outline: the pane is already the surface, so the card's border would only
// draw a box inside a box. Keying the override to this wrapper is what leaves the
// settings page's card exactly as it was, since no card there sits under it.
export const CONTAINERS_PANEL_CLASS = "dsh-podman-containers-panel";

// The card's border is an inline style (`card` in container-card-styles.ts), so
// only an important declaration can drop it; the rule touches no other property,
// which is what keeps the card's own look inside the panel unchanged.
export const CONTAINERS_PANEL_STYLES = `
.${CONTAINERS_PANEL_CLASS} > .${TABLE_CARD_CLASS} {
  border: 0 !important;
}
`;

/** Inject the panel's border override for the owning plugin lifetime. */
export function installContainersPanelStyles(ctx: ClientContext): void {
  if (typeof document === "undefined") return;
  ctx.effect(() => {
    const tag = document.createElement("style");
    tag.dataset.plugin = "@exagone313/dsh-podman";
    tag.textContent = CONTAINERS_PANEL_STYLES;
    document.head.appendChild(tag);
    return () => {
      tag.remove();
    };
  }, "podman: containers panel styles");
}
