// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { ConfirmButton, emptyMount, Field, mountLabel } from "./container-card-shared.js";
import { greyId, imageSelect } from "./container-card-styles.js";
import { type MountInput } from "./container-card-controller.js";
import { DirectoryPickerModal } from "./container-card-directory.js";
import { type DirectoryPickerFace } from "./directory-picker.js";
import { forcedMountMode } from "../mount-enums.js";
import {
  commitEnvDraft,
  emptyEnvDraft,
  type EnvDraft,
  envRows,
  removeEnvRow,
  renameEnvKey,
  setEnvValue,
} from "../env-rows.js";
import { hostPathForProjectName, projectNameFromHostPath } from "../project-path.js";
import { type ContainerPluginKey } from "./locales.js";
import { Button, Input, Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import { type ReactNode, useId, useRef, useState } from "react";

// One stable key per env row, so renaming a variable does not remount the row
// and drop focus mid-keystroke. The parent keeps env as a record; rows are
// positional, so the id list is aligned by index.
let nextEnvId = 0;

export function EnvEditor(props: {
  t: (key: ContainerPluginKey) => string;
  env: Record<string, string>;
  busy: boolean;
  onChange: (env: Record<string, string>) => void;
}): ReactNode {
  const { t, env, busy, onChange } = props;
  // The row being typed: it becomes a record entry only once its key is a real,
  // unused variable name, so an abandoned Add cannot apply a placeholder.
  const [draft, setDraft] = useState<EnvDraft | undefined>(undefined);
  const rows = envRows(env, draft);
  const idsRef = useRef<number[]>([]);
  if (idsRef.current.length !== rows.length) {
    const ids = idsRef.current.slice(0, rows.length);
    while (ids.length < rows.length) ids.push(nextEnvId++);
    idsRef.current = ids;
  }
  const commitDraft = (): void => {
    if (draft === undefined) return;
    if (draft.key === "") {
      // An untouched row is dropped rather than kept as an empty entry.
      setDraft(undefined);
      return;
    }
    const committed = commitEnvDraft(env, draft);
    // A duplicate key keeps the row open so the caller can fix it.
    if (committed === undefined) return;
    setDraft(undefined);
    onChange(committed);
  };
  const updateKey = (index: number, key: string): void => {
    const row = rows[index];
    if (row.pending) {
      setDraft({ key, value: row.value });
      return;
    }
    onChange(renameEnvKey(env, index, key));
  };
  const updateValue = (index: number, value: string): void => {
    const row = rows[index];
    if (row.pending) {
      setDraft({ key: row.key, value });
      return;
    }
    onChange(setEnvValue(env, index, value));
  };
  const remove = (index: number): void => {
    if (rows[index]?.pending === true) {
      setDraft(undefined);
      return;
    }
    onChange(removeEnvRow(env, index));
  };
  const add = (): void => {
    setDraft((current) => current ?? emptyEnvDraft());
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      {rows.map((row, index) => (
        <div
          key={idsRef.current[index]}
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "8px",
          }}
        >
          <Input
            value={row.key}
            disabled={busy}
            placeholder={t("envKey")}
            aria-label={t("envKey")}
            autoFocus={row.pending}
            onChange={(event) => updateKey(index, event.target.value)}
            onBlur={row.pending ? commitDraft : undefined}
            onKeyDown={row.pending
              ? (event) => {
                if (event.key === "Enter") commitDraft();
              }
              : undefined}
            style={{ width: "160px" }}
          />
          <Input
            value={row.value}
            disabled={busy}
            placeholder={t("envValue")}
            aria-label={t("envValue")}
            onChange={(event) => updateValue(index, event.target.value)}
            onBlur={row.pending ? commitDraft : undefined}
            style={{ width: "200px" }}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => remove(index)}
          >
            {t("removeEnv")}
          </Button>
        </div>
      ))}
      <div>
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={add}
        >
          {t("addEnv")}
        </Button>
      </div>
    </div>
  );
}

