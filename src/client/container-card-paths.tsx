// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { Field } from "./container-card-shared.js";
import { greyId, hint } from "./container-card-styles.js";
import { type ContainerPluginKey } from "./locales.js";
import { Button, Input, Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import { type ReactNode, useId, useRef, useState } from "react";

interface PathEntry {
  id: number;
  path: string;
}

// PathsEditor shows the container's ordered PATH additions and edits them in a
// modal: add (prepends), reorder by dragging the handle or with the move
// buttons, edit in place, and remove. Apply sends the whole list at once.
export function PathsEditor(props: {
  t: (key: ContainerPluginKey) => string;
  paths: readonly string[];
  busy: boolean;
  enabled: boolean;
  onApply: (paths: string[]) => void;
}): ReactNode {
  const { t, paths, busy, enabled, onApply } = props;
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<PathEntry[]>([]);
  const [draft, setDraft] = useState("");
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const nextId = useRef(0);
  const addId = useId();
  const openEditor = (): void => {
    nextId.current = 0;
    setEntries(paths.map((path) => ({ id: nextId.current++, path })));
    setDraft("");
    setDragIndex(null);
    setOpen(true);
  };
  const move = (from: number, to: number): void => {
    if (from === to || to < 0 || to >= entries.length) return;
    setEntries((prev) => {
      const next = [...prev];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
  };
  const add = (): void => {
    const path = draft.trim();
    if (path === "") return;
    setEntries((prev) => [{ id: nextId.current++, path }, ...prev]);
    setDraft("");
  };
  const apply = (): void => {
    onApply(entries.map((entry) => entry.path));
    setOpen(false);
  };
  const update = (index: number, path: string): void => {
    setEntries((prev) =>
      prev.map((entry, at) => (at === index ? { ...entry, path } : entry)),
    );
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      {paths.length === 0 ? (
        <p style={{ ...hint, margin: 0 }}>{t("noPaths")}</p>
      ) : (
        paths.map((path) => (
          <code
            key={path}
            style={{
              ...greyId,
              fontSize: "13px",
              color: "var(--dsw-alias-label-primary)",
            }}
          >
            {path}
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
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          <Field label={t("addPath")} htmlFor={addId}>
            <div style={{ display: "flex", gap: "8px" }}>
              <Input
                id={addId}
                value={draft}
                disabled={busy}
                onChange={(event) => setDraft(event.target.value)}
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
              <div
                key={entry.id}
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "center",
                  gap: "8px",
                }}
              >
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
                  style={{
                    cursor: "grab",
                    background: "none",
                    border: "none",
                    padding: 0,
                    color: "var(--dsw-alias-label-tertiary)",
                  }}
                >
                  ≡
                </button>
                <Input
                  value={entry.path}
                  disabled={busy}
                  onChange={(event) => update(index, event.target.value)}
                />
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || index === 0}
                  onClick={() => move(index, index - 1)}
                >
                  {t("moveUp")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || index === entries.length - 1}
                  onClick={() => move(index, index + 1)}
                >
                  {t("moveDown")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    setEntries((prev) => prev.filter((_, at) => at !== index))
                  }
                >
                  {t("remove")}
                </Button>
              </div>
            ))
          )}
        </div>
      </Modal>
    </div>
  );
}
