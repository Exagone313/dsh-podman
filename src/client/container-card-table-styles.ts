// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import type { Context as ClientContext } from "@deepseek-ai/cordis";

// The class on a card that owns a responsive table or block list (an image
// group, the status list, a workspace's containers). The card itself carries no
// containment, so its own box stays the plain card every other tab draws, and it
// start-aligns, so no flex or grid parent can stretch it to a taller sibling's
// height: the card is always exactly its content plus its own padding.
export const TABLE_CARD_CLASS = "dsh-podman-table-card";

// The class on that card's own content wrapper, under its title row. The wrapper
// is the containment context for the content below it, so the content reacts to
// the width it is actually given: a narrow desktop pane behaves exactly like a
// phone, while a viewport media query would not. Keeping the containment here
// means the card's own box can never be sized by it.
export const TABLE_CARD_CONTENT_CLASS = "dsh-podman-table-card-content";

// The class on a responsive table itself.
export const TABLE_CLASS = "dsh-podman-table";

// The class on one labelled line inside a row that is a block rather than one
// cell per field (an image's facts). On a wide card the label sits beside its
// value; the container query below stacks them on a narrow one.
export const FIELD_ROW_CLASS = "dsh-podman-field-row";

// The class on one mount row, in the container view's block and in the Mounts
// editor alike. It is that row's own containment context, so its fields react to
// the width the row is actually given and the two places stack identically, even
// where no card provides the context.
export const MOUNT_ROW_CLASS = "dsh-podman-mount-row";

// The class on a mount row's Kind field. It hugs its chip while the row has
// room; the container query below gives it a full line of its own once the row
// is narrow, the way every field beside it wraps there.
export const MOUNT_KIND_CLASS = "dsh-podman-mount-kind";

// The class on that field's value line, the line holding the chip. It reserves
// the height an input's line occupies beside it, so the chip sits on the input
// line while the label above keeps the labels' line; the container query below
// drops the reservation once the field has a line of its own.
export const MOUNT_KIND_VALUE_CLASS = "dsh-podman-mount-kind-value";

// The class on one labelled field of a mount row, in the container view's block
// and in the Mounts editor alike. It shares the row's line while there is room
// and takes a full line of its own on a narrow row, so the fields stack the
// same way wherever the row is rendered.
export const MOUNT_FIELD_CLASS = "dsh-podman-mount-field";

// The class the Destination field of a mount row adds to its own field class.
// The destination is the row's longest value, so on a wide row it takes a
// larger share of the free space than the fields beside it instead of leaving
// that space unused; the container query below still gives it a full line of
// its own on a narrow row through its field class.
export const MOUNT_DESTINATION_CLASS = "dsh-podman-mount-destination";

// The class on a field row's own trailing actions (removing a mount, a PATH
// entry or a port; attaching a secret). On a narrow row it claims the row's full
// width, so the actions read as the row's own footer rather than as a stray
// control beside a field.
export const MOUNT_ACTIONS_CLASS = "dsh-podman-mount-actions";

// The class on a mount row's error line under its source field: a typed project
// path the host refused, or a browse outside the projects root. It sets the
// line's typography and the error state's colour, so a refused path reads as the
// failure it is in both themes.
export const MOUNT_ERROR_CLASS = "dsh-podman-mount-error";

// The class on a group that lists shared rows: a container block's field group,
// and the editor that changes the same list. The marker is what a list needs —
// its rows already carry the mount row class wherever they render — for the
// container query below to separate its consecutive rows, in the container view
// and in an editor alike, and a future list gets the same hairlines by putting
// this marker on the wrapper that holds its rows. The marker is also the
// containment context for those rows, so the rule resolves in a dialog portaled
// outside every card, where no card is left to measure.
export const ROW_LIST_CLASS = "dsh-podman-row-list";

