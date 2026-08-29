// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { useId, useState, type ReactNode } from "react";
import {
  Button,
  DisclosureRow,
  Input,
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

function ContainerRow(props: {
  t: (key: ContainerPluginKey) => string;
  container: ContainerView;
  images: readonly { imageId: string }[];
  busy: boolean;
  onRemove: (workspace: string) => void;
  onRecreate: (workspace: string, image: string) => void;
}): ReactNode {
  const { t, container, images, busy, onRemove, onRecreate } = props;
  const [selected, setSelected] = useState(container.imageId);
  const enabled = container.workspaceSlug !== "" && !busy;
  const projects = container.mounts
    .map((mount) => mount.projectName)
    .join(", ");
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
        </tbody>
      </table>
      <div style={actions}>
        <Button
          variant="outline"
          size="sm"
          disabled={!enabled}
          onClick={() => onRemove(container.workspaceSlug)}
        >
          {t("remove")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={!enabled}
          onClick={() => onRecreate(container.workspaceSlug, "")}
        >
          {t("recreate")}
        </Button>
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
        <Button
          variant="outline"
          size="sm"
          disabled={!enabled || selected === ""}
          onClick={() => onRecreate(container.workspaceSlug, selected)}
        >
          {t("recreateWithImage")}
        </Button>
      </div>
    </div>
  );
}

function WorkspaceSection(props: {
  t: (key: ContainerPluginKey) => string;
  workspace: WorkspaceView;
  containers: readonly ContainerView[];
  images: readonly { imageId: string }[];
  busy: boolean;
  onRemove: (workspace: string) => void;
  onRecreate: (workspace: string, image: string) => void;
  onCreate: (workspace: WorkspaceView) => void;
}): ReactNode {
  const { t, workspace, containers, images, busy, onRemove, onRecreate, onCreate } = props;
  const [open, setOpen] = useState(false);
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
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px" }}>
            <p style={{ ...hint, margin: 0 }}>{t("noContainers")}</p>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => onCreate(workspace)}
            >
              {t("createContainer")}
            </Button>
          </div>
        ) : (
          containers.map((container) => (
            <ContainerRow
              key={container.containerName}
              t={t}
              container={container}
              images={images}
              busy={busy}
              onRemove={onRemove}
              onRecreate={onRecreate}
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
}): ReactNode {
  const { t, image } = props;
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
                {image.packages.length === 0
                  ? t("none")
                  : image.packages.join(", ")}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </DisclosureRow>
  );
}

export function ContainerCard(props: ContainerCardProps): ReactNode {
  const { t } = props;
  const state = props.useContainerCard((snapshot) => snapshot);
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
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
                busy={state.busy}
                onRemove={props.remove}
                onRecreate={props.recreate}
                onCreate={props.createContainer}
              />
            ))
          )}
          <div style={sectionTitle}>{t("imagesTitle")}</div>
          {state.images.length === 0 ? (
            <p style={hint}>{t("none")}</p>
          ) : (
            state.images.map((image) => (
              <ImageItem key={image.imageId} t={t} image={image} />
            ))
          )}
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
