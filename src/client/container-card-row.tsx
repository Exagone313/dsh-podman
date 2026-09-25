// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { type ContainerView, type MountInput } from "./container-card-controller.js";
import { EnvEditor, MountsEditor } from "./container-card-editors.js";
import { type DirectoryPickerFace } from "./directory-picker.js";
import { PathsEditor } from "./container-card-paths.js";
import { ConfirmButton, mountKindShort, mountViewToInput } from "./container-card-shared.js";
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
import { type ContainerPluginKey, type Translate } from "./locales.js";
import { Button, DisclosureRow, Input, Pill } from "@deepseek-ai/dsh-client-ui-primitives";
import { type ReactNode, useEffect, useState } from "react";

// The order the summary table lists mount kinds in.
const MOUNT_ROWS: readonly { key: ContainerPluginKey; kind: string }[] = [
  { key: "projects", kind: "project" },
  { key: "volumesTitle", kind: "volume" },
  { key: "mountTmpfs", kind: "tmpfs" },
  { key: "secretsTitle", kind: "secret" },
];

// One summary row per mount kind present on a container, so a volume, tmpfs or
// secret never contributes an empty project name to the Projects line. A mount
// whose identifying field is empty is skipped, and a kind with no mount left
// gets no row at all.
export function mountSummaries(
  mounts: readonly ContainerView["mounts"][number][],
): { key: ContainerPluginKey; values: string[] }[] {
  const buckets = new Map<string, string[]>(
    MOUNT_ROWS.map(({ kind }) => [kind, []]),
  );
  for (const mount of mounts) {
    const kind = mountKindShort(mount.kind);
    const values = buckets.get(kind);
    if (values === undefined) continue;
    const identifier = kind === "project"
      ? mount.projectName
      : kind === "volume"
      ? mount.volume
      : kind === "secret"
      ? mount.secret
      : mount.destination;
    if (identifier === "") continue;
    values.push(
      kind === "tmpfs" || mount.destination === ""
        ? identifier
        : `${identifier} → ${mount.destination}`,
    );
  }
  return MOUNT_ROWS.flatMap(({ key, kind }) => {
    const values = buckets.get(kind) ?? [];
    return values.length === 0 ? [] : [{ key, values }];
  });
}

