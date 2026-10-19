// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import type { Context as ClientContext } from "@deepseek-ai/cordis";

// The class passed to Modal for every container dialog (the Add-container
// dialog, the Create-container dialog and the Edit dialog). The primitive's own
// dialog is a 380px card that grows with its content, so this class gives all
// three the same explicit size: the viewport's height and a desktop width. The
// header and the footer stay pinned, the body between them is the only region
// that scrolls, and an environment row shows its Key and Value on one line on a
// desktop pane. The width is a max (the primitive's own 100% still fits a
// narrow pane), and the cap is the smaller of the viewport and the mask's
// padding box, which is the box the primitive sizes its cards against.
export const CONTAINER_DIALOG_CLASS = "dsh-podman-container-dialog";

// The class passed as the dialog's contentClassName: the primitive wraps the
// header, the optional description and the body in this region, so making it
// the flex column that may shrink is what pins the header while the body below
// takes the remaining height.
export const CONTAINER_DIALOG_CONTENT_CLASS =
  "dsh-podman-container-dialog-content";

// The class the small dialogs carry (the Publish port dialog, the Create secret
// dialog and the project-directory picker): they keep an explicit compact cap
// instead of the container dialogs' desktop width.
export const COMPACT_DIALOG_CLASS = "dsh-podman-compact-dialog";

export const CONTAINER_DIALOG_STYLES = `
.dsh-podman-container-dialog.dsh-podman-container-dialog {
  width: min(1100px, 92vw);
  max-height: min(85vh, 100%);
  gap: 0;
  padding: 0;
}
.dsh-podman-container-dialog-content.dsh-podman-container-dialog-content {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
}
/* The header, the body and the footer share one 24px inset. The header and the
   footer stay pinned, and the body is the one region allowed to scroll: it is
   the content region's last element (the description, when a caller gives one,
   is a paragraph before it). */
.dsh-podman-container-dialog-content > div:first-child {
  flex: none;
  padding: 24px 24px 12px;
}
.dsh-podman-container-dialog-content > div:last-child {
  min-height: 0;
  overflow-y: auto;
  padding: 0 24px;
}
.dsh-podman-container-dialog > div:last-child {
  flex: none;
  padding: 24px;
}
.dsh-podman-compact-dialog.dsh-podman-compact-dialog {
  width: min(480px, 92vw);
}
`;

/** Inject the container dialogs' stylesheet for the owning plugin lifetime. */
export function installDialogStyles(ctx: ClientContext): void {
  if (typeof document === "undefined") return;
  ctx.effect(() => {
    const tag = document.createElement("style");
    tag.dataset.plugin = "@exagone313/dsh-podman";
    tag.textContent = CONTAINER_DIALOG_STYLES;
    document.head.appendChild(tag);
    return () => {
      tag.remove();
    };
  }, "podman: dialog styles");
}
