// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { useEffect, useId, useState, type ReactNode } from "react";
import {
  Button,
  DisclosureRow,
  Input,
  Modal,
  Pill,
  StateDot,
  type StateDotState,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type {
  InjectFace,
  PropsLocale,
  PropsRuntime,
} from "@deepseek-ai/dsh-client-ui-slots";
import type {
  ContainerCardFace,
  ContainerCreateConfig,
  ContainerView,
  ImageView,
  MountInput,
  ProjectMountView,
  WorkspaceView,
} from "./container-card-controller.js";
import { NS, type ContainerPluginKey } from "./locales.js";

export type ContainerCardProps = PropsRuntime<"settings.plugin.item"> &
  PropsLocale<typeof NS> &
  InjectFace<ContainerCardFace>;

const cardStyle: React.CSSProperties = {
  listStyle: "none",
  border: "1px solid var(--dsw-alias-border-l2)",
  borderRadius: "12px",
  background: "var(--dsw-alias-bg-layer-3)",
  transition: "border-color .16s, background .16s",
};
const cardOpenStyle: React.CSSProperties = {
  background: "var(--dsw-alias-bg-layer-2)",
  borderColor: "var(--dsw-alias-label-dimmed)",
};
const cardHoverStyle: React.CSSProperties = {
  borderColor: "var(--dsw-alias-label-dimmed)",
};
const cardHeaderStyle: React.CSSProperties = {
  width: "100%",
  appearance: "none",
  border: 0,
  background: "none",
  font: "inherit",
  color: "inherit",
  textAlign: "left",
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  gap: "12px",
  padding: "14px 16px",
  borderRadius: "12px",
};
const cardHeadTextStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  gap: "4px",
};
const cardNameStyle: React.CSSProperties = {
  fontSize: "15px",
  fontWeight: 600,
  lineHeight: 1.4,
  color: "var(--dsw-alias-label-primary)",
};
const cardDescriptionStyle: React.CSSProperties = {
  fontSize: "13px",
  lineHeight: 1.5,
  color: "var(--dsw-alias-label-tertiary)",
};
const cardBodyStyle: React.CSSProperties = {
  borderTop: "1px solid var(--dsw-alias-border-l2)",
  margin: "0 16px",
  paddingBottom: "8px",
};
const sectionTitle: React.CSSProperties = {
  fontWeight: 600,
  margin: "16px 0 8px",
  fontSize: "13px",
  color: "var(--dsw-alias-label-secondary)",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};
const banner: React.CSSProperties = {
  padding: "6px 10px",
  borderRadius: "6px",
  border: "1px solid rgba(210,153,34,0.6)",
  margin: "12px 0",
  fontSize: "13px",
};
const greyId: React.CSSProperties = {
  color: "var(--dsw-alias-label-tertiary)",
  fontSize: "12px",
  fontFamily: "var(--dsw-alias-font-mono, ui-monospace, monospace)",
};
const hint: React.CSSProperties = {
  fontSize: "13px",
  color: "var(--dsw-alias-label-tertiary)",
  margin: "8px 0",
};
const wsBody: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "8px",
  padding: "10px 0 12px",
};
const containerRow: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "8px",
  padding: "10px 12px",
  border: "1px solid var(--dsw-alias-border-l2)",
  borderRadius: "10px",
  background: "var(--dsw-alias-bg-layer-3)",
};
const containerHeader: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "8px",
};
const actions: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "8px",
  alignItems: "center",
};
const footerRow: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  paddingTop: "12px",
  marginTop: "12px",
  borderTop: "1px solid var(--dsw-alias-border-l2)",
};
const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "13px",
};
const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "6px 10px",
  borderBottom: "1px solid var(--dsw-alias-border-l2)",
  color: "var(--dsw-alias-label-secondary)",
  fontWeight: 600,
  whiteSpace: "nowrap",
};
const tdStyle: React.CSSProperties = {
  padding: "6px 10px",
  borderBottom: "1px solid var(--dsw-alias-border-l2)",
  color: "var(--dsw-alias-label-primary)",
  verticalAlign: "top",
};
const imageSelect: React.CSSProperties = {
  appearance: "none",
  padding: "4px 8px",
  borderRadius: "8px",
  border: "1px solid var(--dsw-alias-border-l2)",
  background: "var(--dsw-alias-bg-layer-3)",
  color: "inherit",
  fontSize: "12px",
  maxWidth: "160px",
};