export function ContainerRow(props: {
  t: Translate;
  container: ContainerView;
  images: readonly { imageId: string }[];
  volumes: readonly { name: string }[];
  secrets: readonly { name: string }[];
  busy: boolean;
  onRemove: (workspace: string, container: string) => void;
  onRecreate: (
    workspace: string,
    container: string,
    image: string,
    env?: Record<string, string>,
  ) => void;
  onAddContainerMount: (workspace: string, container: string, mount: MountInput) => void;
  onRemoveContainerMount: (workspace: string, container: string, mount: MountInput) => void;
  onUpdateContainerMount: (workspace: string, container: string, mount: MountInput) => void;
  onSetContainerPaths: (
    workspace: string,
    container: string,
    paths: readonly string[],
  ) => void;
  onAddContainerSecret: (
    workspace: string,
    container: string,
    envVar: string,
    secret: string,
  ) => void;
  onRemoveContainerSecret: (
    workspace: string,
    container: string,
    envVar: string,
  ) => void;
  projectName: string;
  projectsRoot: string;
  directoryPicker?: DirectoryPickerFace;
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
    onSetContainerPaths,
    onAddContainerSecret,
    onRemoveContainerSecret,
    projectName,
    projectsRoot,
    directoryPicker,
  } = props;
  const [selected, setSelected] = useState(container.imageId);
  const [env, setEnv] = useState<Record<string, string>>(container.env);
  // The row is keyed by container name, so it survives a snapshot refresh.
  // Re-sync the image draft when the live image changes, or the select would
  // keep offering and re-sending the previous one.
  useEffect(() => {
    setSelected(container.imageId);
  }, [container.imageId]);
  // Env is a fresh object on every snapshot; key the resync on its content so
  // an unchanged refresh does not clobber an in-progress edit.
  const serverEnv = JSON.stringify(container.env);
  useEffect(() => {
    setEnv(container.env);
  }, [serverEnv]);
  const [envOpen, setEnvOpen] = useState(false);
  const [mountOpen, setMountOpen] = useState(false);
  const [pathOpen, setPathOpen] = useState(false);
  const [secretOpen, setSecretOpen] = useState(false);
  const [attachSecret, setAttachSecret] = useState("");
  const [attachVar, setAttachVar] = useState("");
  const enabled = container.workspaceSlug !== "" && !busy;
  const mountRows = mountSummaries(container.mounts);
  const envEntries = Object.entries(container.env);
  const secretEntries = Object.entries(container.secretEnv);
  const attach = (): void => {
    const envVar = attachVar.trim();
    if (envVar === "" || attachSecret === "") return;
    onAddContainerSecret(
      container.workspaceSlug,
      container.containerName,
      envVar,
      attachSecret,
    );
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
          {mountRows.map(({ key, values }) => (
            <tr key={key}>
              <th style={thStyle} scope="row">{t(key)}</th>
              <td style={tdStyle}>{values.join(", ")}</td>
            </tr>
          ))}
          {envEntries.length > 0
            ? (
              <tr>
                <th style={thStyle} scope="row">{t("env")}</th>
                <td style={tdStyle}>
                  {envEntries.map(([key]) => key).join(", ")}
                </td>
              </tr>
            )
            : null}
          {secretEntries.length > 0
            ? (
              <tr>
                <th style={thStyle} scope="row">{t("secretEnv")}</th>
                <td style={tdStyle}>
                  {secretEntries
                    .map(([envVar, secretName]) => `${envVar}=${secretName}`)
                    .join(", ")}
                </td>
              </tr>
            )
            : null}
        </tbody>
      </table>
      <div style={actions}>
        <ConfirmButton
          t={t}
          label={t("remove")}
          title={t("confirmTitle")}
          description={t("confirmRemoveContainer", {
            workspace: projectName,
            container: container.containerName,
          })}
          disabled={!enabled}
          onConfirm={() => onRemove(container.workspaceSlug, container.containerName)}
        />
        <ConfirmButton
          t={t}
          label={t("recreate")}
          title={t("confirmTitle")}
          description={t("confirmRecreate", {
            workspace: projectName,
            container: container.containerName,
          })}
          disabled={!enabled}
          onConfirm={() => onRecreate(container.workspaceSlug, container.containerName, "", env)}
        />
        <select
          style={imageSelect}
          value={selected}
          disabled={!enabled}
          onChange={(event) => setSelected(event.target.value)}
          aria-label={t("recreateWithImage")}
        >
          {container.imageId === "" ? <option value="">{t("none")}</option> : null}
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
          description={t("confirmRecreate", {
            workspace: projectName,
            container: container.containerName,
          })}
          disabled={!enabled || selected === ""}
          onConfirm={() =>
            onRecreate(container.workspaceSlug, container.containerName, selected, env)}
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
            projectsRoot={projectsRoot}
            directoryPicker={directoryPicker}
            confirmRemove
            primaryProject={container.containerName === "default" ? projectName : ""}
            onUpdate={(mount) =>
              onUpdateContainerMount(
                container.workspaceSlug,
                container.containerName,
                mount,
              )}
            onRemove={(mount) =>
              onRemoveContainerMount(
                container.workspaceSlug,
                container.containerName,
                mount,
              )}
            onAdd={(mount) =>
              onAddContainerMount(
                container.workspaceSlug,
                container.containerName,
                mount,
              )}
          />
        </div>
      </DisclosureRow>
      <DisclosureRow
        icon={<span />}
        title={t("pathsTitle")}
        open={pathOpen}
        expandable
        onToggle={() => setPathOpen(!pathOpen)}
      >
        <div style={wsBody}>
          <PathsEditor
            t={t}
            paths={container.paths}
            busy={busy}
            enabled={enabled}
            onApply={(paths) =>
              onSetContainerPaths(
                container.workspaceSlug,
                container.containerName,
                paths,
              )}
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
                description={t("confirmDetachSecret", { env: envVar, secret: secretName })}
                disabled={busy}
                onConfirm={() =>
                  onRemoveContainerSecret(
                    container.workspaceSlug,
                    container.containerName,
                    envVar,
                  )}
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
              {secrets.length === 0 ? <option value="">{t("none")}</option> : null}
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
