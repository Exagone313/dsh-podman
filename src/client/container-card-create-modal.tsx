// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import {
  type ContainerCreateConfig,
  type ImageView,
  type MountInput,
  type WorkspaceView,
} from "./container-card-controller.js";
import { configsEqual, type ContainerConfig } from "./container-card-config.js";
import { ContainerDialog } from "./container-card-dialog.js";
import { ContainerForm } from "./container-card-form.js";
import { type DirectoryPickerFace } from "./directory-picker.js";
import { DiscardChangesModal, namePattern } from "./container-card-shared.js";
import {
  DEFAULT_CONTAINER_NAME,
  PTC_CONTAINER_NAME,
  reservedContainerName,
} from "./container-card-ptc.js";
import { mergeDefaultEnv } from "../container-env.js";
import { orderedEnvRecord } from "../env-rows.js";
import { type Translate, type Translation } from "./locales.js";
import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import { type ReactNode, useEffect, useRef, useState } from "react";

// The project mount every new container starts with; it is the pristine mount
// the draft is compared against for its dirty state.
function initialMounts(workspace: WorkspaceView): MountInput[] {
  return [
    {
      kind: "project",
      project: workspace.projectName,
      destination: "",
      mode: "read_write",
      volume: "",
      secret: "",
    },
  ];
}

// The draft an Add/Create dialog opens on: the workspace's image (or the
// configured default), its own project mount, and the workspace's default
// environment. The defaults are seeded so the values a new container inherits
// are visible: a value left alone keeps the default, and an edited one is sent
// as that container's own.
function initialConfig(
  workspace: WorkspaceView,
  defaultImage: string,
  defaultEnv: Record<string, string>,
): ContainerConfig {
  return {
    image: workspace.imageId || defaultImage,
    env: orderedEnvRecord(mergeDefaultEnv(defaultEnv, undefined)),
    mounts: initialMounts(workspace),
    paths: [],
    secretEnv: {},
    ports: [],
  };
}