function CardChevron({ open }: { open: boolean }): ReactNode {
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

function containerStateDot(status: string): StateDotState {
  return status === "running" ? "done" : "error";
}

function ConfigField(props: {
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

function Field(props: {
  label: string;
  htmlFor: string;
  children: ReactNode;
}): ReactNode {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
      <label htmlFor={props.htmlFor} style={{ fontSize: "13px", color: "var(--dsw-alias-label-secondary)" }}>
        {props.label}
      </label>
      {props.children}
    </div>
  );
}

const namePattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;
const imageIdPattern = /^[a-zA-Z0-9_][a-zA-Z0-9_.\-/:]{0,127}$/;
const sanitizeName = (raw: string): string =>
  raw.replace(/[^a-zA-Z0-9_.-]/g, "");
const sanitizeImageId = (raw: string): string =>
  raw.replace(/[^a-zA-Z0-9_.\-/:]/g, "");

const mountKindShort = (kind: string): string => {
  if (kind === "MOUNT_KIND_TMPFS") return "tmpfs";
  if (kind === "MOUNT_KIND_VOLUME") return "volume";
  if (kind === "MOUNT_KIND_SECRET") return "secret";
  return "project";
};
const mountModeShort = (mode: string): string =>
  mode === "MOUNT_MODE_READ_ONLY" ? "read_only" : "read_write";
const mountViewToInput = (mount: ProjectMountView): MountInput => ({
  kind: mountKindShort(mount.kind),
  project: mount.projectName,
  path: mount.path,
  destination: mount.destination,
  mode: mountModeShort(mount.mode),
  volume: mount.volume,
  secret: mount.secret,
});
const mountLabel = (
  t: (key: ContainerPluginKey) => string,
  mount: MountInput,
): string => {
  if (mount.kind === "tmpfs") {
    return `tmpfs${mount.destination !== "" ? ` at ${mount.destination}` : ""}`;
  }
  if (mount.kind === "volume") {
    return `volume ${mount.volume}${mount.destination !== "" ? ` → ${mount.destination}` : ""}`;
  }
  if (mount.kind === "secret") {
    return `secret ${mount.secret}${mount.destination !== "" ? ` → ${mount.destination}` : ""}`;
  }
  return `${mount.project}${mount.path !== "" ? `/${mount.path}` : ""}${mount.destination !== "" ? ` → ${mount.destination}` : ""}${mount.mode === "read_only" ? " (ro)" : " (rw)"}`;
};
const emptyMount = (): MountInput => ({
  kind: "project",
  project: "",
  path: "",
  destination: "",
  mode: "read_write",
  volume: "",
  secret: "",
});

function ConfirmButton(props: {
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

function Chip(props: {
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
          aria-label={t("removeTag")}
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

function TagInput(props: {
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

function EnvEditor(props: {
  t: (key: ContainerPluginKey) => string;
  env: Record<string, string>;
  busy: boolean;
  onChange: (env: Record<string, string>) => void;
}): ReactNode {
  const { t, env, busy, onChange } = props;
  const entries = Object.entries(env);
  const updateKey = (oldKey: string, key: string, value: string): void => {
    const next: Record<string, string> = {};
    for (const [k, v] of entries) {
      if (k !== oldKey) next[k] = v;
    }
    next[key] = value;
    onChange(next);
  };
  const updateValue = (key: string, value: string): void => {
    onChange({ ...env, [key]: value });
  };
  const remove = (key: string): void => {
    const next: Record<string, string> = { ...env };
    delete next[key];
    onChange(next);
  };
  const add = (): void => {
    onChange({ ...env, "": "" });
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      {entries.map(([key, value]) => (
        <div
          key={key}
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "8px",
          }}
        >
          <Input
            value={key}
            disabled={busy}
            placeholder={t("envKey")}
            aria-label={t("envKey")}
            onChange={(event) => updateKey(key, event.target.value, value)}
            style={{ width: "160px" }}
          />
          <Input
            value={value}
            disabled={busy}
            placeholder={t("envValue")}
            aria-label={t("envValue")}
            onChange={(event) => updateValue(key, event.target.value)}
            style={{ width: "200px" }}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => remove(key)}
          >
            {t("removeEnv")}
          </Button>
        </div>
      ))}
      <div>
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={add}
        >
          {t("addEnv")}
        </Button>
      </div>
    </div>
  );
}

function MountsEditor(props: {
  t: (key: ContainerPluginKey) => string;
  mounts: readonly MountInput[];
  volumes: readonly { name: string }[];
  secrets: readonly { name: string }[];
  busy: boolean;
  enabled: boolean;
  confirmRemove?: boolean;
  onAdd: (mount: MountInput) => void;
  onRemove: (mount: MountInput) => void;
}): ReactNode {
  const {
    t,
    mounts,
    volumes,
    secrets,
    busy,
    enabled,
    confirmRemove,
    onAdd,
    onRemove,
  } = props;
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<MountInput>(emptyMount());
  const mountKindId = useId();
  const mountProjectId = useId();
  const mountPathId = useId();
  const mountDestinationId = useId();
  const mountModeId = useId();
  const mountVolumeId = useId();
  const mountSecretId = useId();
  const updateDraft = (patch: Partial<MountInput>): void => {
    setDraft((prev) => ({ ...prev, ...patch }));
  };
  const canAdd =
    draft.kind === "project"
      ? draft.project.trim() !== ""
      : draft.kind === "volume"
        ? draft.volume !== ""
        : draft.kind === "secret"
          ? draft.secret !== ""
          : true;
  const openAdd = (): void => {
    setDraft(emptyMount());
    setAdding(true);
  };
  const submit = (): void => {
    if (!canAdd) return;
    onAdd(draft);
    setAdding(false);
  };
  const kindField =
    draft.kind === "tmpfs" ? (
      <Field label={t("mountDestination")} htmlFor={mountDestinationId}>
        <Input
          id={mountDestinationId}
          value={draft.destination}
          disabled={busy}
          onChange={(event) => updateDraft({ destination: event.target.value })}
        />
      </Field>
    ) : draft.kind === "volume" ? (
      <>
        <Field label={t("mountVolume")} htmlFor={mountVolumeId}>
          <select
            id={mountVolumeId}
            style={imageSelect}
            value={draft.volume}
            disabled={busy}
            onChange={(event) => updateDraft({ volume: event.target.value })}
          >
            {volumes.length === 0 ? (
              <option value="">{t("none")}</option>
            ) : null}
            {volumes.map((volume) => (
              <option key={volume.name} value={volume.name}>
                {volume.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("mountDestination")} htmlFor={mountDestinationId}>
          <Input
            id={mountDestinationId}
            value={draft.destination}
            disabled={busy}
            onChange={(event) => updateDraft({ destination: event.target.value })}
          />
        </Field>
        <Field label={t("mountMode")} htmlFor={mountModeId}>
          <select
            id={mountModeId}
            style={imageSelect}
            value={draft.mode}
            disabled={busy}
            onChange={(event) => updateDraft({ mode: event.target.value })}
          >
            <option value="read_only">{t("readOnly")}</option>
            <option value="read_write">{t("readWrite")}</option>
          </select>
        </Field>
      </>
    ) : draft.kind === "secret" ? (
      <>
        <Field label={t("mountSecret")} htmlFor={mountSecretId}>
          <select
            id={mountSecretId}
            style={imageSelect}
            value={draft.secret}
            disabled={busy}
            onChange={(event) => updateDraft({ secret: event.target.value })}
          >
            {secrets.length === 0 ? (
              <option value="">{t("none")}</option>
            ) : null}
            {secrets.map((secret) => (
              <option key={secret.name} value={secret.name}>
                {secret.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("mountDestination")} htmlFor={mountDestinationId}>
          <Input
            id={mountDestinationId}
            value={draft.destination}
            disabled={busy}
            onChange={(event) => updateDraft({ destination: event.target.value })}
          />
        </Field>
      </>
    ) : (
      <>
        <Field label={t("mountProject")} htmlFor={mountProjectId}>
          <Input
            id={mountProjectId}
            value={draft.project}
            disabled={busy}
            onChange={(event) => updateDraft({ project: event.target.value })}
          />
        </Field>
        <Field label={t("mountPath")} htmlFor={mountPathId}>
          <Input
            id={mountPathId}
            value={draft.path}
            disabled={busy}
            onChange={(event) => updateDraft({ path: event.target.value })}
          />
        </Field>
        <Field label={t("mountDestination")} htmlFor={mountDestinationId}>
          <Input
            id={mountDestinationId}
            value={draft.destination}
            disabled={busy}
            onChange={(event) => updateDraft({ destination: event.target.value })}
          />
        </Field>
        <Field label={t("mountMode")} htmlFor={mountModeId}>
          <select
            id={mountModeId}
            style={imageSelect}
            value={draft.mode}
            disabled={busy}
            onChange={(event) => updateDraft({ mode: event.target.value })}
          >
            <option value="read_only">{t("readOnly")}</option>
            <option value="read_write">{t("readWrite")}</option>
          </select>
        </Field>
      </>
    );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      {mounts.map((mount) => (
        <div
          key={mountLabel(t, mount)}
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "8px",
          }}
        >
          <code
            style={{
              ...greyId,
              flex: 1,
              fontSize: "13px",
              color: "var(--dsw-alias-label-primary)",
            }}
          >
            {mountLabel(t, mount)}
          </code>
          {confirmRemove ? (
            <ConfirmButton
              t={t}
              label={t("remove")}
              title={t("confirmTitle")}
              description={t("confirmRemoveMount")}
              disabled={!enabled}
              onConfirm={() => onRemove(mount)}
            />
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={!enabled}
              onClick={() => onRemove(mount)}
            >
              {t("remove")}
            </Button>
          )}
        </div>
      ))}
      <div>
        <Button
          variant="outline"
          size="sm"
          disabled={!enabled}
          onClick={openAdd}
        >
          {t("addMount")}
        </Button>
      </div>
      <Modal
        open={adding}
        onClose={() => setAdding(false)}
        title={t("addMount")}
        closeLabel={t("cancel")}
        footer={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAdding(false)}
            >
              {t("cancel")}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={busy || !canAdd}
              onClick={submit}
            >
              {t("addMount")}
            </Button>
          </>
        }
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "12px",
          }}
        >
          <Field label={t("mountKind")} htmlFor={mountKindId}>
            <select
              id={mountKindId}
              style={imageSelect}
              value={draft.kind}
              disabled={busy}
              onChange={(event) =>
                setDraft({ ...emptyMount(), kind: event.target.value })
              }
            >
              <option value="project">{t("mountProject")}</option>
              <option value="tmpfs">tmpfs</option>
              <option value="volume">{t("mountVolume")}</option>
              <option value="secret">{t("mountSecret")}</option>
            </select>
          </Field>
          {kindField}
        </div>
      </Modal>
    </div>
  );
}

function ContainerRow(props: {
  t: (key: ContainerPluginKey) => string;
  container: ContainerView;
  images: readonly { imageId: string }[];
  volumes: readonly { name: string }[];
  secrets: readonly { name: string }[];
  busy: boolean;
  onRemove: (workspace: string) => void;
  onRecreate: (
    workspace: string,
    image: string,
    env?: Record<string, string>,
  ) => void;
  onAddContainerMount: (workspace: string, container: string, mount: MountInput) => void;
  onRemoveContainerMount: (workspace: string, container: string, mount: MountInput) => void;
  onAddContainerSecret: (workspace: string, envVar: string, secret: string) => void;
  onRemoveContainerSecret: (workspace: string, envVar: string) => void;
}): ReactNode {
  const {
    t,
    container,
    images,
    volumes,
    secrets,
    busy,
    onRemove,
    onRecreate,
    onAddContainerMount,
    onRemoveContainerMount,
    onAddContainerSecret,
    onRemoveContainerSecret,
  } = props;
  const [selected, setSelected] = useState(container.imageId);
  const [env, setEnv] = useState<Record<string, string>>(container.env);
  const [envOpen, setEnvOpen] = useState(false);
  const [mountOpen, setMountOpen] = useState(false);
  const [secretOpen, setSecretOpen] = useState(false);
  const [attachSecret, setAttachSecret] = useState("");
  const [attachVar, setAttachVar] = useState("");
  const enabled = container.workspaceSlug !== "" && !busy;
  const projects = container.mounts
    .map((mount) => mount.projectName)
    .join(", ");
  const envEntries = Object.entries(container.env);
  const secretEntries = Object.entries(container.secretEnv);
  const attach = (): void => {
    const envVar = attachVar.trim();
    if (envVar === "" || attachSecret === "") return;
    onAddContainerSecret(container.workspaceSlug, envVar, attachSecret);
    setAttachVar("");
  };
  return (
    <div style={containerRow}>
      <div style={containerHeader}>
        <strong style={{ color: "var(--dsw-alias-label-primary)" }}>
          {container.containerName}
        </strong>
        <Pill>{container.status}</Pill>
      </div>
      <table style={tableStyle}>
        <tbody>
          <tr>
            <th style={thStyle} scope="row">{t("image")}</th>
            <td style={tdStyle}>{container.imageId}</td>
          </tr>
          <tr>
            <th style={thStyle} scope="row">{t("created")}</th>
            <td style={tdStyle}>{container.createdAt}</td>
          </tr>
          {projects !== "" ? (
            <tr>
              <th style={thStyle} scope="row">{t("projects")}</th>
              <td style={tdStyle}>{projects}</td>
            </tr>
          ) : null}
          {envEntries.length > 0 ? (
            <tr>
              <th style={thStyle} scope="row">{t("env")}</th>
              <td style={tdStyle}>
                {envEntries.map(([key]) => key).join(", ")}
              </td>
            </tr>
          ) : null}
          {secretEntries.length > 0 ? (
            <tr>
              <th style={thStyle} scope="row">{t("secretEnv")}</th>
              <td style={tdStyle}>
                {secretEntries
                  .map(([envVar, secretName]) => `${envVar}=${secretName}`)
                  .join(", ")}
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
      <div style={actions}>
        <ConfirmButton
          t={t}
          label={t("remove")}
          title={t("confirmTitle")}
          description={t("confirmRemoveContainer")}
          disabled={!enabled}
          onConfirm={() => onRemove(container.workspaceSlug)}
        />
        <ConfirmButton
          t={t}
          label={t("recreate")}
          title={t("confirmTitle")}
          description={t("confirmRecreate")}
          disabled={!enabled}
          onConfirm={() => onRecreate(container.workspaceSlug, "", env)}
        />
        <select
          style={imageSelect}
          value={selected}
          disabled={!enabled}
          onChange={(event) => setSelected(event.target.value)}
          aria-label={t("recreateWithImage")}
        >
          {container.imageId === "" ? (
            <option value="">{t("none")}</option>
          ) : null}
          {images.map((image) => (
            <option key={image.imageId} value={image.imageId}>
              {image.imageId}
            </option>
          ))}
        </select>
        <ConfirmButton
          t={t}
          label={t("recreateWithImage")}
          title={t("confirmTitle")}
          description={t("confirmRecreate")}
          disabled={!enabled || selected === ""}
          onConfirm={() => onRecreate(container.workspaceSlug, selected, env)}
        />
      </div>
      <DisclosureRow
        icon={<span />}
        title={t("envTitle")}
        open={envOpen}
        expandable
        onToggle={() => setEnvOpen(!envOpen)}
      >
        <div style={wsBody}>
          <EnvEditor t={t} env={env} busy={busy} onChange={setEnv} />
        </div>
      </DisclosureRow>
      <DisclosureRow
        icon={<span />}
        title={t("mountsTitle")}
        open={mountOpen}
        expandable
        onToggle={() => setMountOpen(!mountOpen)}
      >
        <div style={wsBody}>
          <MountsEditor
            t={t}
            mounts={container.mounts.map(mountViewToInput)}
            volumes={volumes}
            secrets={secrets}
            busy={busy}
            enabled={enabled}
            confirmRemove
            onRemove={(mount) =>
              onRemoveContainerMount(
                container.workspaceSlug,
                container.containerName,
                mount,
              )
            }
            onAdd={(mount) =>
              onAddContainerMount(
                container.workspaceSlug,
                container.containerName,
                mount,
              )
            }
          />
        </div>
      </DisclosureRow>
      <DisclosureRow
        icon={<span />}
        title={t("containerSecretsTitle")}
        open={secretOpen}
        expandable
        onToggle={() => setSecretOpen(!secretOpen)}
      >
        <div style={wsBody}>
          {secretEntries.map(([envVar, secretName]) => (
            <div
              key={envVar}
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                gap: "8px",
              }}
            >
              <code
                style={{
                  ...greyId,
                  flex: 1,
                  fontSize: "13px",
                  color: "var(--dsw-alias-label-primary)",
                }}
              >
                {envVar}={secretName}
              </code>
              <ConfirmButton
                t={t}
                label={t("detachSecret")}
                title={t("confirmTitle")}
                description={t("confirmDetachSecret")}
                disabled={busy}
                onConfirm={() =>
                  onRemoveContainerSecret(container.workspaceSlug, envVar)
                }
              />
            </div>
          ))}
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: "8px",
              paddingTop: "8px",
            }}
          >
            <select
              style={imageSelect}
              value={attachSecret}
              disabled={!enabled}
              onChange={(event) => setAttachSecret(event.target.value)}
              aria-label={t("attachSecret")}
            >
              {secrets.length === 0 ? (
                <option value="">{t("none")}</option>
              ) : null}
              {secrets.map((secret) => (
                <option key={secret.name} value={secret.name}>
                  {secret.name}
                </option>
              ))}
            </select>
            <Input
              value={attachVar}
              disabled={!enabled}
              placeholder={t("secretEnvName")}
              onChange={(event) => setAttachVar(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") attach();
              }}
              style={{ width: "200px" }}
            />
            <Button
              variant="outline"
              size="sm"
              disabled={!enabled || attachVar.trim() === "" || attachSecret === ""}
              onClick={attach}
            >
              {t("attachSecret")}
            </Button>
          </div>
        </div>
      </DisclosureRow>
    </div>
  );
}

function CreateContainerModal(props: {
  t: (key: ContainerPluginKey) => string;
  workspace: WorkspaceView;
  images: readonly ImageView[];
  volumes: readonly { name: string }[];
  secrets: readonly { name: string }[];
  busy: boolean;
  defaultImage: string;
  named: boolean;
  existing: readonly string[];
  open: boolean;
  onClose: () => void;
  onCreate: (container: string, config: ContainerCreateConfig) => void;
}): ReactNode {
  const {
    t,
    workspace,
    images,
    volumes,
    secrets,
    busy,
    defaultImage,
    named,
    existing,
    open,
    onClose,
    onCreate,
  } = props;
  const [image, setImage] = useState(workspace.imageId || defaultImage);
  const [name, setName] = useState("");
  const [env, setEnv] = useState<Record<string, string>>({});
  const [mounts, setMounts] = useState<MountInput[]>(() => [
    {
      kind: "project",
      project: workspace.projectName,
      path: "",
      destination: "",
      mode: "read_write",
      volume: "",
      secret: "",
    },
  ]);
  const [secretEnv, setSecretEnv] = useState<Record<string, string>>({});
  const [attachSecret, setAttachSecret] = useState("");
  const [attachVar, setAttachVar] = useState("");
  const imageLabel = useId();
  const nameLabel = useId();
  useEffect(() => {
    if (!open) return;
    setImage(workspace.imageId || defaultImage);
    setName("");
    setEnv({});
    setMounts([
      {
        kind: "project",
        project: workspace.projectName,
        path: "",
        destination: "",
        mode: "read_write",
        volume: "",
        secret: "",
      },
    ]);
    setSecretEnv({});
    setAttachSecret("");
    setAttachVar("");
  }, [open, workspace, defaultImage]);
  const baseImages = images.filter((image) => image.isBase);
  const customImages = images.filter((image) => !image.isBase);
  const candidates = [
    ...baseImages.map((image) => image.imageId),
    ...customImages.map((image) => image.imageId),
  ];
  const nameTaken = existing.includes(name);
  const validName = namePattern.test(name) && name !== "default" && !nameTaken;
  const canCreate = !named || validName;
  const submit = (): void => {
    if (!canCreate) return;
    onCreate(named ? name : "", {
      image,
      env,
      mounts,
      secretEnv,
    });
  };
  const attach = (): void => {
    const envVar = attachVar.trim();
    if (envVar === "" || attachSecret === "") return;
    setSecretEnv({ ...secretEnv, [envVar]: attachSecret });
    setAttachVar("");
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("createContainerTitle")}
      closeLabel={t("cancel")}
      footer={
        <>
          <Button
            variant="outline"
            size="sm"
            onClick={onClose}
          >
            {t("cancel")}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!canCreate}
            onClick={submit}
          >
            {t("createContainer")}
          </Button>
        </>
      }
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "12px",
        }}
      >
        <Field label={t("image")} htmlFor={imageLabel}>
          <select
            id={imageLabel}
            style={imageSelect}
            value={image}
            disabled={busy}
            onChange={(event) => setImage(event.target.value)}
          >
            {candidates.length === 0 ? (
              <option value="">{t("none")}</option>
            ) : null}
            {candidates.map((imageId) => (
              <option key={imageId} value={imageId}>
                {imageId}
              </option>
            ))}
          </select>
        </Field>
        {named ? (
          <Field label={t("containerName")} htmlFor={nameLabel}>
            <Input
              id={nameLabel}
              value={name}
              disabled={busy}
              onChange={(event) => setName(sanitizeName(event.target.value))}
            />
            {name !== "" && !validName ? (
              <p style={{ ...hint, margin: 0 }}>
                {nameTaken
                  ? t("containerNameTaken")
                  : t("invalidContainerName")}
              </p>
            ) : null}
          </Field>
        ) : null}
        <div style={sectionTitle}>{t("envTitle")}</div>
        <EnvEditor t={t} env={env} busy={busy} onChange={setEnv} />
        <div style={sectionTitle}>{t("mountsTitle")}</div>
        <MountsEditor
          t={t}
          mounts={mounts}
          volumes={volumes}
          secrets={secrets}
          busy={busy}
          enabled={!busy}
          onAdd={(mount) => setMounts([...mounts, mount])}
          onRemove={(mount) =>
            setMounts(mounts.filter((item) => item !== mount))
          }
        />
        <div style={sectionTitle}>{t("containerSecretsTitle")}</div>
        {Object.entries(secretEnv).map(([envVar, secretName]) => (
          <div
            key={envVar}
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: "8px",
            }}
          >
            <code
              style={{
                ...greyId,
                flex: 1,
                fontSize: "13px",
                color: "var(--dsw-alias-label-primary)",
              }}
            >
              {envVar}={secretName}
            </code>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => {
                const next = { ...secretEnv };
                delete next[envVar];
                setSecretEnv(next);
              }}
            >
              {t("remove")}
            </Button>
          </div>
        ))}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "8px",
          }}
        >
          <select
            style={imageSelect}
            value={attachSecret}
            disabled={busy}
            onChange={(event) => setAttachSecret(event.target.value)}
            aria-label={t("attachSecret")}
          >
            {secrets.length === 0 ? (
              <option value="">{t("none")}</option>
            ) : null}
            {secrets.map((secret) => (
              <option key={secret.name} value={secret.name}>
                {secret.name}
              </option>
            ))}
          </select>
          <Input
            value={attachVar}
            disabled={busy}
            placeholder={t("secretEnvName")}
            onChange={(event) => setAttachVar(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") attach();
            }}
            style={{ width: "200px" }}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={
              busy || attachVar.trim() === "" || attachSecret === ""
            }
            onClick={attach}
          >
            {t("attachSecret")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function WorkspaceSection(props: {
  t: (key: ContainerPluginKey) => string;
  workspace: WorkspaceView;
  containers: readonly ContainerView[];
  images: readonly ImageView[];
  volumes: readonly { name: string }[];
  secrets: readonly { name: string }[];
  busy: boolean;
  defaultImage: string;
  onRemove: (workspace: string) => void;
  onRecreate: (
    workspace: string,
    image: string,
    env?: Record<string, string>,
  ) => void;
  onCreate: (workspace: WorkspaceView, config?: ContainerCreateConfig) => void;
  onStartContainer: (
    workspace: WorkspaceView,
    container: string,
    config?: ContainerCreateConfig,
  ) => void;
  onAddContainerMount: (
    workspace: string,
    container: string,
    mount: MountInput,
  ) => void;
  onRemoveContainerMount: (
    workspace: string,
    container: string,
    mount: MountInput,
  ) => void;
  onAddContainerSecret: (workspace: string, envVar: string, secret: string) => void;
  onRemoveContainerSecret: (workspace: string, envVar: string) => void;
}): ReactNode {
  const {
    t,
    workspace,
    containers,
    images,
    volumes,
    secrets,
    busy,
    defaultImage,
    onRemove,
    onRecreate,
    onCreate,
    onStartContainer,
    onAddContainerMount,
    onRemoveContainerMount,
    onAddContainerSecret,
    onRemoveContainerSecret,
  } = props;
  const [open, setOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState<"default" | "named" | null>(null);
  const hasContainer = containers.length > 0;
  return (
    <DisclosureRow
      icon={
        hasContainer ? (
          <StateDot state={containerStateDot(containers[0]?.status ?? "")} />
        ) : (
          <span />
        )
      }
      title={workspace.projectName}
      open={open}
      expandable
      onToggle={() => setOpen(!open)}
    >
      <div style={wsBody}>
        <code style={greyId}>{workspace.workspaceSlug}</code>
        {!hasContainer ? (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <p style={{ ...hint, margin: 0 }}>{t("noContainers")}</p>
            <div>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => setCreateOpen("default")}
              >
                {t("createContainer")}
              </Button>
            </div>
          </div>
        ) : (
          <>
            {containers.map((container) => (
              <ContainerRow
                key={container.containerName}
                t={t}
                container={container}
                images={images}
                volumes={volumes}
                secrets={secrets}
                busy={busy}
                onRemove={onRemove}
                onRecreate={onRecreate}
                onAddContainerMount={onAddContainerMount}
                onRemoveContainerMount={onRemoveContainerMount}
                onAddContainerSecret={onAddContainerSecret}
                onRemoveContainerSecret={onRemoveContainerSecret}
              />
            ))}
            <div>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => setCreateOpen("named")}
              >
                {t("addContainer")}
              </Button>
            </div>
          </>
        )}
      </div>
      <CreateContainerModal
        t={t}
        workspace={workspace}
        images={images}
        volumes={volumes}
        secrets={secrets}
        busy={busy}
        defaultImage={defaultImage}
        named={createOpen === "named"}
        existing={containers.map((container) => container.containerName)}
        open={createOpen !== null}
        onClose={() => setCreateOpen(null)}
        onCreate={(container, config) => {
          if (createOpen === "named") {
            onStartContainer(workspace, container, config);
          } else {
            onCreate(workspace, config);
          }
          setCreateOpen(null);
        }}
      />
    </DisclosureRow>
  );
}

