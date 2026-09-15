// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { type DirectoryPickerFace } from "./directory-picker.js";
import { type ContainerPluginKey } from "./locales.js";
import { hint } from "./container-card-styles.js";
import { Button, Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import { type ReactNode, useEffect, useRef, useState } from "react";

// The directory browser a project mount path is chosen with. It lists
// directories through the harness's own host-side picker and is confined to the
// projects root: the browser starts there, never navigates above it, and so can
// only ever produce a path a project mount accepts.
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
  const [path, setPath] = useState(start);
  const [entries, setEntries] = useState<readonly { name: string; path: string; hidden: boolean }[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  // The locale binding is read through a ref so a new function identity per
  // render cannot restart the listing.
  const tRef = useRef(t);
  tRef.current = t;

  // Every open starts where the field's value lives (or at the root).
  useEffect(() => {
    if (open) setPath(confine(root, start));
  }, [open, root, start]);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let cancelled = false;
    setLoading(true);
    picker
      .list(path, controller.signal)
      .then((listing) => {
        if (cancelled) return;
        setEntries(
          (listing.entries ?? []).map((entry) => ({
            name: entry.name,
            path: entry.path,
            hidden: entry.hidden === true,
          })),
        );
        setTruncated(listing.truncated === true);
        setError("");
      })
      .catch((failure: unknown) => {
        if (cancelled) return;
        const code = (failure as { code?: unknown })?.code;
        setEntries([]);
        setError(
          code === "directory-picker/unavailable"
            ? tRef.current("browseUnavailable")
            : tRef.current("browseError"),
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [open, path, picker]);

  const visible = entries.filter((entry) => showHidden || !entry.hidden);
  const crumbs = relativeSegments(root, path);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("browseTitle")}
      closeLabel={t("cancel")}
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onClose}>
            {t("cancel")}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={loading || error !== ""}
            onClick={() => onSelect(path)}
          >
            {t("browseSelect")}
          </Button>
        </>
      }
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "8px",
          minWidth: "420px",
        }}
      >
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "6px",
          }}
        >
          <Button
            variant="outline"
            size="sm"
            disabled={path === root}
            onClick={() => setPath(parentOf(root, path))}
          >
            {t("browseUp")}
          </Button>
          <button type="button" style={crumb} onClick={() => setPath(root)}>
            {root}
          </button>
          {crumbs.map((crumbPath) => (
            <span key={crumbPath} style={{ display: "contents" }}>
              <span style={{ color: "var(--dsw-alias-label-tertiary)" }}>/</span>
              <button
                type="button"
                style={crumb}
                onClick={() => setPath(crumbPath)}
              >
                {crumbPath.slice(crumbPath.lastIndexOf("/") + 1)}
              </button>
            </span>
          ))}
        </div>
        <label style={{ ...hint, display: "flex", alignItems: "center", gap: "6px" }}>
          <input
            type="checkbox"
            checked={showHidden}
            onChange={(event) => setShowHidden(event.target.checked)}
          />
          {t("browseHidden")}
        </label>
        {error === "" ? null : (
          <div style={errorBanner} role="alert">
            {error}
          </div>
        )}
        <div
          style={{
            maxHeight: "320px",
            minHeight: "120px",
            overflowY: "auto",
            border: "1px solid var(--dsw-alias-border-secondary)",
            borderRadius: "6px",
            padding: "4px",
          }}
        >
          {loading ? (
            <p style={{ ...hint, margin: "8px" }}>{t("browseLoading")}</p>
          ) : visible.length === 0 ? (
            <p style={{ ...hint, margin: "8px" }}>{t("browseEmpty")}</p>
          ) : (
            visible.map((entry) => (
              <button
                key={entry.path}
                type="button"
                style={entryRow}
                onClick={() => setPath(entry.path)}
              >
                {entry.name}
              </button>
            ))
          )}
        </div>
        {truncated ? (
          <p style={{ ...hint, margin: 0 }}>{t("browseTruncated")}</p>
        ) : null}
      </div>
    </Modal>
  );
}

// confine clamps a start directory to the projects root, so a stale or
// hand-edited field can never open the browser outside it.
export function confine(root: string, path: string): string {
  const normalizedRoot = stripTrailingSlash(root);
  const normalizedPath = stripTrailingSlash(path);
  if (normalizedRoot === "" || normalizedPath === normalizedRoot) {
    return normalizedRoot;
  }
  return normalizedPath.startsWith(`${normalizedRoot}/`)
    ? normalizedPath
    : normalizedRoot;
}

function parentOf(root: string, path: string): string {
  const index = path.lastIndexOf("/");
  if (index <= 0) return root;
  const parent = path.slice(0, index);
  return parent.length < root.length ? root : parent;
}

// relativeSegments returns the root-relative path segments of a path inside the
// root, so breadcrumbs never render a segment above it.
function relativeSegments(root: string, path: string): string[] {
  const prefix = `${stripTrailingSlash(root)}/`;
  if (!path.startsWith(prefix)) return [];
  const rest = path.slice(prefix.length);
  if (rest === "") return [];
  const segments: string[] = [];
  let accumulated = stripTrailingSlash(root);
  for (const segment of rest.split("/")) {
    if (segment === "") continue;
    accumulated = `${accumulated}/${segment}`;
    segments.push(accumulated);
  }
  return segments;
}

function stripTrailingSlash(value: string): string {
  return String(value ?? "").replace(/\/+$/, "");
}

const crumb: React.CSSProperties = {
  background: "none",
  border: "none",
  padding: 0,
  font: "inherit",
  cursor: "pointer",
  color: "var(--dsw-alias-label-primary)",
};

const entryRow: React.CSSProperties = {
  display: "block",
  width: "100%",
  textAlign: "left",
  background: "none",
  border: "none",
  padding: "6px 8px",
  font: "inherit",
  cursor: "pointer",
  color: "var(--dsw-alias-label-primary)",
  borderRadius: "4px",
};

const errorBanner: React.CSSProperties = {
  padding: "6px 8px",
  borderRadius: "6px",
  fontSize: "13px",
  color: "var(--dsw-alias-label-primary)",
  background: "var(--dsw-alias-bg-error, rgba(220, 38, 38, .12))",
};
