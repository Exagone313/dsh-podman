// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { hint } from "./container-card-styles.js";
import { type MountInput, type ProjectMountView } from "./container-card-controller.js";
import { type ContainerPluginKey } from "./locales.js";
import { Button, Input, Modal, type StateDotState } from "@deepseek-ai/dsh-client-ui-primitives";
import { type ReactNode, useId, useState } from "react";

export function CardChevron({ open }: { open: boolean }): ReactNode {
  return (
    <svg
      viewBox="0 0 14 14"
      width="14"
      height="14"
      aria-hidden="true"
      style={{
        flex: "none",
        color: "var(--dsw-alias-label-tertiary)",
        transition: "transform .16s",
        transform: open ? "rotate(180deg)" : undefined,
      }}
    >
      <path
        d="M3 5l4 4 4-4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function containerStateDot(status: string): StateDotState {
  return status === "running" ? "done" : "error";
}

export function ConfigField(props: {
  t: (key: ContainerPluginKey) => string;
  label: string;
  value: string;
  current: string;
  writable: boolean;
  onChange: (text: string) => void;
  onSave: () => void;
  onDiscard: () => void;
}): ReactNode {
  const { t, label, value, current, writable, onChange, onSave, onDiscard } = props;
  const id = useId();
  const dirty = value !== current;
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: "8px",
        padding: "8px 0",
      }}
    >
      <label
        htmlFor={id}
        style={{ fontSize: "13px", color: "var(--dsw-alias-label-secondary)", minWidth: "110px" }}
      >
        {label}
      </label>
      <Input
        id={id}
        value={value}
        disabled={!writable}
        onChange={(event) => onChange(event.target.value)}
        style={{ width: "200px" }}
      />
      <Button
        variant="outline"
        size="sm"
        disabled={!writable || !dirty}
        onClick={onSave}
      >
        {t("save")}
      </Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={!dirty}
        onClick={onDiscard}
      >
        {t("discard")}
      </Button>
    </div>
  );
}

export function Field(props: {
  label: string;
  htmlFor: string;
  children: ReactNode;
}): ReactNode {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
      <label
        htmlFor={props.htmlFor}
        style={{ fontSize: "13px", color: "var(--dsw-alias-label-secondary)" }}
      >
        {props.label}
      </label>
      {props.children}
    </div>
  );
}

export const namePattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;

export const imageIdPattern = /^[a-zA-Z0-9_][a-zA-Z0-9_.\-/:]{0,127}$/;

export const sanitizeName = (raw: string): string => raw.replace(/[^a-zA-Z0-9_.-]/g, "");

export const sanitizeImageId = (raw: string): string => raw.replace(/[^a-zA-Z0-9_.\-/:]/g, "");

export const mountKindShort = (kind: string): string => {
  if (kind === "MOUNT_KIND_TMPFS") return "tmpfs";
  if (kind === "MOUNT_KIND_VOLUME") return "volume";
  if (kind === "MOUNT_KIND_SECRET") return "secret";
  return "project";
};

export const mountModeShort = (mode: string): string =>
  mode === "MOUNT_MODE_READ_ONLY" ? "read_only" : "read_write";

export const mountViewToInput = (mount: ProjectMountView): MountInput => ({
  kind: mountKindShort(mount.kind),
  project: mount.projectName,
  destination: mount.destination,
  mode: mountModeShort(mount.mode),
  volume: mount.volume,
  secret: mount.secret,
});

export const mountLabel = (
  t: (key: ContainerPluginKey) => string,
  mount: MountInput,
  withMode = true,
): string => {
  if (mount.kind === "tmpfs") {
    return `${t("mountTmpfs")}${
      mount.destination !== "" ? ` ${t("mountAt")} ${mount.destination}` : ""
    }`;
  }
  if (mount.kind === "volume") {
    return `volume ${mount.volume}${mount.destination !== "" ? ` → ${mount.destination}` : ""}`;
  }
  if (mount.kind === "secret") {
    return `secret ${mount.secret}${mount.destination !== "" ? ` → ${mount.destination}` : ""}`;
  }
  const mode = withMode
    ? ` ${t(mount.mode === "read_only" ? "mountReadOnlySuffix" : "mountReadWriteSuffix")}`
    : "";
  return `${mount.project}${mount.destination !== "" ? ` → ${mount.destination}` : ""}${mode}`;
};