function ImageItem(props: {
  t: (key: ContainerPluginKey) => string;
  image: ImageView;
  busy: boolean;
  defaultImage: string;
  onRemove: (imageId: string) => void;
  onRebuild: (imageId: string) => void;
  onSetDefault: (imageId: string) => void;
}): ReactNode {
  const { t, image, busy, defaultImage, onRemove, onRebuild, onSetDefault } = props;
  const [open, setOpen] = useState(false);
  return (
    <DisclosureRow
      icon={<span />}
      title={image.imageId}
      open={open}
      expandable
      onToggle={() => setOpen(!open)}
    >
      <div style={wsBody}>
        <table style={tableStyle}>
          <tbody>
            <tr>
              <th style={thStyle} scope="row">{t("parent")}</th>
              <td style={tdStyle}>{image.parent}</td>
            </tr>
            <tr>
              <th style={thStyle} scope="row">{t("imageTag")}</th>
              <td style={tdStyle}>{image.imageTag}</td>
            </tr>
            <tr>
              <th style={thStyle} scope="row">{t("builtAt")}</th>
              <td style={tdStyle}>{image.builtAt}</td>
            </tr>
            <tr>
              <th style={thStyle} scope="row">{t("packages")}</th>
              <td style={tdStyle}>
                {image.packages.length === 0 ? (
                  t("none")
                ) : (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                    {image.packages.map((pkg) => (
                      <Chip key={pkg} t={t} label={pkg} />
                    ))}
                  </div>
                )}
              </td>
            </tr>
          </tbody>
        </table>
        <div style={actions}>
          <ConfirmButton
            t={t}
            label={t("rebuildImage")}
            title={t("confirmTitle")}
            description={t("confirmRebuildImage")}
            disabled={busy}
            onConfirm={() => onRebuild(image.imageId)}
          />
          <ConfirmButton
            t={t}
            label={t("removeImage")}
            title={t("confirmTitle")}
            description={t("confirmRemoveImage")}
            disabled={busy}
            onConfirm={() => onRemove(image.imageId)}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={busy || image.imageId === defaultImage}
            onClick={() => onSetDefault(image.imageId)}
          >
            {t("setDefaultImage")}
          </Button>
        </div>
      </div>
    </DisclosureRow>
  );
}

