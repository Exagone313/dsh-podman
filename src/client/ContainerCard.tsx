// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { useId, useState, type ReactNode } from "react";
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
  ContainerView,
  ImageView,
  WorkspaceView,
} from "./container-card-controller.js";
import type {} from "./container-card-controller.js";
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

function ContainerRow(props: {
  t: (key: ContainerPluginKey) => string;
  container: ContainerView;
  images: readonly { imageId: string }[];
  secrets: readonly { name: string }[];
  busy: boolean;
  onRemove: (workspace: string) => void;
  onRecreate: (
    workspace: string,
    image: string,
    env?: Record<string, string>,
  ) => void;
  onAddContainerSecret: (workspace: string, envVar: string, secret: string) => void;
  onRemoveContainerSecret: (workspace: string, envVar: string) => void;
}): ReactNode {
  const {
    t,
    container,
    images,
    secrets,
    busy,
    onRemove,
    onRecreate,
    onAddContainerSecret,
    onRemoveContainerSecret,
  } = props;
  const [selected, setSelected] = useState(container.imageId);
  const [env, setEnv] = useState<Record<string, string>>(container.env);
  const [envOpen, setEnvOpen] = useState(false);
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

function WorkspaceSection(props: {
  t: (key: ContainerPluginKey) => string;
  workspace: WorkspaceView;
  containers: readonly ContainerView[];
  images: readonly { imageId: string }[];
  secrets: readonly { name: string }[];
  busy: boolean;
  onRemove: (workspace: string) => void;
  onRecreate: (
    workspace: string,
    image: string,
    env?: Record<string, string>,
  ) => void;
  onCreate: (workspace: WorkspaceView, env?: Record<string, string>) => void;
  onAddContainerSecret: (workspace: string, envVar: string, secret: string) => void;
  onRemoveContainerSecret: (workspace: string, envVar: string) => void;
}): ReactNode {
  const {
    t,
    workspace,
    containers,
    images,
    secrets,
    busy,
    onRemove,
    onRecreate,
    onCreate,
    onAddContainerSecret,
    onRemoveContainerSecret,
  } = props;
  const [open, setOpen] = useState(false);
  const [createEnv, setCreateEnv] = useState<Record<string, string>>({});
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
            <EnvEditor t={t} env={createEnv} busy={busy} onChange={setCreateEnv} />
            <div>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => onCreate(workspace, createEnv)}
              >
                {t("createContainer")}
              </Button>
            </div>
          </div>
        ) : (
          containers.map((container) => (
            <ContainerRow
              key={container.containerName}
              t={t}
              container={container}
              images={images}
              secrets={secrets}
              busy={busy}
              onRemove={onRemove}
              onRecreate={onRecreate}
              onAddContainerSecret={onAddContainerSecret}
              onRemoveContainerSecret={onRemoveContainerSecret}
            />
          ))
        )}
      </div>
    </DisclosureRow>
  );
}

function ImageItem(props: {
  t: (key: ContainerPluginKey) => string;
  image: ImageView;
  busy: boolean;
  onRemove: (imageId: string) => void;
  onRebuild: (imageId: string) => void;
}): ReactNode {
  const { t, image, busy, onRemove, onRebuild } = props;
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
              <th style={thStyle} scope="row">{t("baseImage")}</th>
              <td style={tdStyle}>{image.baseImage}</td>
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
  const canCreate = name.trim() !== "";
  const submit = (): void => {
    if (name.trim() === "") return;
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
        <Input
          value={name}
          disabled={!writable || busy}
          placeholder={t("createVolume")}
          autoFocus
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit();
          }}
        />
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
  onCreate: (name: string, length?: number) => void;
  onRemove: (name: string) => void;
  onSet: (name: string, value: string) => void;
}): ReactNode {
  const { t, secrets, busy, writable, onCreate, onRemove, onSet } = props;
  const [open, setOpen] = useState(false);
  const [openSecret, setOpenSecret] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [length, setLength] = useState("");
  const canCreate = name.trim() !== "";
  const submit = (): void => {
    if (name.trim() === "") return;
    const parsedLength = parseInt(length, 10);
    onCreate(
      name.trim(),
      length.trim() === "" || Number.isNaN(parsedLength) ? undefined : parsedLength,
    );
    setName("");
    setLength("");
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
          <Input
            value={name}
            disabled={!writable || busy}
            placeholder={t("createSecret")}
            autoFocus
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit();
            }}
          />
          <Input
            type="number"
            value={length}
            disabled={!writable || busy}
            aria-label={t("secretLength")}
            onChange={(event) => setLength(event.target.value)}
          />
        </div>
      </Modal>
    </section>
  );
}

