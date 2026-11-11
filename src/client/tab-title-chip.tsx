// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// The layout both right-Sidebar tab titles share: the type's glyph followed by
// its label on one inline row. The label alone ellipsizes, so a long shell name
// or translated title never pushes the chip's controls out of the strip.
import type { ReactNode } from "react";

/** The glyph and label one sidebar tab chip (or floating header) shows. */
export function TabTitleChip(props: {
  readonly icon: ReactNode;
  readonly title: string;
}): ReactNode {
  return (
    <span style={CHIP_STYLE}>
      {props.icon}
      <span style={TITLE_STYLE}>{props.title}</span>
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