function BaseImageRow(props: {
  t: (key: ContainerPluginKey) => string;
  image: ImageView;
  busy: boolean;
  defaultImage: string;
  onRebuild: (name: string) => void;
  onPull: (name: string) => void;
  onSetDefault: (imageId: string) => void;
}): ReactNode {
  const { t, image, busy, defaultImage, onRebuild, onPull, onSetDefault } = props;
  const [open, setOpen] = useState(false);
  const pull = image.basePublic && (image.status === "missing" || image.status === "pulled");
  const build = !image.basePublic && image.status === "missing";
  const rebuild = !image.basePublic && image.status === "built";
  return (
    <DisclosureRow
      icon={<span />}
      title={image.imageId}
      open={open}
      expandable
      onToggle={() => setOpen(!open)}
    >
      <div style={wsBody}>
        <table style={tableStyle}>
          <tbody>
            <tr>
              <th style={thStyle} scope="row">{t("primitive")}</th>
              <td style={tdStyle}>{image.primitive}</td>
            </tr>
            <tr>
              <th style={thStyle} scope="row">{t("packageManager")}</th>
              <td style={tdStyle}>{image.packageManager}</td>
            </tr>
            <tr>
              <th style={thStyle} scope="row">{t("status")}</th>
              <td style={tdStyle}>{image.status}</td>
            </tr>
            <tr>
              <th style={thStyle} scope="row">{t("builtAt")}</th>
              <td style={tdStyle}>{image.builtAt === "" ? t("none") : image.builtAt}</td>
            </tr>
            <tr>
              <th style={thStyle} scope="row">{t("packages")}</th>
              <td style={tdStyle}>
                {image.packages.length === 0 ? (
                  t("none")
                ) : (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                    {image.packages.map((pkg) => (
                      <Chip key={pkg} t={t} label={pkg} />
                    ))}
                  </div>
                )}
              </td>
            </tr>
          </tbody>
        </table>
        <div style={actions}>
          {pull ? (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => onPull(image.imageId)}
            >
              {t("pullImage")}
            </Button>
          ) : null}
          {build ? (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => onRebuild(image.imageId)}
            >
              {t("build")}
            </Button>
          ) : null}
          {rebuild ? (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => onRebuild(image.imageId)}
            >
              {t("rebuildImage")}
            </Button>
          ) : null}
          <Button
            variant="outline"
            size="sm"
            disabled={busy || image.imageId === defaultImage}
            onClick={() => onSetDefault(image.imageId)}
          >
            {t("setDefaultImage")}
          </Button>
        </div>
      </div>
    </DisclosureRow>
  );
}

