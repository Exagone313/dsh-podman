// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import type {
  DirectoryEntry,
  DirectoryListing,
} from "@deepseek-ai/dsh-api-workspace-controller/types";
import { type DirectoryPickerFace } from "./directory-picker.js";
import { DIRECTORY_CLASS } from "./container-card-directory-styles.js";
import {
  confineToRoot,
  crumbLabel,
  rootCrumbs,
} from "../project-path.js";
import { type ContainerPluginKey } from "./locales.js";
import {
  Button,
  IconCheckOutline16,
  IconChevronRightOutline14,
  IconFolderClose16,
  IconFolderOpen16,
  Modal,
} from "@deepseek-ai/dsh-client-ui-primitives";
import { type ReactNode, useEffect, useRef, useState } from "react";

// One directory level as the browser renders it.
interface Level {
  entries: readonly DirectoryEntry[];
  truncated: boolean;
}

// How long a listing may take before the browser admits it is still loading.
const SLOW_SCAN_DELAY_MS = 300;

// The directory browser a project mount path is chosen with. Its layout mirrors
// dsh's own directory browser — a 680x500 dialog with two Miller columns,
// chevron breadcrumbs and 28px folder rows — and it lists through the harness's
// own host-side picker, never a container or the orchestrator. It is confined
// to the projects root: the breadcrumb trail starts there, the browser never
// navigates above it, and so it can only ever produce a path a project mount
// accepts.
export function DirectoryPickerModal(props: {
  t: (key: ContainerPluginKey) => string;
  open: boolean;
  root: string;
  start: string;
  picker: DirectoryPickerFace;
  onSelect: (path: string) => void;
  onClose: () => void;
}): ReactNode {
  const { t, open, root, start, picker, onSelect, onClose } = props;
  const [path, setPath] = useState(() => confineToRoot(root, start));
  const [level, setLevel] = useState<Level | undefined>(undefined);
  const [selected, setSelected] = useState<DirectoryEntry | null>(null);
  const [child, setChild] = useState<Level | undefined>(undefined);
  const [showHidden, setShowHidden] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [slow, setSlow] = useState(false);
  // The locale binding is read through a ref so a new function identity per
  // render cannot restart a listing.
  const tRef = useRef(t);
  tRef.current = t;
  const trailRef = useRef<HTMLElement | null>(null);

  // Every open starts at the field's value (clamped to the projects root).
  useEffect(() => {
    if (!open) return;
    setPath(confineToRoot(root, start));
    setSelected(null);
    setShowHidden(false);
  }, [open, root, start]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let cancelled = false;
    setBusy(true);
    setSlow(false);
    const timer = setTimeout(() => {
      if (!cancelled) setSlow(true);
    }, SLOW_SCAN_DELAY_MS);
    picker
      .list(path, controller.signal)
      .then((listing) => {
        if (cancelled) return;
        setLevel(toLevel(listing));
        setError("");
      })
      .catch((failure: unknown) => {
        if (cancelled) return;
        const code = (failure as { code?: unknown })?.code;
        setLevel(undefined);
        setError(
          code === "directory-picker/unavailable"
            ? tRef.current("browseUnavailable")
            : tRef.current("browseError"),
        );
      })
      .finally(() => {
        if (cancelled) return;
        clearTimeout(timer);
        setSlow(false);
        setBusy(false);
      });
    return () => {
      cancelled = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, path, picker]);

  useEffect(() => {
    if (!open || selected === null) {
      setChild(undefined);
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    setBusy(true);
    picker
      .list(selected.path, controller.signal)
      .then((listing) => {
        if (!cancelled) setChild(toLevel(listing));
      })
      .catch(() => {
        if (!cancelled) setChild(undefined);
      })
      .finally(() => {
        if (!cancelled) setBusy(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [open, selected, picker]);

  // Selecting previews the directory; the right pane lists its children.
  const select = (entry: DirectoryEntry): void => {
    setSelected(entry);
  };
  // A click in the preview pane descends one level, exactly like the built-in
  // browser: the previewed directory becomes the listed level and the clicked
  // entry becomes the new selection.
  const advance = (entry: DirectoryEntry): void => {
    if (selected !== null) setPath(selected.path);
    setSelected(entry);
  };
  const navigate = (target: string): void => {
    setPath(confineToRoot(root, target));
    setSelected(null);
  };

  // Keep the deepest crumb in view, like the built-in browser.
  useEffect(() => {
    const trail = trailRef.current;
    if (trail !== null) trail.scrollLeft = trail.scrollWidth;
  }, [path, open]);

  const crumbs = rootCrumbs(root, path);
  const visible = (entries: readonly DirectoryEntry[]): DirectoryEntry[] =>
    entries.filter((entry) => showHidden || !entry.hidden);
  const truncated = level?.truncated === true || child?.truncated === true;
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("browseTitle")}
      className={DIRECTORY_CLASS}
      headless
    >
      <div className="dsh-podman-directory-scope">
        <div className="dsh-podman-directory-header">
          <h2 className="dsh-podman-directory-title">{t("browseTitle")}</h2>
          <div className="dsh-podman-directory-crumbbar">
            <nav
              ref={trailRef}
              className="dsh-podman-directory-crumbs"
              aria-label={t("browseTitle")}
            >
              <span className="dsh-podman-directory-crumbseat">
                <button
                  type="button"
                  className="dsh-podman-directory-crumb"
                  disabled={busy}
                  onClick={() => navigate(root)}
                >
                  {crumbLabel(root)}
                </button>
              </span>
              {crumbs.map((crumb) => (
                <span key={crumb} className="dsh-podman-directory-crumbseat">
                  <IconChevronRightOutline14
                    size={12}
                    className="dsh-podman-directory-crumbchevron"
                  />
                  <button
                    type="button"
                    className="dsh-podman-directory-crumb"
                    disabled={busy}
                    onClick={() => navigate(crumb)}
                  >
                    {crumbLabel(crumb)}
                  </button>
                </span>
              ))}
            </nav>
          </div>
        </div>
        <div className="dsh-podman-directory-content">
          <div className="dsh-podman-directory-miller">
            <ul className="dsh-podman-directory-column">
              {(level?.entries ?? []).length === 0 ? null : (
                visible(level?.entries ?? []).map((entry) => (
                  <DirectoryRow
                    key={entry.path}
                    entry={entry}
                    selected={selected?.path === entry.path}
                    busy={busy}
                    onPick={select}
                  />
                ))
              )}
            </ul>
            {selected === null ? null : (
              <>
                <span className="dsh-podman-directory-divider" />
                <ul className="dsh-podman-directory-column">
                  {visible(child?.entries ?? []).map((entry) => (
                    <DirectoryRow
                      key={entry.path}
                      entry={entry}
                      selected={false}
                      busy={busy}
                      onPick={advance}
                    />
                  ))}
                </ul>
              </>
            )}
          </div>
          {error === "" ? null : (
            <p className="dsh-podman-directory-error" role="alert">
              {error}
            </p>
          )}
          {error === "" && truncated ? (
            <p className="dsh-podman-directory-status" role="status">
              {t("browseTruncated")}
            </p>
          ) : null}
          {slow ? (
            <span className="dsh-podman-directory-loading" role="status">
              {t("browseLoading")}
            </span>
          ) : null}
        </div>
        <div className="dsh-podman-directory-footer">
          <button
            type="button"
            className="dsh-podman-directory-toggle"
            aria-pressed={showHidden}
            disabled={busy}
            onClick={() => setShowHidden((previous) => !previous)}
          >
            {t("browseHidden")}
            {showHidden ? <IconCheckOutline16 size={14} /> : null}
          </button>
          <span className="dsh-podman-directory-gap" />
          <Button
            variant="outline"
            className="dsh-podman-directory-action"
            disabled={busy}
            onClick={onClose}
          >
            {t("cancel")}
          </Button>
          <Button
            variant="primary"
            className="dsh-podman-directory-action"
            disabled={busy || error !== ""}
            onClick={() => onSelect(selected?.path ?? path)}
          >
            {t("browseSelect")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function DirectoryRow(props: {
  entry: DirectoryEntry;
  selected: boolean;
  busy: boolean;
  onPick: (entry: DirectoryEntry) => void;
}): ReactNode {
  const { entry, selected, busy, onPick } = props;
  return (
    <li className="dsh-podman-directory-seat">
      <button
        type="button"
        className={
          selected
            ? "dsh-podman-directory-row dsh-podman-directory-row-selected"
            : "dsh-podman-directory-row"
        }
        aria-current={selected ? true : undefined}
        disabled={busy}
        onClick={() => onPick(entry)}
      >
        {selected ? (
          <IconFolderOpen16
            size={16}
            className="dsh-podman-directory-rowicon-selected"
          />
        ) : (
          <IconFolderClose16 size={16} className="dsh-podman-directory-rowicon" />
        )}
        <span className="dsh-podman-directory-rowname">{entry.name}</span>
        <IconChevronRightOutline14
          size={12}
          className="dsh-podman-directory-rowchevron"
        />
      </button>
    </li>
  );
}

function toLevel(listing: DirectoryListing): Level {
  return {
    entries: listing.entries ?? [],
    truncated: listing.truncated === true,
  };
}