function ImageBuildModal(props: {
  t: (key: ContainerPluginKey) => string;
  open: boolean;
  imageId: string;
  baseImage: string;
  packages: readonly string[];
  onImageId: (value: string) => void;
  onBaseImage: (value: string) => void;
  onPackages: (tags: string[]) => void;
  onClose: () => void;
  onBuild: () => void;
}): ReactNode {
  const {
    t,
    open,
    imageId,
    baseImage,
    packages,
    onImageId,
    onBaseImage,
    onPackages,
    onClose,
    onBuild,
  } = props;
  const canBuild = imageId.trim() !== "" && baseImage.trim() !== "";
  const imageIdLabel = useId();
  const baseImageLabel = useId();
  const packagesLabel = useId();
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
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "4px",
          }}
        >
          <label
            htmlFor={imageIdLabel}
            style={{
              fontSize: "13px",
              color: "var(--dsw-alias-label-secondary)",
            }}
          >
            {t("imageId")}
          </label>
          <Input
            id={imageIdLabel}
            value={imageId}
            placeholder={t("imageId")}
            onChange={(event) => onImageId(event.target.value)}
          />
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "4px",
          }}
        >
          <label
            htmlFor={baseImageLabel}
            style={{
              fontSize: "13px",
              color: "var(--dsw-alias-label-secondary)",
            }}
          >
            {t("baseImage")}
          </label>
          <Input
            id={baseImageLabel}
            value={baseImage}
            placeholder={t("baseImage")}
            onChange={(event) => onBaseImage(event.target.value)}
          />
        </div>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "4px",
          }}
        >
          <label
            htmlFor={packagesLabel}
            style={{
              fontSize: "13px",
              color: "var(--dsw-alias-label-secondary)",
            }}
          >
            {t("packages")}
          </label>
          <TagInput
            id={packagesLabel}
            t={t}
            value={packages}
            onChange={onPackages}
            placeholder={t("packages")}
          />
        </div>
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
  const [baseImage, setBaseImage] = useState("");
  const [packages, setPackages] = useState<string[]>([]);
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
                secrets={state.secrets}
                busy={state.busy}
                onRemove={props.remove}
                onRecreate={props.recreate}
                onCreate={props.createContainer}
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
              onClick={() => setBuildOpen(true)}
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
          {state.images.length === 0 ? (
            <p style={hint}>{t("none")}</p>
          ) : (
            state.images.map((image) => (
              <ImageItem
                key={image.imageId}
                t={t}
                image={image}
                busy={state.busy}
                onRemove={props.removeImage}
                onRebuild={props.rebuildImage}
              />
            ))
          )}
          <ImageBuildModal
            t={t}
            open={buildOpen}
            imageId={imageId}
            baseImage={baseImage}
            packages={packages}
            onImageId={setImageId}
            onBaseImage={setBaseImage}
            onPackages={setPackages}
            onClose={() => setBuildOpen(false)}
            onBuild={() => {
              props.buildImage(imageId.trim(), baseImage.trim(), packages);
              setImageId("");
              setBaseImage("");
              setPackages([]);
              setBuildOpen(false);
            }}
          />
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
          <ConfigField
            t={t}
            label={t("defaultImage")}
            value={state.defaultImageDraft}
            current={state.defaultImage}
            writable={state.writable}
            onChange={props.editDefaultImage}
            onSave={props.saveDefaultImage}
            onDiscard={props.discardDefaultImage}
          />
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
          <ConfigField
            t={t}
            label={t("projectsRoot")}
            value={state.projectsRootDraft}
            current={state.projectsRoot}
            writable={state.writable}
            onChange={props.editProjectsRoot}
            onSave={props.saveProjectsRoot}
            onDiscard={props.discardProjectsRoot}
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