function VolumesSection(props: {
  t: (key: ContainerPluginKey) => string;
  volumes: readonly { name: string }[];
  busy: boolean;
  writable: boolean;
  onCreate: (name: string) => void;
  onRemove: (name: string) => void;
}): ReactNode {
  const { t, volumes, busy, writable, onCreate, onRemove } = props;
  const [open, setOpen] = useState(false);
  const [openVolume, setOpenVolume] = useState<string | null>(null);
  const [name, setName] = useState("");
  const volumeId = useId();
  const canCreate = namePattern.test(name);
  const submit = (): void => {
    if (!namePattern.test(name)) return;
    onCreate(name.trim());
    setName("");
    setOpen(false);
  };
  return (
    <section>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "8px",
        }}
      >
        <div style={{ ...sectionTitle, flex: 1 }}>{t("volumesTitle")}</div>
        <Button
          variant="outline"
          size="sm"
          disabled={!writable || busy}
          onClick={() => setOpen(true)}
        >
          {t("createVolume")}
        </Button>
      </div>
      {volumes.length === 0 ? (
        <p style={hint}>{t("none")}</p>
      ) : (
        volumes.map((volume) => (
          <DisclosureRow
            key={volume.name}
            icon={<span />}
            title={volume.name}
            open={openVolume === volume.name}
            expandable
            onToggle={() =>
              setOpenVolume(openVolume === volume.name ? null : volume.name)
            }
          >
            <div style={wsBody}>
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "center",
                  gap: "8px",
                }}
              >
                <ConfirmButton
                  t={t}
                  label={t("removeVolume")}
                  title={t("confirmTitle")}
                  description={t("confirmRemoveVolume")}
                  disabled={busy}
                  onConfirm={() => onRemove(volume.name)}
                />
              </div>
            </div>
          </DisclosureRow>
        ))
      )}
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={t("volumesTitle")}
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
            <Button
              variant="primary"
              size="sm"
              disabled={!canCreate}
              onClick={submit}
            >
              {t("createVolume")}
            </Button>
          </>
        }
      >
        <Field label={t("volumeName")} htmlFor={volumeId}>
          <Input
            id={volumeId}
            value={name}
            disabled={!writable || busy}
            autoFocus
            onChange={(event) => setName(sanitizeName(event.target.value))}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit();
            }}
          />
          {name !== "" && !namePattern.test(name) ? (
            <p style={{ ...hint, margin: 0 }}>{t("invalidName")}</p>
          ) : null}
        </Field>
      </Modal>
    </section>
  );
}

