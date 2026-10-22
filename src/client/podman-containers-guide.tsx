// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// The workspace Containers panel's guide card: one capsule saying what the
// panel shows, and a click that opens it in the guide tab's place. Unlike the
// terminal's card it has nothing to choose, so the capsule the guide would draw
// itself is all it needs; it is still this plugin's own card so the entry reads
// in the same vocabulary as the terminal's.
import { PluginArtworkDefault } from "@deepseek-ai/dsh-client-ui-primitives";
import type {
  PropsLocale,
  PropsRuntime,
} from "@deepseek-ai/dsh-client-ui-slots";
import type { ReactNode } from "react";
import { PODMAN_CONTAINERS_KIND } from "./containers-tab.js";
import { NS } from "./locales.js";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar-right/client";

export type PodmanContainersGuideProps =
  & PropsRuntime<"sidebar.right.tab.guide.entry">
  & PropsLocale<typeof NS>;

export function PodmanContainersGuide(
  props: PodmanContainersGuideProps,
): ReactNode {
  const { tab } = props.useTabInfo();
  return (
    <button
      type="button"
      style={CARD_STYLE}
      data-sidebar-right-guide-entry={props.kind}
      onClick={() => {
        // Replace the guide tab in place, exactly like the shipped entry
        // capsules: the guide is a doorway, not a page that stays open.
        tab.actions.openTab(PODMAN_CONTAINERS_KIND, { replaceTab: true });
      }}
    >
      <span style={ICON_STYLE} aria-hidden="true">
        <PluginArtworkDefault size={22} />
      </span>
      <span style={TEXT_STYLE}>
        <span style={TITLE_STYLE}>{props.title}</span>
        {props.description === undefined
          ? null
          : <span style={DESCRIPTION_STYLE}>{props.description}</span>}
      </span>
    </button>
  );
}

// The card mirrors the harness guide capsule skin (`GuideBody .entry`): same
// padding, radius token, border and background as the entries beside it, so the
// glyph and title line up. Being a button, it also carries the capsule's
// pointer cursor and left-aligned text.
const CARD_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "14px",
  boxSizing: "border-box",
  width: "100%",
  minHeight: "56px",
  padding: "14px 20px",
  color: "var(--dsw-alias-label-primary)",
  font: "inherit",
  textAlign: "left",
  cursor: "pointer",
  border: "0.5px solid var(--dsw-alias-border-l3)",
  borderRadius: "var(--dsl-guide-entry-radius)",
  background: "var(--dsw-alias-bg-layer-1)",
};

const ICON_STYLE: React.CSSProperties = {
  display: "flex",
  flex: "none",
  alignItems: "center",
  justifyContent: "center",
  width: "26px",
  height: "26px",
  color: "var(--dsw-alias-label-secondary)",
};

const TEXT_STYLE: React.CSSProperties = {
  display: "flex",
  flex: 1,
  flexDirection: "column",
  gap: "2px",
  minWidth: 0,
};

const TITLE_STYLE: React.CSSProperties = {
  overflow: "hidden",
  color: "var(--dsw-alias-label-primary)",
  fontSize: "14px",
  lineHeight: 1.4,
  whiteSpace: "nowrap",
  textOverflow: "ellipsis",
};

const DESCRIPTION_STYLE: React.CSSProperties = {
  overflow: "hidden",
  color: "var(--dsw-alias-label-tertiary)",
  fontSize: "11px",
  lineHeight: 1.4,
  whiteSpace: "nowrap",
  textOverflow: "ellipsis",
};
