// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import type { Context as ClientContext } from "@deepseek-ai/cordis";

// The class passed to Modal for the project directory browser. The layout,
// typography and tokens mirror dsh's own directory browser (680x500 dialog,
// two Miller columns, chevron breadcrumbs, 28px rows with folder icons), so the
// plugin's picker reads like the harness's workspace directory selection. The
// dialog is clamped to the projects root, so its breadcrumb trail starts there.
export const DIRECTORY_CLASS = "dsh-podman-directory";

export const DIRECTORY_STYLES = `
.dsh-podman-directory.dsh-podman-directory {
  width: min(680px, 100%);
  height: min(500px, calc(100dvh - 32px));
  padding: 0;
  gap: 0;
  --dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2);
  --dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2);
}
.dsh-podman-directory-scope {
  display: contents;
}
.dsh-podman-directory-header {
  display: flex;
  flex-direction: column;
  flex: none;
  gap: 8px;
  padding: 16px 14px 8px 24px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l3);
}
.dsh-podman-directory-title {
  margin: 0;
  min-height: 28px;
  font-size: 16px;
  line-height: 24px;
  font-weight: 510;
  color: var(--dsw-alias-label-primary);
}
.dsh-podman-directory-crumbbar {
  display: flex;
  align-items: center;
  gap: 4px;
  box-sizing: border-box;
  min-height: 24px;
  margin-left: -9px;
  padding: 0 8px;
  border: 1px solid transparent;
  border-radius: 8px;
}
.dsh-podman-directory-crumbs {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 0 1 auto;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}
.dsh-podman-directory-crumbseat {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: none;
  min-width: 0;
}
.dsh-podman-directory-crumb {
  border: none;
  background: transparent;
  padding: 0;
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  line-height: 20px;
  font-weight: 500;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
}
.dsh-podman-directory-crumb:hover {
  color: var(--dsw-alias-label-primary);
}
.dsh-podman-directory-crumb:disabled {
  cursor: default;
  color: var(--dsw-alias-label-caption);
}
.dsh-podman-directory-crumbchevron {
  flex: none;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-podman-directory-content {
  display: flex;
  flex-direction: column;
  flex: 1 1 0;
  min-height: 0;
  position: relative;
  padding: 16px 16px 16px 24px;
}
.dsh-podman-directory-miller {
  display: flex;
  align-items: stretch;
  flex: 1 1 0;
  min-height: 0;
  gap: 12px;
  overflow-x: auto;
  scrollbar-width: none;
}
.dsh-podman-directory-column {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1 1 0;
  min-width: 256px;
  margin: 0;
  list-style: none;
  overflow-y: auto;
  padding-right: 8px;
}
.dsh-podman-directory-divider {
  flex: none;
  width: 0.5px;
  background: var(--dsw-alias-border-l3);
}
.dsh-podman-directory-row {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  flex: none;
  padding: 4px;
  border: none;
  border-radius: 6px;
  background: transparent;
  text-align: left;
  cursor: pointer;
}
.dsh-podman-directory-seat {
  display: flex;
  flex: none;
}
.dsh-podman-directory-row:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover);
}
.dsh-podman-directory-row-selected,
.dsh-podman-directory-row-selected:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-active, var(--dsw-alias-interactive-bg-hover));
}
.dsh-podman-directory-row:disabled {
  cursor: default;
}
.dsh-podman-directory-rowicon {
  flex: none;
  color: var(--dsw-alias-label-secondary);
}
.dsh-podman-directory-rowicon-selected {
  flex: none;
  color: var(--dsw-alias-button-info-fill);
}
.dsh-podman-directory-rowname {
  flex: 1 1 0;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  line-height: 20px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}
.dsh-podman-directory-rowchevron {
  flex: none;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-podman-directory-status,
.dsh-podman-directory-error {
  margin: 0;
  padding: 4px;
  font-size: 12px;
  line-height: 18px;
}
.dsh-podman-directory-status {
  color: var(--dsw-alias-label-secondary);
}
.dsh-podman-directory-error {
  color: var(--dsw-alias-state-error-primary);
}
.dsh-podman-directory-loading {
  position: absolute;
  right: 16px;
  bottom: 8px;
  padding: 2px 8px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-layer-2);
}
.dsh-podman-directory-footer {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  flex: none;
  padding: 16px 24px;
  border-top: 0.5px solid var(--dsw-alias-border-l3);
}
.dsh-podman-directory-toggle {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0;
  border: none;
  background: transparent;
  font-size: 13px;
  line-height: 20px;
  font-weight: 500;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
.dsh-podman-directory-toggle[aria-pressed="true"] {
  color: var(--dsw-alias-label-primary);
}
.dsh-podman-directory-toggle:disabled {
  cursor: default;
  color: var(--dsw-alias-label-caption);
}
.dsh-podman-directory-gap {
  flex: 1 1 0;
}
.dsh-podman-directory-action {
  min-width: 72px;
}
`;

/** Inject the directory browser stylesheet for the owning plugin lifetime. */
export function installDirectoryStyles(ctx: ClientContext): void {
  if (typeof document === "undefined") return;
  ctx.effect(() => {
    const tag = document.createElement("style");
    tag.dataset.plugin = "@exagone313/dsh-podman";
    tag.textContent = DIRECTORY_STYLES;
    document.head.appendChild(tag);
    return () => {
      tag.remove();
    };
  }, "podman: directory styles");
}