// Adding a mount defaults to read-only, so granting write access is always a
// deliberate choice. tmpfs is scratch space and must be writable.
export const emptyMount = (kind = "project"): MountInput => ({
  kind,
  project: "",
  destination: "",
  mode: kind === "tmpfs" ? "read_write" : "read_only",
  volume: "",
  secret: "",
});

export function ConfirmButton(props: {
  t: (key: ContainerPluginKey) => string;
  label: string;
  title: string;
  description: string;
  disabled?: boolean;
  ariaLabel?: string;
  onConfirm: () => void;
}): ReactNode {
  const { t, label, title, description, disabled, ariaLabel, onConfirm } = props;
  const [open, setOpen] = useState(false);
  const confirm = (): void => {
    setOpen(false);
    onConfirm();
  };
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={disabled}
        aria-label={ariaLabel}
        onClick={() => setOpen(true)}
      >
        {label}
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={title}
        closeLabel={t("cancel")}
        footer={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setOpen(false)}
            >
              {t("cancel")}
            </Button>
            <Button variant="primary" size="sm" onClick={confirm}>
              {t("confirm")}
            </Button>
          </>
        }
      >
        <p style={{ ...hint, margin: 0 }}>{description}</p>
      </Modal>
    </>
  );
}

export function Chip(props: {
  t: (key: ContainerPluginKey) => string;
  label: string;
  disabled?: boolean;
  onRemove?: () => void;
}): ReactNode {
  const { t, label, disabled, onRemove } = props;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "2px",
        height: "24px",
        padding: onRemove === undefined ? "0 8px" : "0 4px 0 8px",
        borderRadius: "999px",
        border: "1px solid var(--dsw-alias-border-l2)",
        background: "var(--dsw-alias-bg-layer-3)",
        fontSize: "12px",
        fontFamily: "var(--dsw-alias-font-mono, ui-monospace, monospace)",
        color: "var(--dsw-alias-label-primary)",
      }}
    >
      {label}
      {onRemove === undefined ? null : (
        <Button
          variant="ghost"
          size="sm"
          aria-label={`${t("removeTag")} ${label}`}
          disabled={disabled}
          onClick={onRemove}
          style={{
            padding: 0,
            minWidth: "18px",
            height: "18px",
            lineHeight: 1,
            fontSize: "13px",
            color: "var(--dsw-alias-label-tertiary)",
          }}
        >
          ×
        </Button>
      )}
    </span>
  );
}

export function TagInput(props: {
  t: (key: ContainerPluginKey) => string;
  value: readonly string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
}): ReactNode {
  const { t, value, onChange, placeholder, disabled, id } = props;
  const [draft, setDraft] = useState("");
  const commit = (raw: string): void => {
    const tag = raw.trim();
    if (tag === "" || value.includes(tag)) return;
    onChange([...value, tag]);
  };
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: "6px",
      }}
    >
      {value.map((tag) => (
        <Chip
          key={tag}
          t={t}
          label={tag}
          disabled={disabled}
          onRemove={() => onChange(value.filter((item) => item !== tag))}
        />
      ))}
      <Input
        id={id}
        value={draft}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === " " || event.key === "," || event.key === "Enter") {
            if (event.key === " " || event.key === ",") event.preventDefault();
            commit(draft);
            setDraft("");
          } else if (event.key === "Backspace" && draft === "") {
            const last = value[value.length - 1];
            if (last !== undefined) onChange(value.slice(0, -1));
          }
        }}
        onPaste={(event) => {
          const text = event.clipboardData.getData("text");
          if (text === "") return;
          event.preventDefault();
          const tokens = text.split(/[\s,]+/);
          const next = [...value];
          for (const token of tokens) {
            const tag = token.trim();
            if (tag !== "" && !next.includes(tag)) next.push(tag);
          }
          if (next.length !== value.length) onChange(next);
        }}
        style={{ flex: 1, minWidth: "160px" }}
      />
    </div>
  );
}
