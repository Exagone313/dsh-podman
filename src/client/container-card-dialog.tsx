// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// The one shell the three container dialogs render through: the Add-container
// dialog, the Create-container dialog (the workspace's default) and the Edit
// dialog. Each dialog keeps its own draft and its own commands and renders its
// own body through the shared ContainerForm, while this component owns the
// primitive Modal, the explicit size, the pinned header and footer, the one
// scrolling body, and the footer's action row — so the three cannot drift apart
// in width, padding or action layout again. Only what the dialogs genuinely
// differ in is passed in: the title, the actions, and Edit's staged marker.

import {
  CONTAINER_DIALOG_CLASS,
  CONTAINER_DIALOG_CONTENT_CLASS,
} from "./container-card-dialog-styles.js";
import { dirtyBadge } from "./container-card-styles.js";
import { type Translate } from "./locales.js";
import { Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import { type ReactNode } from "react";

// The one footer: the reserved marker slot on the left, then the dialog's own
// actions, right-aligned. The marker slot is always rendered, so the actions
// keep their place whether or not a draft is staged.
const footerRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
  width: "100%",
};

// The marker slot's own line: it keeps the height of its text so the actions
// beside it never move when the marker appears.
const footerMarker: React.CSSProperties = {
  ...dirtyBadge,
  flex: "1 1 auto",
  minHeight: "18px",
};

// The marker line when it names a blocking problem rather than a staged draft:
// the same line and size, in the error state's colour.
const footerMarkerError: React.CSSProperties = {
  ...footerMarker,
  color: "var(--dsw-alias-state-error-primary)",
};

const footerActions: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "8px",
  flex: "none",
};

export function ContainerDialog(props: {
  t: Translate;
  open: boolean;
  title: string;
  onClose: () => void;
  // The staged-draft marker, in the footer's reserved left slot: Edit names its
  // unsaved draft there, and the slot stays empty in Add and Create.
  marker?: string;
  // Whether the marker names a blocking problem the dialog's action refuses,
  // painted in the error state colour instead of the staged warn tone.
  markerError?: boolean;
  // The dialog's own actions, right-aligned in the footer.
  actions: ReactNode;
  children: ReactNode;
}): ReactNode {
  const { t, open, title, onClose, marker, markerError, actions, children } =
    props;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      closeLabel={t("cancel")}
      className={CONTAINER_DIALOG_CLASS}
      contentClassName={CONTAINER_DIALOG_CONTENT_CLASS}
      footer={
        <div style={footerRow}>
          <span style={markerError === true ? footerMarkerError : footerMarker}>
            {marker ?? ""}
          </span>
          <div style={footerActions}>{actions}</div>
        </div>
      }
    >
      {children}
    </Modal>
  );
}
