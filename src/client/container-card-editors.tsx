// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import {
  DiscardChangesModal,
  emptyMount,
  EnvRow,
  MountRow,
  orderedMounts,
} from "./container-card-shared.js";
import { imageSelect } from "./container-card-styles.js";
import { ROW_LIST_CLASS } from "./container-card-table-styles.js";
import { mountInputsEqual, recordsEqual } from "./container-card-config.js";
import { type MountInput } from "./container-card-controller.js";
import { DirectoryPickerModal } from "./container-card-directory.js";
import { type DirectoryPickerFace } from "./directory-picker.js";
import {
  conflictingEnvNames,
  emptyEnvRow,
  type EnvEditRow,
  envEditRows,
  envRecordFromRows,
  firstDuplicateEnvName,
} from "../env-rows.js";
import {
  decideProjectPath,
  hostPathForProjectName,
  projectNameFromHostPath,
  type ProjectPathOrigin,
  type ProjectPathRejection,
} from "../project-path.js";
import type { Translate, Translation } from "./locales.js";
import { Button, Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

export function EnvEditor(props: {
  t: Translate;
  env: Record<string, string>;
  busy: boolean;
  onChange: (env: Record<string, string>) => void;
  // Reports the message a conflicting row raises — a key that has gone empty, or
  // a name used twice — or undefined once none blocks it, so the dialog's footer
  // can refuse to apply it and say why.
  onBlockingError?: (error: Translation | undefined) => void;
  // The other group's variable names, the secret environment variables including
  // the row that editor is still typing, so a name used in both groups counts as
  // a duplicate here too.
  otherNames?: readonly string[];
  // Reports the variable names this editor holds — every named row and the
  // unnamed row it is still typing — so the other group's editor catches a name
  // used in both groups before either row is applied.
  onNames?: (names: readonly string[]) => void;
}): ReactNode {
  const { t, env, busy, onChange, onBlockingError, otherNames, onNames } =
    props;
  // The rows are the editor's own: a row keeps its place while its key is
  // retyped, so clearing a key never drops the row — it stays, red, until its
  // own Remove — and renaming one onto a name another row already holds keeps
  // both rows. The parent's record is derived from the named rows alone, so an
  // unnamed row is never applied.
  const [rows, setRows] = useState<EnvEditRow[]>(() => envEditRows(env));
  // A parent record that no longer matches what these rows derive is an outside
  // change — the snapshot resynced after an apply — so the rows are rebuilt
  // from it instead of echoing the ones it replaced.
  if (!recordsEqual(env, envRecordFromRows(rows))) {
    setRows(envEditRows(env));
  }
  // Every name this group holds — the rows as they are typed — then the other
  // group's. A name that is empty or listed twice is a conflict, recomputed
  // from the current rows on every change, so emptying a key or repeating one
  // blocks the apply again immediately.
  const names = useMemo(() => rows.map((row) => row.key), [rows]);
  const conflicts = conflictingEnvNames([...names, ...(otherNames ?? [])]);
  const duplicate = firstDuplicateEnvName([...names, ...(otherNames ?? [])]);
  const keyMissing = names.includes("");
  useEffect(() => {
    onBlockingError?.(
      keyMissing
        ? { key: "envNameRequired" }
        : duplicate === undefined
        ? undefined
        : { key: "envNameDuplicate", params: { key: duplicate } },
    );
  }, [keyMissing, duplicate, onBlockingError]);
  useEffect(() => {
    onNames?.(names);
  }, [names, onNames]);
  // The row the user appended, which focuses itself as it opens.
  const [focusId, setFocusId] = useState<number | undefined>(undefined);
  const update = (next: EnvEditRow[]): void => {
    setRows(next);
    onChange(envRecordFromRows(next));
  };
  const updateKey = (id: number, key: string): void => {
    update(rows.map((row) => (row.id === id ? { ...row, key } : row)));
  };
  const updateValue = (id: number, value: string): void => {
    update(rows.map((row) => (row.id === id ? { ...row, value } : row)));
  };
  const remove = (id: number): void => {
    if (id === focusId) setFocusId(undefined);
    update(rows.filter((row) => row.id !== id));
  };
  const add = (): void => {
    const row = emptyEnvRow();
    setFocusId(row.id);
    update([...rows, row]);
  };
  return (
    <div
      className={ROW_LIST_CLASS}
      style={{ display: "flex", flexDirection: "column", gap: "12px" }}
    >
      {rows.map((row) => {
        // The row's Remove is named after the variable it removes, so a screen
        // reader (and a row that has wrapped) never has to guess which row it
        // belongs to; a still-unnamed row falls back to the plain wording.
        const removeLabel = row.key === ""
          ? t("removeEnv")
          : t("removeVariable", { key: row.key });
        return (
          <EnvRow
            key={row.id}
            t={t}
            mode="edit"
            name={row.key}
            value={row.value}
            disabled={busy}
            autoFocus={row.id === focusId}
            keyInvalid={conflicts.has(row.key)}
            onChangeName={(key) => updateKey(row.id, key)}
            onChangeValue={(value) => updateValue(row.id, value)}
            onRemove={() => remove(row.id)}
            removeLabel={removeLabel}
          />
        );
      })}
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

// The destination a mount row shows for a mount: a project mount's derived
// mirror under the projects root, or the destination the other kinds carry.
function mountDestination(mount: MountInput, projectsRoot: string): string {
  if (mount.kind !== "project") return mount.destination;
  return mount.project.trim() === ""
    ? ""
    : hostPathForProjectName(projectsRoot, mount.project);
}

// The inline error a refused typed project path raises. The path's shape and
// its existence are different mistakes, so they get different wording.
function projectPathError(t: Translate, reason: ProjectPathRejection): string {
  return t(
    reason === "missing"
      ? "mountProjectPathMissing"
      : "mountProjectPathInvalid",
  );
}

// projectDirectoryExists asks the dsh host's own directory picker whether
// projectsRoot/<project> is an existing directory. It is the service Browse
// lists through — host filesystem access, never the container, the pod, the
// guest agent or the orchestrator.
async function projectDirectoryExists(
  picker: DirectoryPickerFace,
  projectsRoot: string,
  project: string,
): Promise<boolean> {
  try {
    await picker.list(hostPathForProjectName(projectsRoot, project));
    return true;
  } catch {
    return false;
  }
}

export function MountsEditor(props: {
  t: Translate;
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
  // The default container's primary project mount: it cannot be removed, so
  // its Remove is greyed out and disabled in place of the action.
  primaryProject?: string;
  // The workspace's own project mount, listed first in the editor and by the
  // project it carries.
  mainProject?: string;
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
    primaryProject = "",
    mainProject = "",
    onAdd,
    onRemove,
    onUpdate,
  } = props;
  const [adding, setAdding] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [browseError, setBrowseError] = useState("");
  const [confirmClose, setConfirmClose] = useState(false);
  const [draft, setDraft] = useState<MountInput>(emptyMount());
  // Where the draft's project path came from: typing it arms the host check on
  // submit, while a Browse pick skips it.
  const [projectOrigin, setProjectOrigin] = useState<ProjectPathOrigin>(
    "typed",
  );
  // Whether the host check a submit started is still running, and a token that
  // invalidates its result once the popup closes or another submit starts.
  const [checking, setChecking] = useState(false);
  const checkToken = useRef(0);
  const updateDraft = (patch: Partial<MountInput>): void => {
    if (patch.project !== undefined) {
      setProjectOrigin("typed");
      setBrowseError("");
    }
    setDraft((prev) => ({ ...prev, ...patch }));
  };
  // Picking a kind is not an edit; anything typed into the pristine kind's
  // fields is, and closing then would lose it.
  const dirty = !mountInputsEqual(draft, emptyMount(draft.kind));
  const closeAdd = (): void => {
    checkToken.current += 1;
    setChecking(false);
    setAdding(false);
  };
  const requestClose = (): void => {
    if (dirty) setConfirmClose(true);
    else closeAdd();
  };
  const discardAndClose = (): void => {
    setConfirmClose(false);
    closeAdd();
  };
  const canAdd = draft.kind === "project"
    ? draft.project.trim() !== ""
    : draft.kind === "volume"
    ? draft.volume !== ""
    : draft.kind === "secret"
    ? draft.secret !== ""
    : true;
  const openAdd = (): void => {
    checkToken.current += 1;
    setDraft(emptyMount());
    setProjectOrigin("typed");
    setChecking(false);
    setBrowseError("");
    setConfirmClose(false);
    setAdding(true);
  };
  // A typed project path is checked against the host on submit: a value chosen
  // through Browse already names a listed directory and skips the check, and a
  // deployment without a directory picker cannot check one, so the orchestrator
  // still enforces it at apply time. The check never reaches the container, the
  // pod, the guest agent or the orchestrator.
  const submit = async (): Promise<void> => {
    if (!canAdd || checking) return;
    const token = ++checkToken.current;
    setChecking(true);
    try {
      // Only a project mount carries a path to check; the other kinds are
      // added as they are.
      let mount = draft;
      if (draft.kind === "project") {
        let decision = decideProjectPath({
          origin: projectOrigin,
          project: draft.project,
          directoryExists: true,
        });
        if (!decision.ok) {
          setBrowseError(projectPathError(t, decision.reason));
          return;
        }
        if (projectOrigin === "typed" && directoryPicker !== undefined) {
          const directoryExists = await projectDirectoryExists(
            directoryPicker,
            projectsRoot,
            draft.project,
          );
          // The popup closed or another submit started while the host listed
          // the directory: this result no longer belongs to the draft on
          // screen.
          if (token !== checkToken.current) return;
          decision = decideProjectPath({
            origin: projectOrigin,
            project: draft.project,
            directoryExists,
          });
        }
        if (!decision.ok) {
          setBrowseError(projectPathError(t, decision.reason));
          return;
        }
        mount = decision.project === draft.project
          ? draft
          : { ...draft, project: decision.project };
      }
      setBrowseError("");
      onAdd(mount);
      closeAdd();
    } finally {
      // A stale submit must not clear the state of the one that replaced it.
      if (token === checkToken.current) setChecking(false);
    }
  };
  // The destination a project mount lands at: its project path mirrored under
  // the projects root, which the host computes and the editor previews. The
  // field stays read-only, since a project mount never takes a destination.
  const projectDestination = draft.project.trim() === ""
    ? ""
    : hostPathForProjectName(projectsRoot, draft.project);
  return (
    <div
      className={ROW_LIST_CLASS}
      style={{ display: "flex", flexDirection: "column", gap: "8px" }}
    >
      {orderedMounts(mounts, mainProject).map(({ mount, index }) => {
        const removable = mount.kind !== "project" ||
          primaryProject === "" ||
          mount.project !== primaryProject;
        const update = (patch: Partial<MountInput>): void => {
          onUpdate?.({ ...mount, ...patch }, index);
        };
        return (
          <MountRow
            // A mount keeps the index it has in the draft as its key, so a
            // category change reorders the list without remounting the row.
            key={index}
            t={t}
            mode="edit"
            mount={mount}
            destination={mountDestination(mount, projectsRoot)}
            disabled={!enabled}
            volumes={volumes}
            secrets={secrets}
            onUpdate={update}
            onRemove={removable ? () => onRemove(mount) : undefined}
            confirmRemove={confirmRemove}
            removeDisabledReason={removable
              ? undefined
              : t("defaultMountNotRemovable")}
            projectPathLocked
          />
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
        onClose={requestClose}
        title={t("addMount")}
        closeLabel={t("cancel")}
        footer={
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
              disabled={busy || !canAdd || checking}
              onClick={() => void submit()}
            >
              {t("addMount")}
            </Button>
          </>
        }
      >
        <MountRow
          t={t}
          mode="edit"
          mount={draft}
          destination={draft.kind === "project"
            ? projectDestination
            : draft.destination}
          kindValue={
            <select
              style={imageSelect}
              value={draft.kind}
              disabled={busy || checking}
              aria-label={t("mountKind")}
              onChange={(event) => {
                setDraft(emptyMount(event.target.value));
                setProjectOrigin("typed");
                setBrowseError("");
              }}
            >
              <option value="project">{t("mountProject")}</option>
              <option value="tmpfs">{t("mountTmpfs")}</option>
              <option value="volume">{t("mountVolume")}</option>
              <option value="secret">{t("mountSecret")}</option>
            </select>
          }
          disabled={busy || checking}
          volumes={volumes}
          secrets={secrets}
          onUpdate={updateDraft}
          onBrowse={directoryPicker === undefined ? undefined : () => {
            setBrowseError("");
            setBrowsing(true);
          }}
          browseError={browseError}
        />
      </Modal>
      <DiscardChangesModal
        t={t}
        open={confirmClose}
        onCancel={() => setConfirmClose(false)}
        onDiscard={discardAndClose}
      />
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
            setDraft((previous) => ({ ...previous, project }));
            setProjectOrigin("browsed");
            setBrowseError("");
            setBrowsing(false);
          }}
          onClose={() => setBrowsing(false)}
        />
      )}
    </div>
  );
}