export function CreateContainerModal(props: {
  t: Translate;
  workspace: WorkspaceView;
  images: readonly ImageView[];
  volumes: readonly { name: string }[];
  secrets: readonly { name: string }[];
  busy: boolean;
  writable: boolean;
  defaultImage: string;
  // The workspace's default environment variables, seeded into the draft so the
  // values a new container inherits are visible and editable.
  defaultEnv: Record<string, string>;
  projectsRoot: string;
  directoryPicker?: DirectoryPickerFace;
  named: boolean;
  existing: readonly string[];
  // Whether the snapshot knows the port-publishing gateway is missing or
  // incompatible, so the Published ports group says so instead of staging a
  // port that cannot be published.
  gatewayUnavailable: boolean;
  open: boolean;
  onClose: () => void;
  onCreateSecret: (name: string, length?: number, charset?: string) => void;
  onCreate: (container: string, config: ContainerCreateConfig) => void;
}): ReactNode {
  const {
    t,
    workspace,
    images,
    volumes,
    secrets,
    busy,
    writable,
    defaultImage,
    defaultEnv,
    projectsRoot,
    directoryPicker,
    named,
    existing,
    gatewayUnavailable,
    open,
    onClose,
    onCreateSecret,
    onCreate,
  } = props;
  const [draft, setDraft] = useState<ContainerConfig>(() =>
    initialConfig(workspace, defaultImage, defaultEnv)
  );
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  // A row the editors flagged as conflicting — unnamed or named twice — refuses
  // the create; the footer says why until it is fixed or removed.
  const [blockingError, setBlockingError] = useState<Translation | undefined>(
    undefined,
  );
  // The dialog owns one draft for as long as it stays open. A snapshot refresh
  // (a command settling, a secret created on top of this dialog) hands down new
  // workspace and image objects, and adopting them then would drop every field
  // the user has already typed; the draft is reset when the dialog opens, and
  // only then.
  const initialized = useRef(false);
  useEffect(() => {
    if (!open) {
      initialized.current = false;
      return;
    }
    if (initialized.current) return;
    initialized.current = true;
    setDraft(initialConfig(workspace, defaultImage, defaultEnv));
    setName("");
    setSubmitting(false);
    setConfirmClose(false);
  }, [open, workspace, defaultImage, defaultEnv]);
  const pristine = initialConfig(workspace, defaultImage, defaultEnv);
  const reservedName = reservedContainerName(name);
  const nameTaken = existing.includes(name);
  const namePatternOk = namePattern.test(name);
  const nameValid = namePatternOk && reservedName === undefined && !nameTaken;
  // The name it already refuses: reserved (the default container's name or the
  // PTC container's), taken, or outside the allowed character set. Naming the
  // rule is what lets the user fix it in place.
  const nameError = name === ""
    ? ""
    : reservedName === DEFAULT_CONTAINER_NAME
    ? t("containerNameReserved")
    : reservedName === PTC_CONTAINER_NAME
    ? t("containerNamePtcReserved")
    : nameTaken
    ? t("containerNameTaken")
    : namePatternOk
    ? ""
    : t("invalidContainerName");
  const canCreate = !named || nameValid;
  // Anything typed or picked since the dialog opened makes closing lose the
  // draft, so the close is routed through the discard confirmation.
  const dirty = name !== "" || !configsEqual(draft, pristine);
  const requestClose = (): void => {
    if (dirty) setConfirmClose(true);
    else onClose();
  };
  const discardAndClose = (): void => {
    setConfirmClose(false);
    onClose();
  };
  const submit = (): void => {
    if (!canCreate || submitting) return;
    setSubmitting(true);
    onCreate(named ? name : "", {
      image: draft.image,
      env: draft.env,
      mounts: [...draft.mounts],
      paths: draft.paths.map((path) => path.trim()).filter((path) =>
        path !== ""
      ),
      secretEnv: draft.secretEnv,
      ports: [...draft.ports],
    });
  };
  return (
    <>
      <ContainerDialog
        t={t}
        open={open}
        title={named ? t("addContainer") : t("createContainer")}
        onClose={requestClose}
        marker={blockingError === undefined
          ? undefined
          : t(blockingError.key, blockingError.params)}
        markerError={blockingError !== undefined}
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={requestClose}
            >
              {t("cancel")}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={!canCreate || submitting || blockingError !== undefined}
              onClick={submit}
            >
              {named ? t("addContainer") : t("createContainer")}
            </Button>
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
          enabled={!busy}
          canPublish={!busy && !gatewayUnavailable}
          gatewayUnavailable={gatewayUnavailable}
          writable={writable}
          projectsRoot={projectsRoot}
          directoryPicker={directoryPicker}
          mainProject={workspace.projectName}
          // The workspace's default container always keeps its main project
          // mount, so Create greys out its Remove; a named container (Add) keeps
          // the mounts it was given, the seeded project one included.
          primaryProject={named ? "" : workspace.projectName}
          onCreateSecret={onCreateSecret}
          onChangeImage={(image) => setDraft({ ...draft, image })}
          onChangeEnv={(env) => setDraft({ ...draft, env })}
          onChangeMounts={(mounts) => setDraft({ ...draft, mounts })}
          onChangePaths={(paths) => setDraft({ ...draft, paths })}
          onChangeSecretEnv={(secretEnv) => setDraft({ ...draft, secretEnv })}
          onChangePorts={(ports) => setDraft({ ...draft, ports })}
          onBlockingError={setBlockingError}
          name={named
            ? {
              value: name,
              error: nameError,
              readOnly: false,
              disabled: busy,
              onChange: setName,
            }
            : {
              /* The workspace's default container is created under its one
                 reserved name, so the group states it instead of offering it. */
              value: DEFAULT_CONTAINER_NAME,
              error: "",
              readOnly: true,
              disabled: false,
            }}
        />
      </ContainerDialog>
      <DiscardChangesModal
        t={t}
        open={confirmClose}
        onCancel={() => setConfirmClose(false)}
        onDiscard={discardAndClose}
      />
    </>
  );
}
