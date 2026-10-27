// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// The one body the three container dialogs render: the Add-container dialog
// (a named create), the Create-container dialog (the workspace's default) and
// the Edit dialog all hand this form their own draft, so the groups, their
// canonical order, their field components, their labels and their spacing
// cannot drift apart. Only what genuinely differs is passed as a flag: whether
// the name is being chosen or is the container's own identity, and the
// confirmation a mount removal asks for only where a live container is behind
// the dialog.

import { type PortConfig } from "./container-card-config.js";
import {
  type ImageView,
  type MountInput,
} from "./container-card-controller.js";
import { EnvEditor, MountsEditor } from "./container-card-editors.js";
import {
  firstMountDestinationError,
  nonProjectDestinationError,
} from "./container-card-mount-sources.js";
import { PathsEditor } from "./container-card-paths.js";
import { PortsEditor } from "./container-card-ports.js";
import { buildParentImages } from "./container-card-ptc.js";
import { SecretEnvEditor } from "./container-card-secrets.js";
import { DialogGroup, ImageRow, LockGlyph } from "./container-card-shared.js";
import { FIELD_CLASS } from "./container-card-field-styles.js";
import { type DirectoryPickerFace } from "./directory-picker.js";
import { hint } from "./container-card-styles.js";
import { type Translate, type Translation } from "./locales.js";
import { Input } from "@deepseek-ai/dsh-client-ui-primitives";
import { type ReactNode, useCallback, useEffect, useId, useState } from "react";

// The body column: one DialogGroup per field group — and the image row, which
// is a field group of its own and labels itself — the same 20px apart in every
// dialog, so only the groups themselves decide how tall the body is.
const dialogBody: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "20px",
};

// The container's name: the value being typed and the wording of the rule it
// still breaks while a container is being named, or a container's own identity —
// read-only — where it already exists.
export interface ContainerNameDraft {
  value: string;
  error: string;
  // Whether the name is the container's fixed identity (the workspace's default
  // container, or a live container in Edit) instead of a value being chosen.
  readOnly: boolean;
  // Whether a command in flight blocks the editable field.
  disabled: boolean;
  // Absent where the name cannot be edited.
  onChange?: (name: string) => void;
}

