// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// One workspace card in the Workspaces tab: the workspace's name, its one
// running/stopped status phrase, a copy button for its ID, its own actions, and
// its containers as stacked blocks. A workspace with no container still offers
// the one action that creates its default container, reads muted, and states the
// greyed zero it holds.

import { ContainerRow, CreateContainerModal } from "./container-card-row.js";
import {
  LoadTemplateModal,
  type TemplateActions,
  type TemplateResume,
} from "./container-card-templates.js";
import type { TemplateSource } from "./container-template-ui.js";
import { countLabel } from "./container-card-shared.js";
import { scopedActionKey } from "./card-protocol.js";
import {
  TABLE_CARD_CLASS,
  TABLE_CARD_CONTENT_CLASS,
} from "./container-card-table-styles.js";
import {
  actionRow,
  card,
  cardContent,
  cardList,
  cardTitle,
  destructiveAction,
  headerRule,
  rowActions,
  rowMain,
  rowName,
  statusMuted,
  templateAction,
  workspaceStatus,
} from "./container-card-styles.js";
import {
  type ContainerConfig,
  type ContainerCreateConfig,
  type ContainerView,
  type ImageView,
  type WorkspaceView,
} from "./container-card-controller.js";
import { type DirectoryPickerFace } from "./directory-picker.js";
import type { Translate } from "./locales.js";
import {
  Button,
  IconCheckOutlineRegular,
  IconCopyOutlineRegular,
  RiskConfirmation,
  Tooltip,
  writeClipboard,
} from "@deepseek-ai/dsh-client-ui-primitives";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";

// The workspace's ID, copied on demand instead of printed as a bare UUID: a
// discreet icon button whose tooltip names the action and whose check confirms
// the write.
function CopyWorkspaceId(props: { t: Translate; id: string }): ReactNode {
  const { t, id } = props;
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout>>();
  const copy = (): void => {
    void writeClipboard(id).then((ok) => {
      if (!ok) return;
      setCopied(true);
      if (resetTimer.current !== undefined) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setCopied(false), 1500);
    });
  };
  // The reset timer is cancelled on unmount, so it cannot fire against an
  // unmounted component.
  useEffect(
    () => () => {
      if (resetTimer.current !== undefined) clearTimeout(resetTimer.current);
    },
    [],
  );
  const label = copied ? t("copied") : t("copyWorkspaceId");
  return (
    <Tooltip label={label}>
      <Button
        variant="ghost"
        size="sm"
        icon={copied ? <IconCheckOutlineRegular /> : <IconCopyOutlineRegular />}
        aria-label={label}
        disabled={id === ""}
        onClick={copy}
      />
    </Tooltip>
  );
}

