// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// A title inside a card (a container or a resource), one step above body text.
export const cardTitle: React.CSSProperties = {
  margin: 0,
  fontSize: "14px",
  fontWeight: 600,
  lineHeight: 1.4,
  color: "var(--dsw-alias-label-primary)",
};

// The heading of a subsection inside a card; the title every existing call site
// already uses.
export const sectionTitle: React.CSSProperties = {
  margin: 0,
  fontSize: "14px",
  fontWeight: 600,
  lineHeight: 1.4,
  color: "var(--dsw-alias-label-primary)",
};

// The page column: one readable column, bounded like the harness's settings.
// Sections are separated by this gap alone — never by a rule above a title.
export const pageColumn: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "24px",
  width: "100%",
  maxWidth: "760px",
  color: "var(--dsw-alias-label-primary)",
};

// A card: the filled, bordered surface a tab lists its rows in. Hairlines live
// between the rows inside it and under its title row, and nowhere else.
export const card: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "12px",
  padding: "16px",
  border: "0.5px solid var(--dsw-alias-border-l2)",
  borderRadius: "var(--dsw-radius-lg)",
  background: "var(--dsw-alias-settings-card-fill)",
};

// A card's rows: one column with no gap of its own, so each row's own padding
// and hairline set the rhythm.
export const cardList: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
};

// A card's body, under its title row: one column with the card's own gap, and
// the wrapper the responsive table stylesheet makes its containment context. The
// containment lives here, not on the card, so it can never size the card's own
// box.
export const cardContent: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "12px",
};

// The one alignment rule every action row follows, in every tab: the row
// wraps, its name column grows to claim the title line, and that growth is what
// holds the action group at the line's right end. A group that cannot fit
// beside the name wraps onto its own line, where it starts at the left margin.
// No `margin-left: auto` is involved: an auto margin would push a wrapped group
// to the right edge too, which is the bug this replaces. Every caller composes
// these styles (plus rowMain and rowName for the name side) rather than
// carrying its own.
export const actionRow: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "8px",
};

// The name column of an action row. Its 240px basis is what makes the action
// group wrap on a narrow pane; its growth is what keeps the group at the right
// end while both share the title line. min-width 0 lets the column shrink, so a
// long name can never push the group away.
export const rowMain: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: "8px",
  flex: "1 1 240px",
  minWidth: 0,
};

// A name inside rowMain: it never claims more width than it is offered, so a
// long name truncates with an ellipsis instead of orphaning the row's actions.
export const rowName: React.CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

// The action group of an action row: it wraps within itself and carries no
// margin of its own, so it sits at the right end while it shares the title line
// and at the left margin as soon as it drops onto its own.
export const rowActions: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "8px",
};

// A destructive action: the same outline control as any other, with its text
// and stroke carrying the error state colour, so a removal reads as one rather
// than as an ordinary secondary action.
export const destructiveAction: React.CSSProperties = {
  color: "var(--dsw-alias-state-error-primary)",
  borderColor: "var(--dsw-alias-state-error-primary)",
};

// The emphasis a neutral action can carry. Each value paints the outline control
// in a state colour, so an action that is neither primary nor destructive reads
// as the role it plays; the words still say what it does, so colour is never the
// only signal.
export type ActionEmphasis = "warn" | "business" | "success";

// A warn-emphasised action: the warn state colour on text and stroke, over the
// warn tint, so a cautious partial cleanup reads as one.
export const warnAction: React.CSSProperties = {
  color: "var(--dsw-alias-state-warn-primary)",
  borderColor: "var(--dsw-alias-state-warn-primary)",
  background: "var(--dsw-alias-state-warn-tertiary)",
};

// An accent-emphasised action: the business state colour on text and stroke,
// over a faint tint of it, so a deliberate build action reads as one without
// competing with a card's single primary control.
export const businessAction: React.CSSProperties = {
  color: "var(--dsw-alias-state-business-primary)",
  borderColor: "var(--dsw-alias-state-business-primary)",
  background:
    "color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent)",
};

