// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// The one shared PTC container, as the Status tab renders it below the
// component card. It belongs to no workspace, so it is not listed among the
// workspace cards: it is a card of its own, without a heading for now — its
// identity line carries the container's name, its state chip, the violet PTC
// marker and its creation date, and its body is the read-only image the
// orchestrator builds on demand. A missing container is the normal state before
// its first use, so its status chip reads Missing in the muted tone rather than
// as an error.

import { bareActionKey, type PtcView } from "./card-protocol.js";
import {
  type PtcActionView,
  ptcActionViews,
  ptcChips,
} from "./container-card-ptc.js";
import {
  ConfirmButton,
  CopyButton,
  ImageRow,
  StatusChip,
} from "./container-card-shared.js";
import {
  actionRow,
  blockWrapper,
  card,
  cardTitle,
  containerNameHeading,
  headerRule,
  rowActions,
  rowMain,
  rowMeta,
} from "./container-card-styles.js";
import { relativeTimeLabel } from "./relative-time.js";
import type { Translate } from "./locales.js";
import { type ReactNode } from "react";

export function PtcSection(props: {
  t: Translate;
  ptc: PtcView;
  // The plugin's active locale, for the relative creation time.
  locale: string;
  pendingActions: readonly string[];
  onRecreate: () => void;
  onRemove: () => void;
}): ReactNode {
  const { t, ptc, locale, pendingActions, onRecreate, onRemove } = props;
  const absent = ptc.state === "absent";
  const actions = ptcActionViews(t, ptc.containerName);
  const pending = (action: PtcActionView): boolean =>
    pendingActions.includes(bareActionKey(action.op));
  return (
    <section style={card}>
      <div style={{ ...actionRow, ...headerRule }}>
        <div style={rowMain}>
          <span
            style={{
              ...cardTitle,
              ...containerNameHeading,
              overflowWrap: "anywhere",
            }}
          >
            {ptc.containerName}
          </span>
          {ptcChips(t, ptc.state).map((chip) => (
            <StatusChip
              key={chip.key}
              tone={chip.tone}
              label={chip.label}
              title={chip.title}
            />
          ))}
          {absent || ptc.createdAt === "" ? null : (
            <>
              <span style={rowMeta} title={ptc.createdAt}>
                {relativeTimeLabel(ptc.createdAt, locale)}
              </span>
              <CopyButton
                t={t}
                value={ptc.createdAt}
                label={t("copyCreated")}
              />
            </>
          )}
        </div>
        <div style={rowActions}>
          {actions.map((action) => (
            <ConfirmButton
              key={action.key}
              t={t}
              // The shared container carries no editable field, so both actions
              // confirm before they touch its fixed identity. Recreate is a
              // deliberate rebuild rather than a removal; Remove keeps the
              // error colour of every removal.
              emphasis={action.destructive ? undefined : "business"}
              destructive={action.destructive}
              label={action.label}
              title={action.title}
              description={action.description}
              confirmLabel={action.title}
              // Nothing is there to recreate or remove before the container
              // exists.
              disabled={absent}
              pending={pending(action)}
              onConfirm={action.key === "recreate" ? onRecreate : onRemove}
            />
          ))}
        </div>
      </div>
      <div style={blockWrapper}>
        <ImageRow t={t} mode="view" image={ptc.imageId} />
      </div>
    </section>
  );
}