function SecretRow(props: {
  t: (key: ContainerPluginKey) => string;
  name: string;
  busy: boolean;
  writable: boolean;
  onSet: (name: string, value: string) => void;
  onRemove: (name: string) => void;
}): ReactNode {
  const { t, name, busy, writable, onSet, onRemove } = props;
  const [content, setContent] = useState("");
  const canSave = content !== "" && !busy;
  const submit = (): void => {
    if (content === "") return;
    onSet(name, content);
    setContent("");
  };
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: "8px",
      }}
    >
      <code
        style={{
          ...greyId,
          flex: 1,
          fontSize: "13px",
          color: "var(--dsw-alias-label-primary)",
        }}
      >
        {name}
      </code>
      <Input
        type="password"
        value={content}
        disabled={!writable || busy}
        placeholder={t("setSecret")}
        onChange={(event) => setContent(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") submit();
        }}
        style={{ width: "200px" }}
      />
      <ConfirmButton
        t={t}
        label={t("setSecret")}
        title={t("confirmTitle")}
        description={t("confirmSetSecret")}
        disabled={!writable || !canSave}
        onConfirm={submit}
      />
      <ConfirmButton
        t={t}
        label={t("removeSecret")}
        title={t("confirmTitle")}
        description={t("confirmRemoveSecret")}
        disabled={busy}
        onConfirm={() => onRemove(name)}
      />
    </div>
  );
}

