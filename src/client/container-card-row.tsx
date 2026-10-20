// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import {
  type ContainerView,
  type ImageView,
} from "./container-card-controller.js";
import { containerActionKey, containerActionPending } from "./card-protocol.js";
import {
  configChangedKeys,
  configGroupLabels,
  configRebuildsContainer,
  configsEqual,
  type ContainerConfig,
  containerConfigFrom,
} from "./container-card-config.js";
import { ContainerEditModal } from "./container-card-edit-modal.js";
import { type DirectoryPickerFace } from "./directory-picker.js";
import {
  ConfirmButton,
  containerStatusLabel,
  containerStatusTone,
  CopyButton,
  EnvRow,
  ImageRow,
  MountRow,
  mountViewToInput,
  orderedMounts,
  PathRow,
  PortRow,
  SecretEnvRow,
  StatusChip,
} from "./container-card-shared.js";
import {
  actionRow,
  blockFields,
  blockWrapper,
  cardBlockRow,
  cardTitle,
  fieldGroup,
  fieldGroupLabel,
  missingValue,
  rowActions,
  rowDivider,
  rowMain,
  rowMeta,
} from "./container-card-styles.js";
import { ROW_LIST_CLASS } from "./container-card-table-styles.js";
import { orderedEnvEntries } from "../env-rows.js";
import { relativeTimeLabel } from "./relative-time.js";
import { type Translate, type Translation } from "./locales.js";
import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import { type ReactNode, useEffect, useRef, useState } from "react";

// One labelled group of a container block: the group's own label above the rows
// it holds, so a long list only makes the block taller. A group with no rows at
// all renders nothing, so its label and gap never reserve empty height. It
// carries the shared list marker, so the narrow query separates its consecutive
// rows the way it does in the editor that changes the same list.
function FieldGroup(props: {
  label: string;
  children: ReactNode;
}): ReactNode {
  const { label, children } = props;
  if (children === null || children === undefined || children === false) {
    return null;
  }
  return (
    <div className={ROW_LIST_CLASS} style={fieldGroup}>
      <span style={fieldGroupLabel}>{label}</span>
      {children}
    </div>
  );
}

// The placeholder one empty list of a container block reads with.
function NoEntries(props: { t: Translate }): ReactNode {
  return <span style={missingValue}>{props.t("valueMissing")}</span>;
}

