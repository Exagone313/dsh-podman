// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// The Defaults tab: the image and the environment every new container starts
// from, plus the one action that applies the environment to existing
// containers. All of it is one card with one Save and one Discard, so a default
// image and a default variable are committed together or not at all.

import { EnvEditor } from "./container-card-editors.js";
import { COMPACT_DIALOG_CLASS } from "./container-card-dialog-styles.js";
import { CardGroup } from "./container-card-group.js";
import { CopyField, countLabel, Field } from "./container-card-shared.js";
import { TABLE_CARD_CLASS } from "./container-card-table-styles.js";
import {
  actionRow,
  dirtyBadgeSlot,
  editorGroup,
  editorTitle,
  emphasisAction,
  envFieldLabel,
  envRow,
  fieldSelect,
  footerStack,
  hint,
  rowActions,
  rowMain,
} from "./container-card-styles.js";
import {
  type ContainerView,
  type ImageView,
  type WorkspaceView,
} from "./container-card-controller.js";
import {
  commitIdentityAction,
  missingDefaultEnv,
  readGitIdentity,
  setGitIdentity,
} from "../container-env.js";
import type { Translate } from "./locales.js";
import { Button, Input, Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import { type ReactNode, useEffect, useId, useState } from "react";

export function DefaultsSection(props: {
  t: Translate;
  images: readonly ImageView[];
  defaultImage: string;
  env: Record<string, string>;
  workspaces: readonly WorkspaceView[];
  containers: readonly ContainerView[];
  busy: boolean;
  writable: boolean;
  onSetDefaultImage: (name: string) => void;
  onSaveEnv: (env: Record<string, string>) => void;
  onApplyDefaultEnv: (workspace: string) => void;
}): ReactNode {
  const {
    t,
    images,
    defaultImage,
    env,
    workspaces,
    containers,
    busy,
    writable,
    onSetDefaultImage,
    onSaveEnv,
    onApplyDefaultEnv,
  } = props;
  // One draft holds both defaults: the image and the environment. Either Save
  // commits them, either Discard drops them.
  const [image, setImage] = useState(defaultImage);
  const [envDraft, setEnvDraft] = useState<Record<string, string>>(env);
  const [gitOpen, setGitOpen] = useState(false);
  const [gitName, setGitName] = useState("");
  const [gitEmail, setGitEmail] = useState("");
  // The apply dialog's target: "" applies to every container, a workspace slug
  // narrows it to that workspace's containers.
  const [syncOpen, setSyncOpen] = useState(false);
  const [syncTarget, setSyncTarget] = useState("");
  const imageId = useId();
  const gitNameId = useId();
  const gitEmailId = useId();
  const syncTargetId = useId();
  // An external settings change resyncs its half of the draft; an unrelated
  // refresh does not, so an edit in progress is never clobbered.
  useEffect(() => {
    setImage(defaultImage);
  }, [defaultImage]);
  const serverEnv = JSON.stringify(env);
  useEffect(() => {
    setEnvDraft(env);
  }, [serverEnv]);
  const imageDirty = image !== defaultImage;
  const envDirty = JSON.stringify(envDraft) !== serverEnv;
  const dirty = imageDirty || envDirty;
  const disabled = busy || !writable;
  const candidates = [
    ...images.filter((candidate) => candidate.isBase),
    ...images.filter((candidate) => !candidate.isBase),
  ].map((candidate) => candidate.imageId);
  // With no explicit default, the host falls back to the first base image
  // (archlinux in the shipped catalog), so the card shows that effective default
  // rather than an empty field. The snapshot's base images come in the
  // catalog's own listing order, which is what the host resolves.
  const baseImages = images.filter((candidate) => candidate.isBase);
  const explicitDefault = defaultImage !== "";
  const effectiveDefault = explicitDefault
    ? defaultImage
    : baseImages[0]?.imageId ?? "";
  // The value the select shows: the draft, or the effective default while the
  // draft is still empty. Reading the effective default here (instead of
  // rendering a second option for it) is what keeps a single copy of it in the
  // option list.
  const selected = image === "" ? effectiveDefault : image;
  const save = (): void => {
    if (imageDirty) onSetDefaultImage(image);
    if (envDirty) onSaveEnv(envDraft);
  };
  const discard = (): void => {
    setImage(defaultImage);
    setEnvDraft(env);
  };
  // The identity popup applies into the same draft, so the card's Save stays
  // the single commit; when it restores the persisted environment exactly, its
  // pending change is dropped instead of left as a no-op edit.
  const commitIdentity = (next: Record<string, string>): void => {
    const action = commitIdentityAction(env, envDraft, next);
    setEnvDraft(action === "discard" ? env : next);
  };
  const openGit = (): void => {
    const identity = readGitIdentity(envDraft);
    setGitName(identity.name);
    setGitEmail(identity.email);
    setGitOpen(true);
  };
  // The sync dialog only offers the workspaces that hold a container.
  const containersByWorkspace = new Map<string, number>();
  for (const container of containers) {
    containersByWorkspace.set(
      container.workspaceSlug,
      (containersByWorkspace.get(container.workspaceSlug) ?? 0) + 1,
    );
  }
  const targetWorkspaces = workspaces.filter((workspace) =>
    (containersByWorkspace.get(workspace.workspaceSlug) ?? 0) > 0
  );
  // What the chosen target still lacks: a default is listed when at least one
  // targeted container does not carry it, and only a container missing
  // something is counted, so the dialog names exactly what the sync would add.
  const targetContainers = syncTarget === ""
    ? containers
    : containers.filter((container) => container.workspaceSlug === syncTarget);
  const missingByContainer = targetContainers.map((container) =>
    missingDefaultEnv(env, container.env)
  );
  const missingVars = Object.keys(env)
    .filter((key) =>
      missingByContainer.some((missing) => missing[key] !== undefined)
    )
    .map((key) => [key, env[key]] as const);
  const targetCount = missingByContainer.filter(
    (missing) => Object.keys(missing).length > 0,
  ).length;
  const openSync = (): void => {
    setSyncTarget("");
    setSyncOpen(true);
  };
  return (
    <CardGroup
      title={t("groupDefaultsTitle")}
      summary=""
      // The default image and the environment are always shown, so the card
      // always has content.
      hasContent
      // The card is the containment context the environment rows' narrow layout
      // keys off, the same one the tables use.
      className={TABLE_CARD_CLASS}
    >
      <div style={editorGroup}>
        <label htmlFor={imageId} style={envFieldLabel}>
          {t("defaultImage")}
        </label>
        <select
          id={imageId}
          // A form field, not a toolbar control: it fills the card so a long
          // image id is never clipped.
          style={{ ...fieldSelect, maxWidth: "none" }}
          value={selected}
          disabled={disabled}
          onChange={(event) => setImage(event.target.value)}
        >
          {selected !== "" && candidates.includes(selected)
            ? null
            : (
              <option value={selected}>
                {selected === "" ? t("noDefaultImage") : selected}
              </option>
            )}
          {candidates.map((candidate) => (
            <option key={candidate} value={candidate}>
              {candidate}
            </option>
          ))}
        </select>
      </div>
      <div style={editorGroup}>
        {
          /* The Git identity popup edits the same draft as the editor below,
            so its button shares that editor's own title line. */
        }
        <div style={actionRow}>
          <div style={rowMain}>
            <h4 style={editorTitle}>{t("defaultEnvironment")}</h4>
          </div>
          <div style={rowActions}>
            <Button
              variant="outline"
              size="sm"
              disabled={disabled}
              // The identity popup is a recommended setup step rather than a
              // neutral control, so it carries the success state colour, the
              // same emphasis a completed recommendation uses.
              style={emphasisAction.success}
              onClick={openGit}
            >
              {t("gitIdentity")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              // Applying the defaults is a deliberate action rather than a
              // neutral one, so it carries the business state colour, the same
              // emphasis "Rebuild all images" uses.
              style={emphasisAction.business}
              onClick={openSync}
            >
              {t("addMissingVars")}
            </Button>
          </div>
        </div>
        <EnvEditor
          t={t}
          env={envDraft}
          busy={disabled}
          onChange={setEnvDraft}
        />
      </div>
      <div style={footerStack}>
        <div style={{ ...actionRow, justifyContent: "flex-end" }}>
          <div style={rowActions}>
            <Button
              variant="primary"
              size="sm"
              disabled={disabled || !dirty}
              onClick={save}
            >
              {t("save")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy || !dirty}
              onClick={discard}
            >
              {t("discard")}
            </Button>
          </div>
        </div>
        <span style={dirtyBadgeSlot}>
          {dirty ? t("unsavedChanges") : ""}
        </span>
      </div>
      <Modal
        open={gitOpen}
        onClose={() => setGitOpen(false)}
        title={t("gitIdentity")}
        closeLabel={t("cancel")}
        footer={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setGitOpen(false)}
            >
              {t("cancel")}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={busy || gitName === "" || gitEmail === ""}
              onClick={() => {
                commitIdentity(setGitIdentity(envDraft, gitName, gitEmail));
                setGitOpen(false);
              }}
            >
              {t("apply")}
            </Button>
          </>
        }
      >
        <div
          style={{ display: "flex", flexDirection: "column", gap: "12px" }}
        >
          <Field label={t("gitName")} htmlFor={gitNameId}>
            <Input
              id={gitNameId}
              value={gitName}
              disabled={busy}
              onChange={(event) => setGitName(event.target.value)}
            />
          </Field>
          <Field label={t("gitEmail")} htmlFor={gitEmailId}>
            <Input
              id={gitEmailId}
              value={gitEmail}
              disabled={busy}
              onChange={(event) => setGitEmail(event.target.value)}
            />
          </Field>
        </div>
      </Modal>
      <Modal
        open={syncOpen}
        onClose={() => setSyncOpen(false)}
        title={t("addMissingVars")}
        closeLabel={t("cancel")}
        className={COMPACT_DIALOG_CLASS}
        footer={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setSyncOpen(false)}
            >
              {t("cancel")}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={busy || missingVars.length === 0}
              onClick={() => {
                onApplyDefaultEnv(syncTarget);
                setSyncOpen(false);
              }}
            >
              {t("addMissingVarsApply", {
                containers: countLabel(
                  t,
                  targetCount,
                  "countContainerOne",
                  "countContainerMany",
                ),
              })}
            </Button>
          </>
        }
      >
        <div
          style={{ display: "flex", flexDirection: "column", gap: "12px" }}
        >
          <Field label={t("applyTo")} htmlFor={syncTargetId}>
            <select
              id={syncTargetId}
              style={fieldSelect}
              value={syncTarget}
              disabled={busy}
              onChange={(event) => setSyncTarget(event.target.value)}
            >
              <option value="">{t("allContainers")}</option>
              {targetWorkspaces.map((workspace) => (
                <option
                  key={workspace.workspaceSlug}
                  value={workspace.workspaceSlug}
                >
                  {workspace.projectName}
                </option>
              ))}
            </select>
          </Field>
          <div style={editorGroup}>
            <span style={envFieldLabel}>{t("variablesToAdd")}</span>
            {missingVars.length === 0
              ? <span style={{ ...hint, margin: 0 }}>{t("none")}</span>
              : (
                <ul
                  style={{
                    margin: 0,
                    padding: 0,
                    listStyle: "none",
                    display: "flex",
                    flexDirection: "column",
                    gap: "8px",
                  }}
                >
                  {missingVars.map(([key, value]) => (
                    <li key={key} style={envRow}>
                      <CopyField
                        t={t}
                        label={t("envKey")}
                        value={key}
                        copyLabel={t("copyEnvKey", { key })}
                      />
                      <CopyField
                        t={t}
                        label={t("envValue")}
                        value={value}
                        copyLabel={t("copyEnvValue", { key })}
                      />
                    </li>
                  ))}
                </ul>
              )}
          </div>
        </div>
      </Modal>
    </CardGroup>
  );
}
