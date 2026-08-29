// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { useState, type ReactNode } from "react";
import type {
  InjectFace,
  PropsLocale,
  PropsRuntime,
} from "@deepseek-ai/dsh-client-ui-slots";
import type {
  ContainerCardFace,
  ContainerView,
} from "./container-card-controller.js";
import type {} from "./container-card-controller.js";
import { NS, type ContainerPluginKey } from "./locales.js";

export type ContainerCardProps = PropsRuntime<"settings.plugin.item"> &
  PropsLocale<typeof NS> &
  InjectFace<ContainerCardFace>;

const row: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "4px",
  padding: "8px",
  border: "1px solid rgba(127,127,127,0.35)",
  borderRadius: "6px",
  marginBottom: "8px",
};
const meta: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "12px",
  fontSize: "12px",
  opacity: 0.8,
};
const actions: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "8px",
  alignItems: "center",
};
const button: React.CSSProperties = {
  padding: "3px 10px",
  borderRadius: "4px",
  border: "1px solid rgba(127,127,127,0.5)",
  background: "transparent",
  color: "inherit",
  cursor: "pointer",
};
const select: React.CSSProperties = {
  padding: "3px 8px",
  borderRadius: "4px",
  border: "1px solid rgba(127,127,127,0.5)",
  background: "transparent",
  color: "inherit",
};
const sectionTitle: React.CSSProperties = {
  fontWeight: 600,
  margin: "12px 0 8px",
};
const banner: React.CSSProperties = {
  padding: "6px 10px",
  borderRadius: "6px",
  border: "1px solid rgba(210,153,34,0.6)",
  marginBottom: "8px",
  fontSize: "13px",
};
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
    <div style={row}>
      <strong>{container.containerName}</strong>
      <div style={meta}>
        <span>
          {t("workspace")}:{" "}
          {container.workspaceSlug === "" ? t("none") : container.workspaceSlug}
        </span>
        <span>
          {t("image")}: {container.imageId}
        </span>
        <span>
          {t("status")}: {container.status}
        </span>
        <span>
          {t("created")}: {container.createdAt}
        </span>
        {projects !== "" ? (
          <span>
            {t("projects")}: {projects}
          </span>
        ) : null}
      </div>
      <div style={actions}>
        <button
          type="button"
          style={button}
          disabled={!enabled}
          onClick={() => onRemove(container.workspaceSlug)}
        >
          {t("remove")}
        </button>
        <button
          type="button"
          style={button}
          disabled={!enabled}
          onClick={() => onRecreate(container.workspaceSlug, "")}
        >
          {t("recreate")}
        </button>
        <select
          style={select}
          value={selected}
          disabled={!enabled}
          onChange={(event) => setSelected(event.target.value)}
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
        <button
          type="button"
          style={button}
          disabled={!enabled || selected === ""}
          onClick={() => onRecreate(container.workspaceSlug, selected)}
        >
          {t("recreateWithImage")}
        </button>
      </div>
    </div>
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
          <div style={sectionTitle}>{t("configTitle")}</div>
          <div style={actions}>
            <label
              htmlFor="plugin-config-container-default-image"
              style={{ fontSize: "13px" }}
            >
              {t("defaultImage")}
            </label>
            <input
              id="plugin-config-container-default-image"
              value={state.defaultImageDraft}
              disabled={!state.writable}
              onChange={(event) => props.editDefaultImage(event.target.value)}
              style={{ ...select, width: "180px" }}
            />
            <button
              type="button"
              style={button}
              disabled={
                !state.writable || state.defaultImageDraft === state.defaultImage
              }
              onClick={props.saveDefaultImage}
            >
              {t("save")}
            </button>
            <button
              type="button"
              style={button}
              disabled={state.defaultImageDraft === state.defaultImage}
              onClick={props.discardDefaultImage}
            >
              {t("discard")}
            </button>
          </div>
          <div style={sectionTitle}>{t("containersTitle")}</div>
          {state.containers.length === 0 ? (
            <p style={{ fontSize: "13px", opacity: 0.8 }}>{t("none")}</p>
          ) : (
            state.containers.map((container) => (
              <ContainerRow
                key={container.containerName}
                t={t}
                container={container}
                images={state.images}
                busy={state.busy}
                onRemove={props.remove}
                onRecreate={props.recreate}
              />
            ))
          )}
          <div style={sectionTitle}>{t("imagesTitle")}</div>
          {state.images.length === 0 ? (
            <p style={{ fontSize: "13px", opacity: 0.8 }}>{t("none")}</p>
          ) : (
            state.images.map((image) => (
              <div key={image.imageId} style={row}>
                <strong>{image.imageId}</strong>
                <div style={meta}>
                  <span>
                    {t("baseImage")}: {image.baseImage}
                  </span>
                  <span>
                    {t("imageTag")}: {image.imageTag}
                  </span>
                  <span>
                    {t("builtAt")}: {image.builtAt}
                  </span>
                  <span>
                    {t("packages")}: {image.packages.length}
                  </span>
                </div>
              </div>
            ))
          )}
          <div style={{ ...actions, paddingTop: "12px", borderTop: "1px solid var(--dsw-alias-border-l2)", marginTop: "12px" }}>
            <button
              type="button"
              style={button}
              disabled={state.busy}
              onClick={props.reload}
            >
              {state.busy ? t("busy") : t("reload")}
            </button>
          </div>
        </div>
      ) : null}
    </li>
  );
}
