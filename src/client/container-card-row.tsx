// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { EnvEditor, MountsEditor } from "./container-card-editors.js";
import {
  ConfirmButton,
  Field,
  mountViewToInput,
  namePattern,
  sanitizeName,
} from "./container-card-shared.js";
import {
  actions,
  containerHeader,
  containerRow,
  greyId,
  hint,
  imageSelect,
  sectionTitle,
  tableStyle,
  tdStyle,
  thStyle,
  wsBody,
} from "./container-card-styles.js";
import {
  type ContainerCreateConfig,
  type ContainerView,
  type ImageView,
  type MountInput,
  type WorkspaceView,
} from "./container-card-controller.js";
import { type ContainerPluginKey } from "./locales.js";
import { Button, DisclosureRow, Input, Modal, Pill } from "@deepseek-ai/dsh-client-ui-primitives";
import { type ReactNode, useEffect, useId, useState } from "react";

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

export function CreateContainerModal(props: {
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