function SecretsSection(props: {
  t: (key: ContainerPluginKey) => string;
  secrets: readonly { name: string }[];
  busy: boolean;
  writable: boolean;
  onCreate: (name: string, length?: number, charset?: string) => void;
  onRemove: (name: string) => void;
  onSet: (name: string, value: string) => void;
}): ReactNode {
  const { t, secrets, busy, writable, onCreate, onRemove, onSet } = props;
  const [open, setOpen] = useState(false);
  const [openSecret, setOpenSecret] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [length, setLength] = useState("32");
  const [charset, setCharset] = useState("alphanumeric");
  const secretNameId = useId();
  const secretLengthId = useId();
  const secretCharsetId = useId();
  const canCreate = namePattern.test(name);
  const submit = (): void => {
    if (!namePattern.test(name)) return;
    const parsedLength = parseInt(length, 10);
    const normalized =
      length.trim() === "" || Number.isNaN(parsedLength) || parsedLength < 1
        ? undefined
        : parsedLength;
    onCreate(name.trim(), normalized, charset);
    setName("");
    setLength("32");
    setCharset("alphanumeric");
    setOpen(false);
  };
  return (
    <section>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "8px",
        }}
      >
        <div style={{ ...sectionTitle, flex: 1 }}>{t("secretsTitle")}</div>
        <Button
          variant="outline"
          size="sm"
          disabled={!writable || busy}
          onClick={() => setOpen(true)}
        >
          {t("createSecret")}
        </Button>
      </div>
      {secrets.length === 0 ? (
        <p style={hint}>{t("none")}</p>
      ) : (
        secrets.map((secret) => (
          <DisclosureRow
            key={secret.name}
            icon={<span />}
            title={secret.name}
            open={openSecret === secret.name}
            expandable
            onToggle={() =>
              setOpenSecret(openSecret === secret.name ? null : secret.name)
            }
          >
            <div style={wsBody}>
              <SecretRow
                t={t}
                name={secret.name}
                busy={busy}
                writable={writable}
                onSet={onSet}
                onRemove={onRemove}
              />
            </div>
          </DisclosureRow>
        ))
      )}
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={t("secretsTitle")}
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
            <Button
              variant="primary"
              size="sm"
              disabled={!canCreate}
              onClick={submit}
            >
              {t("createSecret")}
            </Button>
          </>
        }
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "12px",
          }}
        >
          <Field label={t("secretName")} htmlFor={secretNameId}>
            <Input
              id={secretNameId}
              value={name}
              disabled={!writable || busy}
              autoFocus
              onChange={(event) => setName(sanitizeName(event.target.value))}
              onKeyDown={(event) => {
                if (event.key === "Enter") submit();
              }}
            />
            {name !== "" && !namePattern.test(name) ? (
              <p style={{ ...hint, margin: 0 }}>{t("invalidName")}</p>
            ) : null}
          </Field>
          <Field label={t("secretLength")} htmlFor={secretLengthId}>
            <Input
              id={secretLengthId}
              type="number"
              min={1}
              max={1024}
              value={length}
              disabled={!writable || busy}
              onChange={(event) => setLength(event.target.value)}
            />
          </Field>
          <Field label={t("secretCharset")} htmlFor={secretCharsetId}>
            <select
              id={secretCharsetId}
              style={imageSelect}
              value={charset}
              disabled={!writable || busy}
              onChange={(event) => setCharset(event.target.value)}
            >
              <option value="alphanumeric">alphanumeric</option>
              <option value="hex">hex</option>
              <option value="base64url">base64url</option>
            </select>
          </Field>
        </div>
      </Modal>
    </section>
  );
}

function ImageBuildModal(props: {
  t: (key: ContainerPluginKey) => string;
  images: readonly { imageId: string; isBase: boolean }[];
  open: boolean;
  imageId: string;
  parent: string;
  packages: readonly string[];
  onImageId: (value: string) => void;
  onParent: (value: string) => void;
  onPackages: (tags: string[]) => void;
  onClose: () => void;
  onBuild: () => void;
}): ReactNode {
  const {
    t,
    images,
    open,
    imageId,
    parent,
    packages,
    onImageId,
    onParent,
    onPackages,
    onClose,
    onBuild,
  } = props;
  const canBuild = imageIdPattern.test(imageId) && parent.trim() !== "";
  const imageIdLabel = useId();
  const parentLabel = useId();
  const packagesLabel = useId();
  const baseImages = images.filter((image) => image.isBase);
  const customImages = images.filter((image) => !image.isBase);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("buildImageTitle")}
      closeLabel={t("cancel")}
      footer={
        <>
          <Button
            variant="outline"
            size="sm"
            onClick={onClose}
          >
            {t("cancel")}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!canBuild}
            onClick={onBuild}
          >
            {t("buildImage")}
          </Button>
        </>
      }
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "12px",
        }}
      >
        <Field label={t("imageId")} htmlFor={imageIdLabel}>
          <Input
            id={imageIdLabel}
            value={imageId}
            onChange={(event) => onImageId(sanitizeImageId(event.target.value))}
          />
          {imageId !== "" && !imageIdPattern.test(imageId) ? (
            <p style={{ ...hint, margin: 0 }}>{t("invalidImageId")}</p>
          ) : null}
        </Field>
        <Field label={t("parent")} htmlFor={parentLabel}>
          <select
            id={parentLabel}
            style={imageSelect}
            value={parent}
            onChange={(event) => onParent(event.target.value)}
          >
            <option value="">{t("selectImage")}</option>
            {baseImages.map((image) => (
              <option key={image.imageId} value={image.imageId}>
                {image.imageId}
              </option>
            ))}
            {customImages.map((image) => (
              <option key={image.imageId} value={image.imageId}>
                {image.imageId}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("packages")} htmlFor={packagesLabel}>
          <TagInput
            id={packagesLabel}
            t={t}
            value={packages}
            onChange={onPackages}
          />
        </Field>
      </div>
    </Modal>
  );
}