export function WorkspaceSection(props: {
  t: Translate;
  workspace: WorkspaceView;
  containers: readonly ContainerView[];
  images: readonly ImageView[];
  volumes: readonly { name: string }[];
  secrets: readonly { name: string }[];
  busy: boolean;
  writable: boolean;
  locale: string;
  pendingActions: readonly string[];
  defaultImage: string;
  // The workspace's default environment variables, seeded into a new
  // container's draft.
  defaultEnv: Record<string, string>;
  projectsRoot: string;
  directoryPicker?: DirectoryPickerFace;
  onRemove: (workspace: string, container: string) => void;
  // Recreate one container as it is, from the row's own action.
  onRecreate: (workspace: string, container: string, image: string) => void;
  onRemoveWorkspace: (workspace: string) => void;
  onCreate: (workspace: WorkspaceView, config?: ContainerCreateConfig) => void;
  // The storage creators the create and edit dialogs' mount rows open, shared
  // with the settings Storage tab.
  onCreateVolume: (name: string) => Promise<boolean>;
  onCreateSecret: (
    name: string,
    length?: number,
    charset?: string,
  ) => Promise<boolean>;
  onStartContainer: (
    workspace: WorkspaceView,
    container: string,
    config?: ContainerCreateConfig,
  ) => void;
  // Resolves whether every staged change was accepted, so a template-sourced
  // replace publishes its ports only after a successful Apply.
  onApplyContainerConfig: (
    workspace: string,
    container: string,
    base: ContainerConfig,
    next: ContainerConfig,
  ) => Promise<boolean>;
  // Whether the port-publishing gateway is known to be missing, forwarded to
  // each row.
  gatewayUnavailable: boolean;
  // The Load template popup's host operations.
  templateActions: TemplateActions;
  // The Images tab's own image controls, shared with the template popup so its
  // image card dispatches the same commands for an image that is not the
  // template's own.
  onBuildImage: (imageId: string, parent: string, packages: string[]) => void;
  onRebuildImage: (imageId: string) => void;
  onRebuildBaseImage: (name: string) => void;
  onPullBaseImage: (name: string) => void;
  // Refresh the live snapshot after a template build or apply.
  onReload: () => void;
  // An extra control appended to the header's action group. The sidebar panel
  // uses it for its settings action; the settings card passes nothing, so both
  // places render the same workspace header.
  extraAction?: ReactNode;
}): ReactNode {
  const {
    t,
    workspace,
    containers,
    images,
    volumes,
    secrets,
    busy,
    writable,
    locale,
    pendingActions,
    defaultImage,
    defaultEnv,
    projectsRoot,
    directoryPicker,
    onRemove,
    onRecreate,
    onRemoveWorkspace,
    onCreate,
    onCreateVolume,
    onCreateSecret,
    onStartContainer,
    onApplyContainerConfig,
    gatewayUnavailable,
    templateActions,
    onBuildImage,
    onRebuildImage,
    onRebuildBaseImage,
    onPullBaseImage,
    onReload,
    extraAction,
  } = props;
  const [createOpen, setCreateOpen] = useState<"default" | "named" | null>(
    null,
  );
  const [templateOpen, setTemplateOpen] = useState(false);
  // What the Load template popup's Continue handed the editor, kept while that
  // editor is open so its Back can reopen the popup's details step exactly as
  // the user left it. It is dropped when the popup closes or the flow applies.
  const [templateResume, setTemplateResume] = useState<TemplateResume | null>(
    null,
  );
  // A one-shot draft the Load template popup's Continue hands to the create or
  // edit editor; the editor saves nothing until its own Apply.
  const [createPrefill, setCreatePrefill] = useState<
    { name: string; config: ContainerConfig } | null
  >(null);
  const [editPrefill, setEditPrefill] = useState<
    {
      container: string;
      token: number;
      config: ContainerConfig;
      // The template a replace came from, whose ports are published after a
      // successful Apply; dropped once they have been.
      source?: TemplateSource;
    } | null
  >(null);
  const editToken = useRef(0);
  const [removeWorkspaceOpen, setRemoveWorkspaceOpen] = useState(false);
  const [removeWorkspaceAcknowledged, setRemoveWorkspaceAcknowledged] =
    useState(false);
  const headingId = useId();
  const removeWorkspacePending = pendingActions.includes(
    scopedActionKey("workspace_remove", workspace.workspaceSlug),
  );
  const hasContainer = containers.length > 0;
  // The header states one phrase: how many containers run and how many are
  // stopped, with the stopped half greyed, or the greyed zero when the
  // workspace holds nothing yet.
  const running = containers.filter(
    (container) => container.status === "running",
  ).length;
  const stopped = containers.length - running;
  return (
    <section
      style={card}
      className={TABLE_CARD_CLASS}
      aria-labelledby={headingId}
    >
      <div style={hasContainer ? { ...actionRow, ...headerRule } : actionRow}>
        <div style={rowMain}>
          <h3
            id={headingId}
            style={hasContainer ? { ...cardTitle, ...rowName } : {
              ...cardTitle,
              ...rowName,
              color: "var(--dsw-alias-label-tertiary)",
            }}
          >
            {workspace.projectName}
          </h3>
          <CopyWorkspaceId t={t} id={workspace.workspaceSlug} />
          <span
            style={hasContainer ? workspaceStatus : {
              ...workspaceStatus,
              ...statusMuted,
            }}
          >
            {running > 0
              ? countLabel(
                t,
                running,
                "countRunningContainerOne",
                "countRunningContainerMany",
              )
              : null}
            {running > 0 && stopped > 0 ? " · " : null}
            {stopped > 0
              ? (
                <span style={statusMuted}>
                  {countLabel(
                    t,
                    stopped,
                    "countStoppedContainerOne",
                    "countStoppedContainerMany",
                  )}
                </span>
              )
              : null}
            {hasContainer ? null : (
              <span style={statusMuted}>
                {countLabel(
                  t,
                  0,
                  "countContainerOne",
                  "countContainerMany",
                )}
              </span>
            )}
          </span>
        </div>
        <div style={rowActions}>
          <Button
            variant="primary"
            size="sm"
            disabled={busy}
            onClick={() => setCreateOpen(hasContainer ? "named" : "default")}
          >
            {hasContainer ? t("addContainer") : t("createContainer")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            style={templateAction}
            onClick={() => setTemplateOpen(true)}
          >
            {t("loadTemplate")}
          </Button>
          {
            /* A workspace that holds no container has nothing to remove, so
              the action is hidden rather than offered as a no-op. */
          }
          {hasContainer
            ? (
              <Button
                variant="outline"
                size="sm"
                disabled={removeWorkspacePending}
                style={destructiveAction}
                onClick={() => {
                  setRemoveWorkspaceAcknowledged(false);
                  setRemoveWorkspaceOpen(true);
                }}
              >
                {removeWorkspacePending ? t("busy") : t("removeWorkspace")}
              </Button>
            )
            : null}
          {extraAction}
        </div>
      </div>
      {hasContainer
        ? (
          <div className={TABLE_CARD_CONTENT_CLASS} style={cardContent}>
            <div style={cardList}>
              {containers.map((container, index) => (
                <ContainerRow
                  key={container.containerName}
                  t={t}
                  container={container}
                  images={images}
                  volumes={volumes}
                  secrets={secrets}
                  pendingActions={pendingActions}
                  locale={locale}
                  last={index === containers.length - 1}
                  writable={writable}
                  onRemove={onRemove}
                  onRecreate={onRecreate}
                  createVolume={onCreateVolume}
                  onCreateSecret={onCreateSecret}
                  onApplyContainerConfig={async (
                    workspace,
                    container,
                    base,
                    next,
                  ) => {
                    const applied = await onApplyContainerConfig(
                      workspace,
                      container,
                      base,
                      next,
                    );
                    const prefill = editPrefill;
                    if (
                      !applied || prefill === null ||
                      prefill.container !== container
                    ) {
                      return applied;
                    }
                    // The template flow is over once its draft applied, so a
                    // later Load template starts at the picker with a fresh
                    // draft rather than resuming this one.
                    setTemplateResume(null);
                    if (prefill.source === undefined) return applied;
                    // The editor is the one edit-apply path: ports are not in
                    // its draft, so the template's own are published here.
                    setEditPrefill((current) =>
                      current !== null && current.container === container
                        ? { ...current, source: undefined }
                        : current
                    );
                    await templateActions.publishTemplate({
                      op: "publish",
                      workspace,
                      container,
                      name: prefill.source.name,
                      yaml: prefill.source.yaml,
                    });
                    return applied;
                  }}
                  projectName={workspace.projectName}
                  projectsRoot={projectsRoot}
                  directoryPicker={directoryPicker}
                  gatewayUnavailable={gatewayUnavailable}
                  prefill={editPrefill !== null &&
                      editPrefill.container === container.containerName
                    ? { token: editPrefill.token, config: editPrefill.config }
                    : undefined}
                  forcedProject={editPrefill !== null &&
                      editPrefill.container === container.containerName &&
                      container.containerName === "default"
                    ? workspace.projectName
                    : undefined}
                  onEditBack={templateResume === null ? undefined : () => {
                    // Back drops the editor without applying, clears the
                    // one-shot prefill and reopens the popup on its recorded
                    // draft; the resume payload itself stays for that reopen.
                    setEditPrefill(null);
                    setTemplateOpen(true);
                  }}
                  onEditClosed={() => {
                    setEditPrefill(null);
                    setTemplateResume(null);
                  }}
                />
              ))}
            </div>
          </div>
        )
        : null}
      {
        /* Removing the workspace's containers is irreversible and takes the
          whole pod with it, so it is gated behind an explicit acknowledgement.
          The action is only offered when the workspace actually has one. */
      }
      <RiskConfirmation
        open={removeWorkspaceOpen}
        title={t("removeWorkspace")}
        description={t("confirmRemoveWorkspace", {
          workspace: workspace.projectName,
        })}
        acknowledgeLabel={t("acknowledgeRemoveWorkspace")}
        cancelLabel={t("cancel")}
        closeLabel={t("cancel")}
        confirmLabel={t("removeWorkspace")}
        acknowledged={removeWorkspaceAcknowledged}
        disabled={removeWorkspacePending}
        onAcknowledgedChange={setRemoveWorkspaceAcknowledged}
        onCancel={() => {
          setRemoveWorkspaceAcknowledged(false);
          setRemoveWorkspaceOpen(false);
        }}
        onConfirm={() => {
          setRemoveWorkspaceAcknowledged(false);
          setRemoveWorkspaceOpen(false);
          onRemoveWorkspace(workspace.workspaceSlug);
        }}
      />
      <LoadTemplateModal
        t={t}
        locale={locale}
        open={templateOpen}
        workspace={workspace}
        containers={containers}
        images={images}
        volumes={volumes}
        secrets={secrets}
        defaultEnv={defaultEnv}
        projectsRoot={projectsRoot}
        directoryPicker={directoryPicker}
        busy={busy}
        writable={writable}
        gatewayUnavailable={gatewayUnavailable}
        actions={templateActions}
        onBuildImage={onBuildImage}
        onRebuildImage={onRebuildImage}
        onRebuildBaseImage={onRebuildBaseImage}
        onPullBaseImage={onPullBaseImage}
        onCreateSecret={onCreateSecret}
        createVolume={onCreateVolume}
        onReload={onReload}
        resume={templateResume}
        onClose={() => {
          setTemplateOpen(false);
          setTemplateResume(null);
        }}
        onContinue={(mode, container, config, source, resume) => {
          setTemplateOpen(false);
          setTemplateResume(resume ?? null);
          if (mode === "create") {
            setCreateOpen(container === "default" ? "default" : "named");
            setCreatePrefill({
              name: container === "default" ? "" : container,
              config,
            });
          } else {
            editToken.current += 1;
            setEditPrefill({
              container,
              token: editToken.current,
              config,
              ...(source === undefined ? {} : { source }),
            });
          }
        }}
      />
      <CreateContainerModal
        t={t}
        workspace={workspace}
        images={images}
        volumes={volumes}
        secrets={secrets}
        busy={busy}
        writable={writable}
        defaultImage={defaultImage}
        defaultEnv={defaultEnv}
        projectsRoot={projectsRoot}
        directoryPicker={directoryPicker}
        named={createOpen === "named"}
        existing={containers.map((container) => container.containerName)}
        gatewayUnavailable={gatewayUnavailable}
        open={createOpen !== null}
        initial={createPrefill ?? undefined}
        forcedProject={createOpen === "default"
          ? workspace.projectName
          : undefined}
        onBack={templateResume === null || createPrefill === null
          ? undefined
          : () => {
            // Back drops the editor without creating anything and reopens the
            // popup on the draft Continue handed on.
            setCreateOpen(null);
            setCreatePrefill(null);
            setTemplateOpen(true);
          }}
        onClose={() => {
          setCreateOpen(null);
          setCreatePrefill(null);
          // Closing the editor ends the template flow, so its recorded draft
          // must not resurface on the next Load template.
          setTemplateResume(null);
        }}
        createVolume={onCreateVolume}
        onCreateSecret={onCreateSecret}
        onCreate={(container, config) => {
          if (createOpen === "named") {
            onStartContainer(workspace, container, config);
          } else {
            onCreate(workspace, config);
          }
          setCreateOpen(null);
          setCreatePrefill(null);
          setTemplateResume(null);
        }}
      />
    </section>
  );
}
