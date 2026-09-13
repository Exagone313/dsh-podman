// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import {
  type ContainerCreateConfig,
  type ImageView,
  type MountInput,
  type WorkspaceView,
} from "./container-card-controller.js";
import { EnvEditor, MountsEditor } from "./container-card-editors.js";
import { Field, namePattern, sanitizeName } from "./container-card-shared.js";
import { greyId, hint, imageSelect, sectionTitle } from "./container-card-styles.js";
import { type ContainerPluginKey } from "./locales.js";
import { Button, Input, Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import { type ReactNode, useEffect, useId, useState } from "react";

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
