// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import type { Context as ClientContext } from "@deepseek-ai/cordis";
import { PLUGIN_PACKAGE } from "./plugin-navigation.js";

// dsh 0.2.2 renders a bundle page's README detail document before the bundle
// configuration section (`[data-plugin-config]` in the harness's PackageDetail).
// Both are children of a column flex container, so ordering our section first
// moves the settings above the README without hiding the documentation. The
// page wrapper carries `data-plugin-detail` with the bundle's package name, so
// scoping the rule to it leaves other plugin pages alone. If a future harness
// drops either attribute or the flex layout, the declaration stops applying
// and the page falls back to README-first.
export const SETTINGS_PAGE_STYLES = `
[data-plugin-detail="${PLUGIN_PACKAGE}"] [data-plugin-config] {
  order: -1;
}
`;

/** Inject the bundle page's section order for the owning plugin lifetime. */
export function installSettingsPageStyles(ctx: ClientContext): void {
  if (typeof document === "undefined") return;
  ctx.effect(() => {
    const tag = document.createElement("style");
    tag.dataset.plugin = PLUGIN_PACKAGE;
    tag.textContent = SETTINGS_PAGE_STYLES;
    document.head.appendChild(tag);
    return () => {
      tag.remove();
    };
  }, "podman: settings page styles");
}