export function ContainerForm(props: {
  t: Translate;
  image: string;
  env: Record<string, string>;
  mounts: readonly MountInput[];
  paths: readonly string[];
  secretEnv: Record<string, string>;
  ports: readonly PortConfig[];
  images: readonly ImageView[];
  volumes: readonly { name: string }[];
  secrets: readonly { name: string }[];
  busy: boolean;
  // Whether the fields may be edited at all.
  enabled: boolean;
  canPublish: boolean;
  // Whether the snapshot knows the port-publishing gateway is missing or
  // incompatible, so the Published ports group says so instead of staging a
  // port that cannot be published.
  gatewayUnavailable: boolean;
  writable: boolean;
  projectsRoot: string;
  directoryPicker?: DirectoryPickerFace;
  // The workspace's own project mount, listed first by the editor.
  mainProject: string;
  // The default container's primary project mount, which cannot be removed.
  primaryProject?: string;
  // Whether removing a mount asks for confirmation; only a live container has
  // something to recreate behind it.
  confirmRemoveMount?: boolean;
  onCreateVolume: (name: string) => Promise<boolean>;
  onCreateSecret: (
    name: string,
    length?: number,
    charset?: string,
  ) => Promise<boolean>;
  onChangeImage: (image: string) => void;
  onChangeEnv: (env: Record<string, string>) => void;
  onChangeMounts: (mounts: MountInput[]) => void;
  onChangePaths: (paths: string[]) => void;
  onChangeSecretEnv: (secretEnv: Record<string, string>) => void;
  onChangePorts: (ports: PortConfig[]) => void;
  // The Name group every dialog opens on: editable while a container is being
  // named, read-only where the name already exists (the workspace's default
  // container, and a live container in Edit).
  name: ContainerNameDraft;
  // Reports the message the first conflicting row raises — an empty key, or a
  // name used twice across both groups — or undefined once none blocks it, so
  // the dialog disables its own action and names the reason in its footer.
  onBlockingError?: (error: Translation | undefined) => void;
}): ReactNode {
  const {
    t,
    image,
    env,
    mounts,
    paths,
    secretEnv,
    ports,
    images,
    volumes,
    secrets,
    busy,
    enabled,
    canPublish,
    gatewayUnavailable,
    writable,
    projectsRoot,
    directoryPicker,
    mainProject,
    primaryProject,
    confirmRemoveMount,
    onCreateVolume,
    onCreateSecret,
    onChangeImage,
    onChangeEnv,
    onChangeMounts,
    onChangePaths,
    onChangeSecretEnv,
    onChangePorts,
    name,
    onBlockingError,
  } = props;
  const nameId = useId();
  // The two variable editors report their own appended row here; the form keeps
  // both so the first one names the reason, and bubbles it to the dialog's
  // footer action. A refused mount destination is folded in from the mounts
  // below, so the same footer refuses the action too.
  const [blocking, setBlocking] = useState<{
    env?: Translation;
    secretEnv?: Translation;
  }>({});
  const reportEnv = useCallback((error: Translation | undefined) => {
    setBlocking((current) =>
      current.env === error ? current : { ...current, env: error }
    );
  }, []);
  const reportSecretEnv = useCallback(
    (error: Translation | undefined) => {
      setBlocking((current) =>
        current.secretEnv === error ? current : { ...current, secretEnv: error }
      );
    },
    [],
  );
  // A volume, secret or tmpfs row's destination is validated from the form's
  // current mounts, so the row error and the footer reason never disagree. A
  // project mount derives its destination and is exempt.
  const reportMountError = useCallback(
    (mount: MountInput): string | undefined => {
      const error = nonProjectDestinationError(
        mount.kind,
        mount.destination,
        projectsRoot,
      );
      return error === undefined ? undefined : t(error.key, error.params);
    },
    [projectsRoot, t],
  );
  // The first refused destination names the footer reason only when no variable
  // editor already does: fixing the destination must not clear — or be hidden by
  // — another field's blocking error.
  const mountDestinationBlocking = firstMountDestinationError(
    mounts,
    projectsRoot,
  );
  const blockingKey = blocking.env ?? blocking.secretEnv ??
    mountDestinationBlocking;
  useEffect(() => {
    onBlockingError?.(blockingKey);
    return () => onBlockingError?.(undefined);
  }, [blockingKey, onBlockingError]);
  // The variable names each editor holds — every named row and the unnamed row
  // it is still filling in. The form keeps both lists so each group sees the
  // other's rows as they are typed: a name used in both groups is a duplicate
  // before either row is applied.
  const [rowNames, setRowNames] = useState<{
    env: readonly string[];
    secretEnv: readonly string[];
  }>(() => ({ env: Object.keys(env), secretEnv: Object.keys(secretEnv) }));
  const reportEnvNames = useCallback((names: readonly string[]) => {
    setRowNames((current) =>
      current.env === names ? current : { ...current, env: names }
    );
  }, []);
  const reportSecretEnvNames = useCallback((names: readonly string[]) => {
    setRowNames((current) =>
      current.secretEnv === names ? current : { ...current, secretEnv: names }
    );
  }, []);
  // The candidate images in the order the Images tab lists them: base images
  // first, custom ones after, and never the reserved PTC image the orchestrator
  // owns. An image the snapshot no longer lists stays selectable rather than
  // silently replaced by the first candidate, so a container already running
  // the PTC image keeps showing it as its current value.
  const offered = buildParentImages(images);
  const candidates = [
    ...offered.filter((candidate) => candidate.isBase),
    ...offered.filter((candidate) => !candidate.isBase),
  ].map((candidate) => candidate.imageId);
  return (
    <div style={dialogBody}>
      <DialogGroup title={t("containerName")}>
        <Input
          id={nameId}
          // A container's fixed identity sits on the read-only field's own
          // surface, so the dialog shows it is not a value being chosen.
          className={name.readOnly ? FIELD_CLASS : undefined}
          icon={name.readOnly ? <LockGlyph /> : undefined}
          value={name.value}
          readOnly={name.readOnly}
          disabled={name.disabled}
          aria-label={t("containerName")}
          onChange={(event) => name.onChange?.(event.target.value)}
        />
        {name.error === ""
          ? null
          : (
            <p style={{ ...hint, margin: 0 }} role="alert">
              {name.error}
            </p>
          )}
      </DialogGroup>
      {
        /* The image is one field, so its own row labels it, exactly as the
          container block renders it; wrapping it in a group heading would say
          "Image" twice. */
      }
      <ImageRow
        t={t}
        mode="edit"
        image={image}
        candidates={candidates}
        disabled={!enabled}
        onChange={onChangeImage}
      />
      <DialogGroup title={t("envTitle")}>
        <EnvEditor
          t={t}
          env={env}
          busy={busy}
          onChange={onChangeEnv}
          onBlockingError={reportEnv}
          otherNames={rowNames.secretEnv}
          onNames={reportEnvNames}
        />
      </DialogGroup>
      <DialogGroup title={t("mountsTitle")}>
        <MountsEditor
          t={t}
          mounts={mounts}
          volumes={volumes}
          secrets={secrets}
          busy={busy}
          enabled={enabled}
          writable={writable}
          projectsRoot={projectsRoot}
          directoryPicker={directoryPicker}
          confirmRemove={confirmRemoveMount}
          primaryProject={primaryProject}
          mainProject={mainProject}
          rowError={reportMountError}
          onCreateVolume={onCreateVolume}
          onCreateSecret={onCreateSecret}
          onAdd={(mount) => onChangeMounts([...mounts, mount])}
          onRemove={(mount) =>
            onChangeMounts(mounts.filter((item) => item !== mount))}
          onUpdate={(mount, index) =>
            onChangeMounts(
              mounts.map((item, at) => (at === index ? mount : item)),
            )}
        />
      </DialogGroup>
      <DialogGroup title={t("pathsTitle")}>
        <PathsEditor
          t={t}
          paths={paths}
          busy={busy}
          enabled={enabled}
          onApply={onChangePaths}
        />
      </DialogGroup>
      <DialogGroup title={t("containerSecretsTitle")}>
        <SecretEnvEditor
          t={t}
          secretEnv={secretEnv}
          secrets={secrets}
          busy={busy}
          enabled={enabled}
          writable={writable}
          onCreateSecret={onCreateSecret}
          onChange={onChangeSecretEnv}
          onBlockingError={reportSecretEnv}
          otherNames={rowNames.env}
          onNames={reportSecretEnvNames}
        />
      </DialogGroup>
      <DialogGroup title={t("portsTitle")}>
        <PortsEditor
          t={t}
          ports={ports}
          busy={busy}
          enabled={enabled}
          canPublish={canPublish}
          gatewayUnavailable={gatewayUnavailable}
          onChange={onChangePorts}
        />
      </DialogGroup>
    </div>
  );
}