// A success-emphasised action: the success state colour on text and stroke, over
// a faint tint of it, so a recommended setup step reads as one. The harness has
// no success-tertiary token, so the tint mixes the primary, as the error tone
// does.
export const successAction: React.CSSProperties = {
  color: "var(--dsw-alias-state-success-primary)",
  borderColor: "var(--dsw-alias-state-success-primary)",
  background:
    "color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent)",
};

// The violet the PTC chip, the tmpfs mount marker and the template actions all
// read with. The harness ships no violet accent token — its accent pair is blue
// — so all three tint this one literal, at the chip's 12% fill, rather than
// each carrying its own copy. One literal is what keeps them identical.
export const violetTone: { color: string; background: string } = {
  color: "#a78bfa",
  background: "color-mix(in srgb, #a78bfa 12%, transparent)",
};

// A template action: its ink, stroke and fill are the violet shared with the PTC
// and tmpfs styling, so the three stay identical in colour.
export const templateAction: React.CSSProperties = {
  color: violetTone.color,
  borderColor: violetTone.color,
  background: violetTone.background,
};

// The chosen destination in the load popup: the same shared violet with a
// stronger tint, so the selected mode stays visible without becoming a second
// filled primary control.
export const templateActionSelected: React.CSSProperties = {
  ...templateAction,
  background: `color-mix(in srgb, ${violetTone.color} 20%, transparent)`,
};

// The emphasis styles by name, so a caller that renders a plain Button can paint
// it the same way ConfirmButton's own emphasis prop does.
export const emphasisAction: Record<ActionEmphasis, React.CSSProperties> = {
  warn: warnAction,
  business: businessAction,
  success: successAction,
};

// One hairline-separated row inside a card; the caller gives every row but the
// last the rowDivider.
export const cardRow: React.CSSProperties = {
  ...actionRow,
  padding: "10px 0",
};

// A card row whose body is a block — a title line plus labelled lines — and
// whose actions sit on their own left-aligned line below it. The image and
// container rows read this way: no actions column splits a block from what it
// does. It is one plain column, never a wrapping one, so its own box is exactly
// the block it holds.
export const cardBlockRow: React.CSSProperties = {
  ...cardRow,
  flexWrap: "nowrap",
  flexDirection: "column",
  alignItems: "stretch",
};

// The block a block row holds: the title line and, under it, the field groups.
// It claims the row's full width: the row is a column, so its cross axis is the
// inline one and a start-aligned item would shrink to its own content, which the
// container queries inside the block would then read as a narrow card. It keeps
// an automatic height, so no ancestor flex or grid line can stretch it below its
// own content.
export const blockWrapper: React.CSSProperties = {
  width: "100%",
  height: "auto",
};

// The hairline under a card's title row, applied only when the card has
// content: an empty category keeps its title and its empty-state line with no
// rule between them, so a rule never separates a title from nothing. It is
// never a rule above a title. The padding is what keeps the rule off the title
// it closes; below it, the card's own gap supplies the same 12px before the
// body.
export const headerRule: React.CSSProperties = {
  paddingBottom: "12px",
  borderBottom: "0.5px solid var(--dsw-alias-border-l2)",
};

// The field groups of a container block, under its title line: one column, so a
// long list only makes the block taller.
export const blockFields: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "12px",
  marginTop: "6px",
};

// A labelled group of read-only fields inside a container block.
export const fieldGroup: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "8px",
};

// The label of one field group, one step down from the block's title.
export const fieldGroupLabel: React.CSSProperties = {
  fontSize: "13px",
  fontWeight: 500,
  lineHeight: "20px",
  color: "var(--dsw-alias-label-secondary)",
};

// A read-only field's control line: the field itself grows and its own copy
// button sits at the line's end.
export const fieldLine: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "4px",
  minWidth: 0,
};

// The status strip above the tabs: the state chips that summarise the page.
export const statusStrip: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "8px",
};

// One tab's body: the same column gap the page uses, under the tablist.
export const tabPanel: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "24px",
};

