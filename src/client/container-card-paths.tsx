// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { Field } from "./container-card-shared.js";
import { greyId, hint } from "./container-card-styles.js";
import { type ContainerPluginKey } from "./locales.js";
import { Button, Input, Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import { type ReactNode, useId, useMemo, useState } from "react";

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

// The row keeps the handle, the path, and the three controls on one line; the
// controls are compact symbols, so their meaning lives in the title and the
// accessible name instead of a label.
const pathRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "6px",
};

const pathInput: React.CSSProperties = {
  flex: 1,
  minWidth: "120px",
};

const rowButton: React.CSSProperties = {
  padding: 0,
  minWidth: "28px",
};

const dragHandle: React.CSSProperties = {
  cursor: "grab",
  background: "none",
  border: "none",
  padding: 0,
  color: "var(--dsw-alias-label-tertiary)",
};

// PathsList edits one ordered PATH-addition list: add (prepends), reorder by
// dragging the handle or with the move buttons, edit in place, and remove. It
// is controlled: every change reports the whole list through onChange.
export function PathsList(props: {
  t: (key: ContainerPluginKey) => string;
  entries: readonly PathEntry[];
  busy: boolean;
  onChange: (entries: PathEntry[]) => void;
}): ReactNode {
  const { t, entries, busy, onChange } = props;
  const [draft, setDraft] = useState("");
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const addId = useId();
  const move = (from: number, to: number): void => {
    if (from === to || to < 0 || to >= entries.length) return;
    const next = [...entries];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    onChange(next);
  };
  const add = (): void => {
    const path = draft.trim();
    if (path === "") return;
    onChange([{ id: nextPathId++, path }, ...entries]);
    setDraft("");
  };
  const update = (index: number, path: string): void => {
    onChange(entries.map((entry, at) => (at === index ? { ...entry, path } : entry)));
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      <Field label={t("addPath")} htmlFor={addId}>
        <div style={{ ...pathRow, gap: "8px" }}>
          <Input
            id={addId}
            value={draft}
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
            style={pathInput}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={busy || draft.trim() === ""}
            onClick={add}
          >
            {t("add")}
          </Button>
        </div>
      </Field>
      {entries.length === 0 ? (
        <p style={{ ...hint, margin: 0 }}>{t("noPaths")}</p>
      ) : (
        entries.map((entry, index) => (
          <div key={entry.id} style={pathRow}>
            <button
              type="button"
              title={t("dragToReorder")}
              aria-label={t("dragToReorder")}
              draggable={!busy}
              onDragStart={() => setDragIndex(index)}
              onDragOver={(event) => event.preventDefault()}
              onDrop={() => {
                if (dragIndex !== null) move(dragIndex, index);
                setDragIndex(null);
              }}
              style={dragHandle}
            >
              ≡
            </button>
            <Input
              value={entry.path}
              disabled={busy}
              onChange={(event) => update(index, event.target.value)}
              style={pathInput}
            />
            <Button
              variant="outline"
              size="sm"
              title={t("moveUp")}
              aria-label={t("moveUp")}
              disabled={busy || index === 0}
              onClick={() => move(index, index - 1)}
              style={rowButton}
            >
              ↑
            </Button>
            <Button
              variant="outline"
              size="sm"
              title={t("moveDown")}
              aria-label={t("moveDown")}
              disabled={busy || index === entries.length - 1}
              onClick={() => move(index, index + 1)}
              style={rowButton}
            >
              ↓
            </Button>
            <Button
              variant="outline"
              size="sm"
              title={t("remove")}
              aria-label={t("remove")}
              disabled={busy}
              onClick={() => onChange(entries.filter((_, at) => at !== index))}
              style={rowButton}
            >
              ×
            </Button>
          </div>
        ))
      )}
    </div>
  );
}

// PathsEditor shows the container's ordered PATH additions and edits them in a
// modal around PathsList. Apply sends the whole list at once.
export function PathsEditor(props: {
  t: (key: ContainerPluginKey) => string;
  paths: readonly string[];
  busy: boolean;
  enabled: boolean;
  onApply: (paths: string[]) => void;
}): ReactNode {
  const { t, paths, busy, enabled, onApply } = props;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<PathEntry[]>([]);
  // The read-only rows reuse the same ids as the editor, so two identical PATH
  // entries never collide on a React key.
  const shown = useMemo(() => pathEntries(paths), [paths]);
  const openEditor = (): void => {
    setDraft(pathEntries(paths));
    setOpen(true);
  };
  const apply = (): void => {
    onApply(draft.map((entry) => entry.path));
    setOpen(false);
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      {paths.length === 0 ? (
        <p style={{ ...hint, margin: 0 }}>{t("noPaths")}</p>
      ) : (
        shown.map((entry) => (
          <code
            key={entry.id}
            style={{
              ...greyId,
              fontSize: "13px",
              color: "var(--dsw-alias-label-primary)",
            }}
          >
            {entry.path}
          </code>
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
        onClose={() => setOpen(false)}
        title={t("pathsTitle")}
        closeLabel={t("cancel")}
        footer={
          <>
            <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
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
    </div>
  );
}