export function ContainerCard(props: ContainerCardProps): ReactNode {
  const { t } = props;
  const state = props.useContainerCard((snapshot) => snapshot);
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [buildOpen, setBuildOpen] = useState(false);
  const [imageId, setImageId] = useState("");
  const [parent, setParent] = useState("");
  const [packages, setPackages] = useState<string[]>([]);
  const [defaultOpen, setDefaultOpen] = useState(false);
  const [defaultImage, setDefaultImage] = useState(state.defaultImage);
  const projectsRootId = useId();
  const baseImages = state.images.filter((image) => image.isBase);
  const customImages = state.images.filter((image) => !image.isBase);
  const defaultCandidates = [
    ...baseImages.map((image) => image.imageId),
    ...customImages.map((image) => image.imageId),
  ];
  if (!state.available) {
    return (
      <p style={{ padding: "8px 0", fontSize: "13px", opacity: 0.8 }}>
        {t("unavailable")}
      </p>
    );
  }
  return (
    <li
      style={{
        ...cardStyle,
        ...(open ? cardOpenStyle : {}),
        ...(hovered && !open ? cardHoverStyle : {}),
      }}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => setHovered(false)}
    >
      <button
        type="button"
        style={cardHeaderStyle}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span style={cardHeadTextStyle}>
          <span style={cardNameStyle}>{t("cardTitle")}</span>
          <span style={cardDescriptionStyle}>{t("cardDescription")}</span>
        </span>
        <CardChevron open={open} />
      </button>
      {open ? (
        <div style={cardBodyStyle}>
          {state.notice === "" ? null : (
            <div style={banner} role="status">
              {t("notice")}: {state.notice}
            </div>
          )}
          <div style={sectionTitle}>{t("workspacesTitle")}</div>
          {state.workspaces.length === 0 ? (
            <p style={hint}>{t("none")}</p>
          ) : (
            state.workspaces.map((workspace) => (
              <WorkspaceSection
                key={workspace.workspaceSlug}
                t={t}
                workspace={workspace}
                containers={state.containers.filter(
                  (container) =>
                    container.workspaceSlug === workspace.workspaceSlug,
                )}
                images={state.images}
                volumes={state.volumes}
                secrets={state.secrets}
                busy={state.busy}
                defaultImage={state.defaultImage}
                onRemove={props.remove}
                onRecreate={props.recreate}
                onCreate={props.createContainer}
                onStartContainer={props.startContainer}
                onAddContainerMount={props.addContainerMount}
                onRemoveContainerMount={props.removeContainerMount}
                onAddContainerSecret={props.addContainerSecret}
                onRemoveContainerSecret={props.removeContainerSecret}
              />
            ))
          )}
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: "8px",
            }}
          >
            <div style={{ ...sectionTitle, flex: 1 }}>{t("imagesTitle")}</div>
            <Button
              variant="outline"
              size="sm"
              disabled={state.busy}
              onClick={() => {
                setDefaultImage(state.defaultImage);
                setDefaultOpen(true);
              }}
            >
              {t("setDefaultImage")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={state.busy}
              onClick={() => {
                setImageId("");
                setParent(baseImages[0]?.imageId ?? customImages[0]?.imageId ?? "");
                setPackages([]);
                setBuildOpen(true);
              }}
            >
              {t("buildImage")}
            </Button>
            <ConfirmButton
              t={t}
              label={t("rebuildAllImages")}
              title={t("confirmTitle")}
              description={t("confirmRebuildAllImages")}
              disabled={state.busy}
              onConfirm={props.rebuildAllImages}
            />
          </div>
          <div style={sectionTitle}>{t("baseImagesTitle")}</div>
          {baseImages.length === 0 ? (
            <p style={hint}>{t("none")}</p>
          ) : (
            baseImages.map((image) => (
              <BaseImageRow
                key={image.imageId}
                t={t}
                image={image}
                busy={state.busy}
                defaultImage={state.defaultImage}
                onRebuild={props.rebuildBaseImage}
                onPull={props.pullBaseImage}
                onSetDefault={props.setDefaultImage}
              />
            ))
          )}
          <div style={sectionTitle}>{t("customImagesTitle")}</div>
          {customImages.length === 0 ? (
            <p style={hint}>{t("none")}</p>
          ) : (
            customImages.map((image) => (
              <ImageItem
                key={image.imageId}
                t={t}
                image={image}
                busy={state.busy}
                defaultImage={state.defaultImage}
                onRemove={props.removeImage}
                onRebuild={props.rebuildImage}
                onSetDefault={props.setDefaultImage}
              />
            ))
          )}
          <ImageBuildModal
            t={t}
            images={state.images}
            open={buildOpen}
            imageId={imageId}
            parent={parent}
            packages={packages}
            onImageId={setImageId}
            onParent={setParent}
            onPackages={setPackages}
            onClose={() => setBuildOpen(false)}
            onBuild={() => {
              props.buildImage(imageId.trim(), parent.trim(), packages);
              setImageId("");
              setParent("");
              setPackages([]);
              setBuildOpen(false);
            }}
          />
          <Modal
            open={defaultOpen}
            onClose={() => setDefaultOpen(false)}
            title={t("setDefaultImageTitle")}
            closeLabel={t("cancel")}
            footer={
              <>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setDefaultOpen(false)}
                >
                  {t("cancel")}
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  disabled={defaultImage === ""}
                  onClick={() => {
                    props.setDefaultImage(defaultImage);
                    setDefaultOpen(false);
                  }}
                >
                  {t("setDefaultImage")}
                </Button>
              </>
            }
          >
            <select
              style={imageSelect}
              value={defaultImage}
              onChange={(event) => setDefaultImage(event.target.value)}
            >
              {defaultCandidates.length === 0 ? (
                <option value="">{t("none")}</option>
              ) : null}
              {defaultCandidates.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </Modal>
          <VolumesSection
            t={t}
            volumes={state.volumes}
            busy={state.busy}
            writable={state.writable}
            onCreate={props.createVolume}
            onRemove={props.removeVolume}
          />
          <SecretsSection
            t={t}
            secrets={state.secrets}
            busy={state.busy}
            writable={state.writable}
            onCreate={props.createSecret}
            onRemove={props.removeSecret}
            onSet={props.setSecret}
          />
          <div style={sectionTitle}>{t("configTitle")}</div>
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
              htmlFor={projectsRootId}
              style={{
                fontSize: "13px",
                color: "var(--dsw-alias-label-secondary)",
                minWidth: "110px",
              }}
            >
              {t("projectsRoot")}
            </label>
            <Input
              id={projectsRootId}
              value={state.projectsRoot}
              disabled
              style={{ width: "200px" }}
            />
          </div>
          <ConfigField
            t={t}
            label={t("socketsRoot")}
            value={state.socketsRootDraft}
            current={state.socketsRoot}
            writable={state.writable}
            onChange={props.editSocketsRoot}
            onSave={props.saveSocketsRoot}
            onDiscard={props.discardSocketsRoot}
          />
          <div style={footerRow}>
            <Button
              variant="outline"
              size="sm"
              disabled={state.busy}
              onClick={props.reload}
            >
              {state.busy ? t("busy") : t("reload")}
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}