// The heading of one editor group inside a card or dialog (the Defaults tab's
// environment group; the container dialogs label their groups with DialogGroup
// instead). It never carries a rule.
export const editorTitle: React.CSSProperties = {
  margin: 0,
  fontSize: "13px",
  fontWeight: 600,
  lineHeight: 1.4,
  color: "var(--dsw-alias-label-primary)",
};

// The secondary line of a card row (a cache's usage beside its manager), so the
// row's first line stays a title.
export const rowMeta: React.CSSProperties = {
  fontSize: "13px",
  color: "var(--dsw-alias-label-tertiary)",
};

// A hairline between the rows of one card; the last row omits it.
export const rowDivider: React.CSSProperties = {
  borderBottom: "0.5px solid var(--dsw-alias-border-l2)",
};

// A count or state summary rendered beside a section or disclosure title, so a
// collapsed row states what it holds without colour alone.
export const headerCount: React.CSSProperties = {
  marginLeft: "8px",
  fontSize: "13px",
  color: "var(--dsw-alias-label-caption)",
  fontVariantNumeric: "tabular-nums",
};

// The workspace header's one status phrase: its running part reads in the
// secondary label colour while the stopped part — or the empty "0 containers" —
// is greyed, so one phrase states both counts without a second summary beside
// it.
export const workspaceStatus: React.CSSProperties = {
  marginLeft: "8px",
  fontSize: "13px",
  color: "var(--dsw-alias-label-secondary)",
  fontVariantNumeric: "tabular-nums",
};

// The greyed half of the workspace status phrase.
export const statusMuted: React.CSSProperties = {
  color: "var(--dsw-alias-label-tertiary)",
};

// A state chip: a short state word whose colour carries the same fact the words
// already state. The tone's own fill and foreground are applied by the StatusChip
// component, which composes this base style.
export const statusChip: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  height: "20px",
  padding: "0 8px",
  borderRadius: "999px",
  fontSize: "12px",
  lineHeight: "18px",
  fontWeight: 500,
  whiteSpace: "nowrap",
};

// The labelled lines under an image's name. Each line is one field of the
// snapshot; the class on every line (see container-card-table-styles.ts) turns
// the label-above-value stack on for a narrow card.
export const imageFields: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "4px",
  marginTop: "6px",
};

// A field line's label: one step down and greyed, so the value reads first.
export const imageFieldLabel: React.CSSProperties = {
  color: "var(--dsw-alias-label-tertiary)",
};

// A field line's value in the plain body scale.
export const imageFieldValue: React.CSSProperties = {
  color: "var(--dsw-alias-label-primary)",
  minWidth: 0,
  overflowWrap: "anywhere",
};

// The placeholder one missing value reads as, in a container block and in the
// status table alike: the body size, colour and line-height, so a dash is never
// a smaller or greyer fact than the values around it.
export const missingValue: React.CSSProperties = {
  fontSize: "13px",
  lineHeight: "20px",
  color: "var(--dsw-alias-label-primary)",
};

// The value of a field whose content claims a line of its own (the packages
// chips), so it never sits beside its label.
export const imageFieldOwnLine: React.CSSProperties = {
  ...imageFieldValue,
  width: "100%",
  display: "flex",
  flexWrap: "wrap",
  gap: "6px",
};

export const banner: React.CSSProperties = {
  padding: "6px 10px",
  borderRadius: "6px",
  border: "1px solid rgba(210,153,34,0.6)",
  margin: "12px 0",
  fontSize: "13px",
};

export const greyId: React.CSSProperties = {
  color: "var(--dsw-alias-label-tertiary)",
  fontSize: "12px",
  fontFamily: "var(--dsw-alias-font-mono, ui-monospace, monospace)",
};

export const hint: React.CSSProperties = {
  fontSize: "13px",
  lineHeight: 1.5,
  color: "var(--dsw-alias-label-tertiary)",
  margin: "8px 0",
};

export const fieldLabel: React.CSSProperties = {
  fontSize: "12px",
  color: "var(--dsw-alias-label-tertiary)",
  whiteSpace: "nowrap",
  // Hugs the control when the label fills a grid cell; an auto-width flex item
  // (the tab body's toolbar) is unaffected.
  textAlign: "right",
};

