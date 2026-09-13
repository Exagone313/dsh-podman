// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import type { Context as ClientContext } from "@deepseek-ai/cordis";

// The class passed to TerminalBlock for podman command results.
export const TERMINAL_CLASS = "dsh-podman-terminal";

// Mirrors ui-tool's .terminalBody/.terminal so a podman command result matches
// the built-in Bash result: small code font (12px/18px), 224px output cap,
// 4px indent, l1 border.
export const TERMINAL_STYLES = `
.dsh-podman-terminal {
  --dsl-terminal-font: var(--dsw-font-markdown-code-block-small);
  --dsl-terminal-line-height: 18px;
  --dsl-terminal-output-max-height: 224px;
  margin: 4px 0 4px 4px;
  border: 1px solid var(--dsw-alias-border-l1);
}
`;

/** Inject the terminal card stylesheet for the owning plugin lifetime. */
export function installTerminalStyles(ctx: ClientContext): void {
  if (typeof document === "undefined") return;
  ctx.effect(() => {
    const tag = document.createElement("style");
    tag.dataset.plugin = "@exagone313/dsh-podman";
    tag.textContent = TERMINAL_STYLES;
    document.head.appendChild(tag);
    return () => {
      tag.remove();
    };
  }, "podman: terminal styles");
}
