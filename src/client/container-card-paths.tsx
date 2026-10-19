// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { DiscardChangesModal, PathRow } from "./container-card-shared.js";
import { pathsEqual } from "./container-card-config.js";
import { hint } from "./container-card-styles.js";
import { ROW_LIST_CLASS } from "./container-card-table-styles.js";
import type { Translate } from "./locales.js";
import { Button, Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import { type ReactNode, useMemo, useState } from "react";

// One editable PATH entry. The id keeps React keys stable while a path is
// edited or reordered, so an input keeps focus.
export interface PathEntry {
  id: number;
  path: string;
}

let nextPathId = 0;

// pathEntries wraps a stored PATH list for editing.
export function pathEntries(paths: readonly string[]): PathEntry[] {
  return paths.map((path) => ({ id: nextPathId++, path }));
}

// PathsList edits one ordered PATH-addition list: add, reorder by dragging the
// handle or with the move buttons, edit in place, and remove. It is controlled:
// every change reports the whole list through onChange. Every entry renders as
// the shared PATH row — the same label above the same value slot as a container
// block's read-only PATH field, with an editable input in the value position —
// so the dialog and the block read alike.
export function PathsList(props: {
  t: Translate;
  entries: readonly PathEntry[];
  busy: boolean;
  onChange: (entries: PathEntry[]) => void;
}): ReactNode {
  const { t, entries, busy, onChange } = props;
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const move = (from: number, to: number): void => {
    if (from === to || to < 0 || to >= entries.length) return;
    const next = [...entries];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    onChange(next);
  };
  // A new entry is prepended: the first entry has the highest priority.
  const add = (): void => {
    onChange([{ id: nextPathId++, path: "" }, ...entries]);
  };
  const update = (index: number, path: string): void => {
    onChange(
      entries.map((entry, at) => (at === index ? { ...entry, path } : entry)),
    );
  };
  return (
    <div
      className={ROW_LIST_CLASS}
      style={{ display: "flex", flexDirection: "column", gap: "8px" }}
    >
      {entries.length === 0
        ? <p style={{ ...hint, margin: 0 }}>{t("noPaths")}</p>
        : (
          entries.map((entry, index) => (
            <PathRow
              key={entry.id}
              t={t}
              mode="edit"
              path={entry.path}
              disabled={busy}
              autoFocus={entry.path === "" && index === 0}
              first={index === 0}
              last={index === entries.length - 1}
              onChange={(path) => update(index, path)}
              onMove={(delta) => move(index, index + delta)}
              onRemove={() => onChange(entries.filter((_, at) => at !== index))}
              onDragStart={() => setDragIndex(index)}
              onDrop={() => {
                if (dragIndex !== null) move(dragIndex, index);
                setDragIndex(null);
              }}
            />
          ))
        )}
      <div>
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={add}
        >
          {t("addPathEntry")}
        </Button>
      </div>
    </div>
  );
}

// PathsEditor shows the container's ordered PATH variable additions as the
// shared field rows the container block shows, and edits them in a modal around
// PathsList. Apply sends the whole list at once.
export function PathsEditor(props: {
  t: Translate;
  paths: readonly string[];
  busy: boolean;
  enabled: boolean;
  onApply: (paths: string[]) => void;
}): ReactNode {
  const { t, paths, busy, enabled, onApply } = props;
  const [open, setOpen] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [draft, setDraft] = useState<PathEntry[]>([]);
  // The read-only rows reuse the same ids as the editor, so two identical PATH
  // entries never collide on a React key.
  const shown = useMemo(() => pathEntries(paths), [paths]);
  // The list is unordered only by identity; a reorder or an edited path is an
  // edit that closing the dialog would lose.
  const dirty = !pathsEqual(draft.map((entry) => entry.path), paths);
  const requestClose = (): void => {
    if (dirty) setConfirmClose(true);
    else setOpen(false);
  };
  const discardAndClose = (): void => {
    setConfirmClose(false);
    setOpen(false);
  };
  const openEditor = (): void => {
    setDraft(pathEntries(paths));
    setConfirmClose(false);
    setOpen(true);
  };
  const apply = (): void => {
    // An entry left blank is not a PATH addition: it is dropped rather than
    // sent as an empty path.
    onApply(
      draft.map((entry) => entry.path.trim()).filter((path) => path !== ""),
    );
    setOpen(false);
  };
  return (
    <div
      className={ROW_LIST_CLASS}
      style={{ display: "flex", flexDirection: "column", gap: "8px" }}
    >
      {paths.length === 0
        ? <p style={{ ...hint, margin: 0 }}>{t("noPaths")}</p>
        : (
          shown.map((entry) => (
            <PathRow
              key={entry.id}
              t={t}
              mode="view"
              path={entry.path}
            />
          ))
        )}
      <div>
        <Button
          variant="outline"
          size="sm"
          disabled={!enabled}
          onClick={openEditor}
        >
          {t("editPaths")}
        </Button>
      </div>
      <Modal
        open={open}
        onClose={requestClose}
        title={t("pathsTitle")}
        closeLabel={t("cancel")}
        footer={
          <>
            <Button variant="outline" size="sm" onClick={requestClose}>
              {t("cancel")}
            </Button>
            <Button variant="primary" size="sm" disabled={busy} onClick={apply}>
              {t("apply")}
            </Button>
          </>
        }
      >
        <PathsList t={t} entries={draft} busy={busy} onChange={setDraft} />
      </Modal>
      <DiscardChangesModal
        t={t}
        open={confirmClose}
        onCancel={() => setConfirmClose(false)}
        onDiscard={discardAndClose}
      />
    </div>
  );
}