// A resource's name on an action row (an image, volume, secret or cache) as a
// card title. rowName keeps a long name from pushing the row's actions onto an
// orphan line.
export const containerNameHeading: React.CSSProperties = {
  ...cardTitle,
  ...rowName,
};

// One editor group inside a settings card or a dialog group.
export const editorGroup: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "8px",
};

// One row of labelled fields — the environment editor's, or a container block's
// read-only fields. Each field carries its visible label above its control, and
// a row's own Remove control sits at the fields' bottom edge, so it reads as
// part of that row even after it wraps below them.
export const envRow: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "flex-end",
  gap: "8px",
};

// One labelled field of such a row.
export const envField: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "4px",
  flex: "1 1 160px",
  minWidth: 0,
};

// A field label in such a row, one step down from its value.
export const envFieldLabel: React.CSSProperties = {
  fontSize: "12px",
  lineHeight: "18px",
  color: "var(--dsw-alias-label-tertiary)",
};

// A hint that states a fact beside a field's value without replacing it (a port
// the gateway has not bound yet).
export const fieldHint: React.CSSProperties = {
  fontSize: "12px",
  lineHeight: "18px",
  color: "var(--dsw-alias-label-tertiary)",
  whiteSpace: "nowrap",
};

// One labelled field of a mount row: the label-over-value stack of a read-only
// field without a flex basis of its own. The class on the field (see
// container-card-table-styles.ts) shares the row's line while there is room and
// gives every field a line of its own on a narrow row, so the container block
// and the Mounts editor stack identically.
export const mountField: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "4px",
  minWidth: 0,
};

// The Kind field of a mount row: the label-over-value stack of a mount field,
// sized to its chip instead of growing like a text field. It top-aligns, so its
// label keeps the line of the labels beside it, and its value line reserves an
// input's own height (see the class in container-card-table-styles.ts), so the
// chip sits on the inputs' line instead of at the row's top edge.
export const mountKindField: React.CSSProperties = {
  ...mountField,
  flex: "0 0 auto",
  alignSelf: "flex-start",
};

// The staged controls stacked: the buttons keep the first line, so the marker
// below them can appear without moving the buttons themselves.
export const footerStack: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  gap: "2px",
  width: "100%",
};

// The marker beside a staged editor's Save/Discard controls, so an unsaved
// draft is named in text rather than only shown by an enabled button.
export const dirtyBadge: React.CSSProperties = {
  fontSize: "12px",
  color: "var(--dsw-alias-state-warn-primary)",
};

// The dirty marker's own line: it is always rendered so its height is reserved
// and the buttons above never shift when the draft becomes dirty; the margin
// keeps it off the action row it reports about.
export const dirtyBadgeSlot: React.CSSProperties = {
  ...dirtyBadge,
  minHeight: "18px",
  marginTop: "6px",
};

export const footerRow: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  paddingTop: "12px",
  marginTop: "12px",
  borderTop: "1px solid var(--dsw-alias-border-l2)",
};

export const imageSelect: React.CSSProperties = {
  appearance: "none",
  padding: "6px 10px",
  borderRadius: "var(--dsw-radius-md)",
  border: "1px solid var(--dsw-alias-border-l2)",
  background: "var(--dsw-alias-bg-layer-3)",
  color: "inherit",
  fontSize: "12px",
  // Fluid: fills the space it is given but never exceeds 160px, so a narrow
  // pane shrinks it instead of letting it overflow.
  width: "100%",
  maxWidth: "160px",
  minWidth: 0,
  flex: "0 1 auto",
};

// A select that fills its label's row where fields are stacked; the narrow
// guide card uses it so the container and shell controls share one width.
export const fieldSelect: React.CSSProperties = {
  ...imageSelect,
  width: "100%",
};

// A select inside a shared field row: it fills the value slot exactly like the
// text input beside it — the same flex sizing the slot class carries
// (SLOT_CLASS in container-card-field-styles.ts) — without the compact cap a
// toolbar select carries, so switching a row's kind or control never resizes
// it.
export const slotSelect: React.CSSProperties = {
  ...imageSelect,
  flex: "1 1 0",
  maxWidth: "none",
};
