// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// The container edit dialog: the whole configuration one container holds — its
// read-only name, image, environment, mounts, PATH variable additions, secret
// environment variables and published ports — in one readable surface. It is a
// pure view over the row's own draft: Discard drops it, and the dialog's one
// primary action applies it, confirmed first, naming the container. That action
// says what it does: it recreates the container when the change rebuilds it,
// and updates the running container otherwise. The row keeps the draft, so
// closing the dialog loses nothing. The shell is the shared ContainerDialog and
// the body is the shared ContainerForm, so the dialog stays the same shape as
// the Add and Create dialogs; the staged marker is the one thing it adds to
// their footer.

import { type ContainerConfig } from "./container-card-config.js";
import {
  type ContainerView,
  type ImageView,
} from "./container-card-controller.js";
import { ContainerDialog } from "./container-card-dialog.js";
import { ContainerForm } from "./container-card-form.js";
import { type DirectoryPickerFace } from "./directory-picker.js";
import { ConfirmButton } from "./container-card-shared.js";
import { type Translate, type Translation } from "./locales.js";
import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import { type ReactNode } from "react";

export function ContainerEditModal(props: {
  t: Translate;
  open: boolean;
  container: ContainerView;
  images: readonly ImageView[];
  volumes: readonly { name: string }[];
  secrets: readonly { name: string }[];
  // Whether a command on this very container is in flight.
  busy: boolean;
  // Whether the container's fields may be edited at all.
  enabled: boolean;
  // Whether the container has a usable identity, which the recreate needs.
  usable: boolean;
  canPublish: boolean;
  gatewayUnavailable: boolean;
  projectName: string;
  projectsRoot: string;
  directoryPicker?: DirectoryPickerFace;
  writable: boolean;
  // The row's draft and staged copy, so the dialog cannot drift from the row.
  draft: ContainerConfig;
  // Whether the draft differs from the staged copy.
  dirty: boolean;
  // Whether the staged copy differs from the live container (a change the host
  // has not confirmed yet, e.g. an apply that was refused).
  pending: boolean;
  // The staged marker, naming the field groups the draft changes.
  marker?: string;
  // Whether the marker names a blocking problem instead, which refuses the one
  // action until the appended row is filled or removed.
  markerError?: boolean;
  // The blocking message the editors report, forwarded to the form's footer.
  onBlockingError?: (error: Translation | undefined) => void;
  // Whether applying the draft rebuilds the container, which is what the one
  // primary action's label and tone say.
  rebuilds: boolean;
  recreatePending: boolean;
  onCreateSecret: (name: string, length?: number, charset?: string) => void;
  onChange: (draft: ContainerConfig) => void;
  onDiscard: () => void;
  onApply: () => void;
  onClose: () => void;
}): ReactNode {
  const {
    t,
    open,
    container,
    images,
    volumes,
    secrets,
    busy,
    enabled,
    usable,
    canPublish,
    gatewayUnavailable,
    projectName,
    projectsRoot,
    directoryPicker,
    writable,
    draft,
    dirty,
    pending,
    marker,
    markerError,
    onBlockingError,
    rebuilds,
    recreatePending,
    onCreateSecret,
    onChange,
    onDiscard,
    onApply,
    onClose,
  } = props;
  // The one primary action names what it does: a change that rebuilds the
  // container reads as a destructive recreate, and one the running container
  // takes on its own reads as an update.
  const applyLabel = rebuilds ? t("recreateContainer") : t("updateContainer");
  return (
    <ContainerDialog
      t={t}
      open={open}
      title={t("editContainerTitle")}
      onClose={onClose}
      marker={marker}
      markerError={markerError}
      actions={
        <>
          <Button
            variant="ghost"
            size="sm"
            disabled={!enabled || (!dirty && !pending)}
            onClick={onDiscard}
          >
            {t("discard")}
          </Button>
          <ConfirmButton
            t={t}
            label={applyLabel}
            variant={rebuilds ? "outline" : "primary"}
            destructive={rebuilds}
            title={rebuilds ? t("recreate") : t("updateContainer")}
            description={rebuilds
              ? t("confirmRecreate", {
                workspace: projectName,
                container: container.containerName,
              })
              : t("confirmUpdate", {
                workspace: projectName,
                container: container.containerName,
              })}
            confirmLabel={applyLabel}
            disabled={!usable || marker === undefined || markerError === true}
            pending={recreatePending || busy}
            onConfirm={onApply}
          />
        </>
      }
    >
      <ContainerForm
        t={t}
        image={draft.image}
        env={draft.env}
        mounts={draft.mounts}
        paths={draft.paths}
        secretEnv={draft.secretEnv}
        ports={draft.ports}
        images={images}
        volumes={volumes}
        secrets={secrets}
        busy={busy}
        enabled={enabled}
        canPublish={canPublish}
        gatewayUnavailable={gatewayUnavailable}
        writable={writable}
        projectsRoot={projectsRoot}
        directoryPicker={directoryPicker}
        mainProject={projectName}
        primaryProject={container.containerName === "default"
          ? projectName
          : ""}
        confirmRemoveMount
        onCreateSecret={onCreateSecret}
        onChangeImage={(image) => onChange({ ...draft, image })}
        onChangeEnv={(env) => onChange({ ...draft, env })}
        onChangeMounts={(mounts) => onChange({ ...draft, mounts })}
        onChangePaths={(paths) => onChange({ ...draft, paths })}
        onChangeSecretEnv={(secretEnv) => onChange({ ...draft, secretEnv })}
        onChangePorts={(ports) => onChange({ ...draft, ports })}
        onBlockingError={onBlockingError}
        name={{
          /* A container's name is its identity, so the group states it. */
          value: container.containerName,
          error: "",
          readOnly: true,
          disabled: false,
        }}
      />
    </ContainerDialog>
  );
}
