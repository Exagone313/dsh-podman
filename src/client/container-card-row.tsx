// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { type ContainerView, type MountInput } from "./container-card-controller.js";
import { EnvEditor, MountsEditor } from "./container-card-editors.js";
import { ConfirmButton, mountViewToInput } from "./container-card-shared.js";
import {
  actions,
  containerHeader,
  containerRow,
  greyId,
  imageSelect,
  tableStyle,
  tdStyle,
  thStyle,
  wsBody,
} from "./container-card-styles.js";
import { type ContainerPluginKey } from "./locales.js";
import { Button, DisclosureRow, Input, Pill } from "@deepseek-ai/dsh-client-ui-primitives";
import { type ReactNode, useState } from "react";

export function ContainerRow(props: {
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
  onUpdateContainerMount: (workspace: string, container: string, mount: MountInput) => void;
  onAddContainerSecret: (workspace: string, envVar: string, secret: string) => void;
  onRemoveContainerSecret: (workspace: string, envVar: string) => void;
  projectName: string;
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
    onUpdateContainerMount,
    onAddContainerSecret,
    onRemoveContainerSecret,
    projectName,
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
            primaryProject={
              container.containerName === "default" ? projectName : ""
            }
            onUpdate={(mount) =>
              onUpdateContainerMount(
                container.workspaceSlug,
                container.containerName,
                mount,
              )
            }
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

export { CreateContainerModal } from "./container-card-create-modal.js";
