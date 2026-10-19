// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// One card of a tab: a filled surface with a real title, its count (or other
// one-line summary) and — when it owns one — its primary action on the heading
// row. A card with content rules off that row; hairlines otherwise live between
// the rows inside a card, so a card never carries a rule above its title.

import {
  actionRow,
  card,
  cardContent,
  cardTitle,
  headerCount,
  headerRule,
  rowActions,
  rowMain,
} from "./container-card-styles.js";
import {
  TABLE_CARD_CLASS,
  TABLE_CARD_CONTENT_CLASS,
} from "./container-card-table-styles.js";
import { type ReactNode, useId } from "react";

export function CardGroup(props: {
  title: string;
  // The count (or other one-line summary) shown beside the title.
  summary: string;
  // The card's single primary action, right-aligned in the heading row.
  action?: ReactNode;
  // Whether the card holds any row: a filled category draws a hairline under
  // its title row, an empty one does not.
  hasContent: boolean;
  // An extra class on the card surface, for the stylesheet-driven behaviours
  // (the image table's container query) that cannot be inline styles.
  className?: string;
  children: ReactNode;
}): ReactNode {
  const { title, summary, action, hasContent, className, children } = props;
  const headingId = useId();
  // A responsive card wraps its body so the containment applies to the content
  // alone, never to the card's own box.
  const isTableCard = className !== undefined &&
    className.split(/\s+/).includes(TABLE_CARD_CLASS);
  return (
    <section style={card} className={className} aria-labelledby={headingId}>
      <div style={hasContent ? { ...actionRow, ...headerRule } : actionRow}>
        <div style={rowMain}>
          <h3 id={headingId} style={cardTitle}>{title}</h3>
          {summary === "" ? null : <span style={headerCount}>{summary}</span>}
        </div>
        {action === undefined ? null : <div style={rowActions}>{action}</div>}
      </div>
      {isTableCard
        ? (
          <div className={TABLE_CARD_CONTENT_CLASS} style={cardContent}>
            {children}
          </div>
        )
        : children}
    </section>
  );
}