// One container of a workspace: a stacked block whose identity line is the
// name, its state chip, its age and its own Edit/Recreate/Remove actions,
// followed by one group per field in the canonical order — image, environment
// variables, mounts, PATH variable additions, secret environment variables and
// published ports, each entry with its own copyable fields. A long list only
// makes the block taller. Edit opens the dialog holding every editor; its one
// primary action applies the draft (rebuilding the container when the change
// reaches what it runs, updating it in place otherwise) and Discard drops it.
// Recreate rebuilds the container as it is, without touching the draft. The
// orchestrator-owned PTC container is rendered by its own card, never here.
export function ContainerRow(props: {
  t: Translate;
  container: ContainerView;
  images: readonly ImageView[];
  volumes: readonly { name: string }[];
  secrets: readonly { name: string }[];
  pendingActions: readonly string[];
  // The plugin's active locale, for the row's relative creation time.
  locale: string;
  // Whether this is the last block of its card, which omits the hairline.
  last: boolean;
  // Whether the container's secrets may be administered (the create-secret
  // affordance inside the edit dialog).
  writable: boolean;
  onRemove: (workspace: string, container: string) => void;
  // Recreate the container exactly as it is: the row's own action, with the
  // confirmation the staged apply already uses.
  onRecreate: (workspace: string, container: string, image: string) => void;
  onCreateSecret: (name: string, length?: number, charset?: string) => void;
  onApplyContainerConfig: (
    workspace: string,
    container: string,
    base: ContainerConfig,
    next: ContainerConfig,
  ) => void;
  // Whether the snapshot knows the port-publishing gateway is missing or
  // incompatible, so the editor can say so instead of failing on a dial.
  gatewayUnavailable: boolean;
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
    pendingActions,
    locale,
    last,
    writable,
    onRemove,
    onRecreate,
    onCreateSecret,
    onApplyContainerConfig,
    gatewayUnavailable,
    projectName,
    projectsRoot,
    directoryPicker,
  } = props;
  // The row edits one draft of the container's whole configuration and applies
  // it with the dialog's one primary action. The draft starts from the snapshot
  // and resyncs only while the user has nothing local, so a refresh never
  // clobbers an edit or a change being applied.
  const server = containerConfigFrom(container);
  const serverKey = JSON.stringify(server);
  const [draft, setDraft] = useState<ContainerConfig>(server);
  const [staged, setStaged] = useState<ContainerConfig>(server);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const stagedRef = useRef(staged);
  stagedRef.current = staged;
  const prevServerRef = useRef(server);
  useEffect(() => {
    const previous = prevServerRef.current;
    prevServerRef.current = server;
    const current = draftRef.current;
    const saved = stagedRef.current;
    // Adopt the snapshot when nothing is local, or when the staged copy is
    // exactly what just arrived (the apply succeeded); keep both otherwise.
    if (
      configsEqual(current, saved) &&
      (configsEqual(saved, previous) || configsEqual(saved, server))
    ) {
      setDraft(server);
      setStaged(server);
    }
  }, [serverKey]);
  const dirty = !configsEqual(draft, staged);
  const pending = !configsEqual(server, staged);
  // The draft's own changes, named by the dialog's staged marker and used to
  // tell whether applying it rebuilds the container or updates it in place.
  const changedKeys = configChangedKeys(server, draft);
  const stagedMarker = changedKeys.length === 0
    ? undefined
    : t("stagedChanges", {
      fields: changedKeys.map((id) => t(configGroupLabels[id])).join(", "),
    });
  // A row the editors flagged as conflicting — unnamed or named twice — refuses
  // the apply; the dialog's footer says why instead of naming the staged fields.
  const [blockingError, setBlockingError] = useState<Translation | undefined>(
    undefined,
  );
  const markerError = blockingError !== undefined;
  const marker = blockingError === undefined
    ? stagedMarker
    : t(blockingError.key, blockingError.params);
  const rebuilds = configRebuildsContainer(server, draft);
  const [open, setOpen] = useState(false);
  // The editors share the container-scoped commands, so any of them in flight
  // gates the whole row; the staged commands run from the apply action.
  const containerBusy = containerActionPending(
    pendingActions,
    container.workspaceSlug,
    container.containerName,
  );
  const usable = container.workspaceSlug !== "";
  const enabled = usable && !containerBusy;
  const removePending = pendingActions.includes(
    containerActionKey(
      "remove",
      container.workspaceSlug,
      container.containerName,
    ),
  );
  const recreatePending = pendingActions.includes(
    containerActionKey(
      "recreate",
      container.workspaceSlug,
      container.containerName,
    ),
  );
  // Publishing needs a live guest agent to create the forwarding socket, and a
  // running gateway to bind the host port; the editor reflects both.
  const canPublish = enabled && container.status === "running" &&
    !gatewayUnavailable;
  // What the row shows about the container: every value is its own read-only
  // field with its own copy control, never a merged string; a long list only
  // adds rows. The environment maps read in a fixed name order and the mounts in
  // the one shared order the editors use too.
  const envEntries = orderedEnvEntries(container.env);
  const secretEnvEntries = orderedEnvEntries(container.secretEnv);
  const mounts = orderedMounts(
    container.mounts.map(mountViewToInput),
    projectName,
  );
  // The dialog's one primary action stages the draft and applies it.
  const apply = (): void => {
    setStaged(draft);
    onApplyContainerConfig(
      container.workspaceSlug,
      container.containerName,
      server,
      draft,
    );
  };
  const discard = (): void => {
    if (dirty) setDraft(staged);
    else if (pending) {
      setDraft(server);
      setStaged(server);
    }
  };
  return (
    <>
      <div style={last ? cardBlockRow : { ...cardBlockRow, ...rowDivider }}>
        <div style={blockWrapper}>
          {
            /* The identity line carries the name, the state, the age and the
              row's own actions: the fields below all read after it. The name
              wraps rather than truncating, so a long identifier only makes the
              line taller. */
          }
          <div style={actionRow}>
            <div style={rowMain}>
              <h4 style={{ ...cardTitle, overflowWrap: "anywhere" }}>
                {container.containerName}
              </h4>
              <StatusChip
                tone={containerStatusTone(container.status)}
                label={containerStatusLabel(t, container.status)}
              />
              <span style={rowMeta} title={container.createdAt}>
                {relativeTimeLabel(container.createdAt, locale)}
              </span>
              <CopyButton
                t={t}
                value={container.createdAt}
                label={t("copyCreated")}
              />
            </div>
            {
              /* Edit, Recreate and Remove share the name's line, at its right
                end while the block has room and below the name once it does
                not. */
            }
            <div style={rowActions}>
              <Button
                variant="outline"
                size="sm"
                disabled={!usable}
                onClick={() => setOpen(true)}
              >
                {t("edit")}
              </Button>
              <ConfirmButton
                t={t}
                emphasis="business"
                label={t("recreate")}
                title={t("recreate")}
                description={t("confirmRecreate", {
                  workspace: projectName,
                  container: container.containerName,
                })}
                confirmLabel={t("recreate")}
                disabled={!usable || containerBusy}
                pending={recreatePending}
                onConfirm={() =>
                  onRecreate(
                    container.workspaceSlug,
                    container.containerName,
                    container.imageId,
                  )}
              />
              <ConfirmButton
                t={t}
                destructive
                label={t("remove")}
                title={t("removeContainerTitle")}
                description={t("confirmRemoveContainer", {
                  workspace: projectName,
                  container: container.containerName,
                })}
                confirmLabel={t("removeContainerTitle")}
                disabled={!usable}
                pending={removePending}
                onConfirm={() =>
                  onRemove(
                    container.workspaceSlug,
                    container.containerName,
                  )}
              />
            </div>
          </div>
          <div style={blockFields}>
            <ImageRow t={t} mode="view" image={container.imageId} />
            <FieldGroup label={t("envTitle")}>
              {envEntries.length === 0
                ? <NoEntries t={t} />
                : envEntries.map(([name, value]) => (
                  <EnvRow
                    key={name}
                    t={t}
                    mode="view"
                    name={name}
                    value={value}
                  />
                ))}
            </FieldGroup>
            <FieldGroup label={t("mountsTitle")}>
              {mounts.length === 0
                ? <NoEntries t={t} />
                : mounts.map(({ mount, index }) => (
                  // Mounts carry no id and duplicates are legal, so the
                  // positional index is the only collision-free key here. The
                  // index also names the snapshot view the row reads its
                  // destination from.
                  <MountRow
                    key={index}
                    t={t}
                    mode="view"
                    mount={mount}
                    destination={container.mounts[index]?.destination ??
                      ""}
                  />
                ))}
            </FieldGroup>
            <FieldGroup label={t("pathsTitle")}>
              {container.paths.length === 0
                ? <NoEntries t={t} />
                : container.paths.map((path, index) => (
                  // A PATH list carries no id and duplicates are legal, so the
                  // positional index is the only collision-free key here.
                  <PathRow key={index} t={t} mode="view" path={path} />
                ))}
            </FieldGroup>
            <FieldGroup label={t("containerSecretsTitle")}>
              {secretEnvEntries.length === 0
                ? <NoEntries t={t} />
                : secretEnvEntries.map(([name, value]) => (
                  <SecretEnvRow
                    key={name}
                    t={t}
                    mode="view"
                    name={name}
                    secret={value}
                  />
                ))}
            </FieldGroup>
            <FieldGroup label={t("portsTitle")}>
              {container.publishedPorts.length === 0
                ? <NoEntries t={t} />
                : container.publishedPorts.map((port) => (
                  <PortRow
                    key={`${port.protocol}/${port.port}`}
                    t={t}
                    mode="view"
                    port={port.port}
                    protocol={port.protocol}
                    hostPort={port.hostPort}
                  />
                ))}
            </FieldGroup>
          </div>
        </div>
      </div>
      <ContainerEditModal
        t={t}
        open={open}
        container={container}
        images={images}
        volumes={volumes}
        secrets={secrets}
        busy={containerBusy}
        enabled={enabled}
        usable={usable}
        canPublish={canPublish}
        gatewayUnavailable={gatewayUnavailable}
        projectName={projectName}
        projectsRoot={projectsRoot}
        directoryPicker={directoryPicker}
        writable={writable}
        draft={draft}
        dirty={dirty}
        pending={pending}
        marker={marker}
        markerError={markerError}
        onBlockingError={setBlockingError}
        rebuilds={rebuilds}
        recreatePending={recreatePending}
        onCreateSecret={onCreateSecret}
        onChange={setDraft}
        onDiscard={discard}
        onApply={apply}
        onClose={() => setOpen(false)}
      />
    </>
  );
}

export { CreateContainerModal } from "./container-card-create-modal.js";