export function MountsEditor(props: {
  t: (key: ContainerPluginKey) => string;
  mounts: readonly MountInput[];
  volumes: readonly { name: string }[];
  secrets: readonly { name: string }[];
  busy: boolean;
  enabled: boolean;
  // The host projects root, so a project path can be browsed for and stored
  // relative to it.
  projectsRoot: string;
  // The harness's host-side directory picker; absent in deployments that mount
  // none, which hides the browse affordance.
  directoryPicker?: DirectoryPickerFace;
  confirmRemove?: boolean;
  // How each mount's mode is presented: the live-container remount control
  // (with its confirmation), or an inline dropdown with no confirmation, used
  // where the container does not exist yet (the create/add-container modal).
  modeControl?: "remount" | "select";
  // The default container's primary project mount: it cannot be removed, so it
  // offers only the remount control.
  primaryProject?: string;
  onAdd: (mount: MountInput) => void;
  onRemove: (mount: MountInput) => void;
  onUpdate?: (mount: MountInput, index: number) => void;
}): ReactNode {
  const {
    t,
    mounts,
    volumes,
    secrets,
    busy,
    enabled,
    projectsRoot,
    directoryPicker,
    confirmRemove,
    modeControl = "remount",
    primaryProject = "",
    onAdd,
    onRemove,
    onUpdate,
  } = props;
  const [adding, setAdding] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [browseError, setBrowseError] = useState("");
  const [draft, setDraft] = useState<MountInput>(emptyMount());
  const mountKindId = useId();
  const mountProjectId = useId();
  const mountDestinationId = useId();
  const mountModeId = useId();
  const mountVolumeId = useId();
  const mountSecretId = useId();
  const updateDraft = (patch: Partial<MountInput>): void => {
    setDraft((prev) => ({ ...prev, ...patch }));
  };
  const canAdd = draft.kind === "project"
    ? draft.project.trim() !== ""
    : draft.kind === "volume"
    ? draft.volume !== ""
    : draft.kind === "secret"
    ? draft.secret !== ""
    : true;
  const openAdd = (): void => {
    setDraft(emptyMount());
    setBrowseError("");
    setAdding(true);
  };
  const submit = (): void => {
    if (!canAdd) return;
    onAdd(draft);
    setAdding(false);
  };
  const kindField = draft.kind === "tmpfs"
    ? (
      <Field label={t("mountDestination")} htmlFor={mountDestinationId}>
        <Input
          id={mountDestinationId}
          value={draft.destination}
          disabled={busy}
          onChange={(event) => updateDraft({ destination: event.target.value })}
        />
      </Field>
    )
    : draft.kind === "volume"
    ? (
      <>
        <Field label={t("mountVolume")} htmlFor={mountVolumeId}>
          <select
            id={mountVolumeId}
            style={imageSelect}
            value={draft.volume}
            disabled={busy}
            onChange={(event) => updateDraft({ volume: event.target.value })}
          >
            {volumes.length === 0 ? <option value="">{t("none")}</option> : null}
            {volumes.map((volume) => (
              <option key={volume.name} value={volume.name}>
                {volume.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("mountDestination")} htmlFor={mountDestinationId}>
          <Input
            id={mountDestinationId}
            value={draft.destination}
            disabled={busy}
            onChange={(event) => updateDraft({ destination: event.target.value })}
          />
        </Field>
        <Field label={t("mountMode")} htmlFor={mountModeId}>
          <select
            id={mountModeId}
            style={imageSelect}
            value={draft.mode}
            disabled={busy}
            onChange={(event) => updateDraft({ mode: event.target.value })}
          >
            <option value="read_only">{t("readOnly")}</option>
            <option value="read_write">{t("readWrite")}</option>
          </select>
        </Field>
      </>
    )
    : draft.kind === "secret"
    ? (
      <>
        <Field label={t("mountSecret")} htmlFor={mountSecretId}>
          <select
            id={mountSecretId}
            style={imageSelect}
            value={draft.secret}
            disabled={busy}
            onChange={(event) => updateDraft({ secret: event.target.value })}
          >
            {secrets.length === 0 ? <option value="">{t("none")}</option> : null}
            {secrets.map((secret) => (
              <option key={secret.name} value={secret.name}>
                {secret.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("mountDestination")} htmlFor={mountDestinationId}>
          <Input
            id={mountDestinationId}
            value={draft.destination}
            disabled={busy}
            onChange={(event) => updateDraft({ destination: event.target.value })}
          />
        </Field>
      </>
    )
    : (
      <>
        <Field label={t("mountProjectPath")} htmlFor={mountProjectId}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <Input
              id={mountProjectId}
              value={draft.project}
              disabled={busy}
              onChange={(event) => updateDraft({ project: event.target.value })}
            />
            {directoryPicker !== undefined
              ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setBrowseError("");
                    setBrowsing(true);
                  }}
                >
                  {t("browse")}
                </Button>
              )
              : null}
          </div>
        </Field>
        {browseError === "" ? null : (
          <p style={{ margin: 0, fontSize: "13px" }} role="alert">
            {browseError}
          </p>
        )}
        <Field label={t("mountMode")} htmlFor={mountModeId}>
          <select
            id={mountModeId}
            style={imageSelect}
            value={draft.mode}
            disabled={busy}
            onChange={(event) => updateDraft({ mode: event.target.value })}
          >
            <option value="read_only">{t("readOnly")}</option>
            <option value="read_write">{t("readWrite")}</option>
          </select>
        </Field>
      </>
    );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      {mounts.map((mount, index) => {
        const nextMode = mount.mode === "read_write" ? "read_only" : "read_write";
        const forced = forcedMountMode(mount.kind);
        const editable = mount.kind === "project" || mount.kind === "volume";
        const removable = mount.kind !== "project" ||
          primaryProject === "" ||
          mount.project !== primaryProject;
        return (
          <div
            // Mounts carry no id and duplicates are legal (two identical
            // project mounts, empty tmpfs destinations), so the positional
            // index is the only collision-free key here.
            key={index}
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
              {mountLabel(t, mount, modeControl !== "select")}
            </code>
            {modeControl === "select" && (editable || forced !== undefined)
              ? (
                <select
                  style={imageSelect}
                  value={forced ?? mount.mode}
                  disabled={!enabled || forced !== undefined}
                  aria-label={t("mountMode")}
                  onChange={(event) => onUpdate?.({ ...mount, mode: event.target.value }, index)}
                >
                  {forced !== undefined
                    ? (
                      <option value={forced}>
                        {forced === "read_write" ? t("readWrite") : t("readOnly")}
                      </option>
                    )
                    : (
                      <>
                        <option value="read_only">{t("readOnly")}</option>
                        <option value="read_write">{t("readWrite")}</option>
                      </>
                    )}
                </select>
              )
              : null}
            {modeControl === "remount" && editable && onUpdate !== undefined && (
              <ConfirmButton
                t={t}
                label={nextMode === "read_only" ? t("remountReadOnly") : t("remountReadWrite")}
                title={t("confirmTitle")}
                description={nextMode === "read_only"
                  ? t("confirmRemountReadOnly")
                  : t("confirmRemountReadWrite")}
                disabled={!enabled}
                onConfirm={() => onUpdate({ ...mount, mode: nextMode }, index)}
              />
            )}
            {removable &&
              (confirmRemove
                ? (
                  <ConfirmButton
                    t={t}
                    label={t("remove")}
                    title={t("confirmTitle")}
                    description={t("confirmRemoveMount")}
                    disabled={!enabled}
                    onConfirm={() => onRemove(mount)}
                  />
                )
                : (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!enabled}
                    onClick={() => onRemove(mount)}
                  >
                    {t("remove")}
                  </Button>
                ))}
          </div>
        );
      })}
      <div>
        <Button
          variant="outline"
          size="sm"
          disabled={!enabled}
          onClick={openAdd}
        >
          {t("addMount")}
        </Button>
      </div>
      <Modal
        open={adding}
        onClose={() => setAdding(false)}
        title={t("addMount")}
        closeLabel={t("cancel")}
        footer={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAdding(false)}
            >
              {t("cancel")}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={busy || !canAdd}
              onClick={submit}
            >
              {t("addMount")}
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
          <Field label={t("mountKind")} htmlFor={mountKindId}>
            <select
              id={mountKindId}
              style={imageSelect}
              value={draft.kind}
              disabled={busy}
              onChange={(event) => setDraft(emptyMount(event.target.value))}
            >
              <option value="project">{t("mountProject")}</option>
              <option value="tmpfs">{t("mountTmpfs")}</option>
              <option value="volume">{t("mountVolume")}</option>
              <option value="secret">{t("mountSecret")}</option>
            </select>
          </Field>
          {kindField}
        </div>
      </Modal>
      {directoryPicker === undefined ? null : (
        <DirectoryPickerModal
          t={t}
          open={browsing}
          root={projectsRoot}
          start={hostPathForProjectName(projectsRoot, draft.project)}
          picker={directoryPicker}
          onSelect={(path) => {
            const project = projectNameFromHostPath(projectsRoot, path);
            if (project === undefined) {
              setBrowseError(t("browseOutsideRoot"));
              return;
            }
            updateDraft({ project });
            setBrowseError("");
            setBrowsing(false);
          }}
          onClose={() => setBrowsing(false)}
        />
      )}
    </div>
  );
}