// Wide panes show the header row and print every field as its own column;
// narrow ones hide the header and print each cell's own label above its value,
// taken from the cell's data-label attribute. Nothing scrolls sideways: value
// cells may break anywhere.
//
// The card is a flex item of the tab panel, and the harness's plugin page stacks
// that panel in a flex too: a parent with the default `align-items: stretch`
// would give the card a taller sibling's height, so the card start-aligns in
// whatever box it lands in and measures its own content. The full width is
// stated because a start-aligned item in a column flex container (where the
// cross axis is the inline one) would otherwise shrink to its content, and the
// box is border-box so that width still contains the card's own padding and
// hairline.
export const TABLE_STYLES = `
.dsh-podman-table-card {
  align-self: start;
  box-sizing: border-box;
  width: 100%;
}
.dsh-podman-table-card-content {
  container-type: inline-size;
}
.dsh-podman-table {
  width: 100%;
  border-collapse: collapse;
}
.dsh-podman-table th,
.dsh-podman-table td {
  padding: 12px 12px 12px 0;
  text-align: left;
  vertical-align: top;
  overflow-wrap: anywhere;
}
.dsh-podman-table th:last-child,
.dsh-podman-table td:last-child {
  padding-right: 0;
}
.dsh-podman-table thead th {
  padding-top: 0;
  padding-bottom: 8px;
  font-size: 12px;
  font-weight: 500;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary);
}
.dsh-podman-table tbody tr + tr > td {
  border-top: 0.5px solid var(--dsw-alias-border-l2);
}
.dsh-podman-field-row {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 8px;
  font-size: 13px;
  line-height: 20px;
}
.dsh-podman-mount-row {
  container-type: inline-size;
}
/* A mount row's error line sits under the value it belongs to, at the value's
   size, in the error state's colour: the words name the failure and the colour
   repeats it, so it reads in either theme. */
.dsh-podman-mount-error {
  margin: 0;
  font-size: 13px;
  color: var(--dsw-alias-state-error-primary);
}
/* One labelled field of a mount row shares the line while there is room; the
   container query below gives it a line of its own on a narrow row. */
.dsh-podman-mount-field {
  flex: 1 1 160px;
}
/* The Destination field grows twice as much as the fields beside it and starts
   from a wider basis, so a wide row spends its free space on the destination
   instead of leaving it unused. It keeps width: 100% on its input and carries
   no cap. */
.dsh-podman-mount-destination {
  flex: 2 1 240px;
}
/* The Kind field's value line reserves the line an input occupies beside it —
   32px of control box plus its 0.5px stroke on each side — so the chip centres
   on the inputs' line instead of hugging the top of the row. */
.dsh-podman-mount-kind-value {
  min-height: 33px;
}
/* The list is its own containment context, so the query below resolves against
   the width its rows are given even when the list renders in a dialog portaled
   to the body, which no card wraps and which would otherwise leave the rows
   with nothing to measure. Because the list spans the same width its rows had,
   every other query still measures what it measured before. */
.dsh-podman-row-list {
  container-type: inline-size;
}
@container (max-width: 560px) {
  .dsh-podman-table,
  .dsh-podman-table tbody,
  .dsh-podman-table tr,
  .dsh-podman-table td {
    display: block;
  }
  .dsh-podman-table thead {
    display: none;
  }
  .dsh-podman-table tbody tr {
    padding: 12px 0;
  }
  .dsh-podman-table tbody tr + tr {
    border-top: 0.5px solid var(--dsw-alias-border-l2);
  }
  .dsh-podman-table tbody tr + tr > td {
    border-top: 0;
  }
  .dsh-podman-table td {
    padding: 0 0 8px;
  }
  .dsh-podman-table td:last-child {
    padding-bottom: 0;
  }
  .dsh-podman-table td::before {
    content: attr(data-label);
    display: block;
    font-size: 12px;
    line-height: 18px;
    color: var(--dsw-alias-label-tertiary);
  }
  /* A field line whose label sits beside its value on a wide card stacks the
     label above the value once the card is narrow. */
  .dsh-podman-field-row {
    flex-direction: column;
    gap: 0;
  }
  /* A mount row's Kind field stops hugging its chip and takes a line of its
     own, like the fields beside it. Its flex basis is auto, so the width is
     what gives the field that line. */
  .dsh-podman-mount-kind {
    width: 100%;
  }
  /* The Kind field now owns its line: with no input beside it to align with,
     its value line drops the height it reserved, so a stacked chip leaves no
     empty space under itself. */
  .dsh-podman-mount-kind-value {
    min-height: 0;
  }
  /* Every other field of a mount row — the Destination included — takes a full
     line of its own too, so the label always reads above its value on a narrow
     row. */
  .dsh-podman-mount-field,
  .dsh-podman-mount-destination {
    flex-basis: 100%;
  }
  /* A mount row's actions become that row's own full-width footer. */
  .dsh-podman-mount-actions {
    flex-basis: 100%;
    width: 100%;
  }
  /* Consecutive rows of one list — a container block's field group and the
     editor that changes the same list — take a hairline once they stack. Side
     by side on a wide pane the gap alone separates them, which is why the rule
     lives in this query alone, and the padding above each ruled row keeps the
     line in the gap instead of against the row it introduces. A group's label,
     its empty-state line and its own add controls carry no row class, so they
     never take a rule of their own. */
  .dsh-podman-row-list > .dsh-podman-mount-row + .dsh-podman-mount-row {
    border-top: 0.5px solid var(--dsw-alias-border-l2);
    /* The margin adds to the list's own gap, so the ruled row sits further from
       the row above it than from the one below: the line reads as the boundary
       of the row it introduces rather than as that row's top edge. */
    margin-top: 4px;
    padding-top: 8px;
  }
}
`;

/** Inject the responsive table's stylesheet for the owning plugin lifetime. */
export function installTableStyles(ctx: ClientContext): void {
  if (typeof document === "undefined") return;
  ctx.effect(() => {
    const tag = document.createElement("style");
    tag.dataset.plugin = "@exagone313/dsh-podman";
    tag.textContent = TABLE_STYLES;
    document.head.appendChild(tag);
    return () => {
      tag.remove();
    };
  }, "podman: table styles");
}
