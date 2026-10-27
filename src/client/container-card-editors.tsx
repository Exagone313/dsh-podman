// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import {
  DiscardChangesModal,
  emptyMount,
  EnvRow,
  mountDestination,
  MountRow,
} from "./container-card-shared.js";
import { isPrimaryProjectMount, orderedMounts } from "../mount-order.js";
import {
  nonProjectDestinationError,
  withPreselectedStorageSource,
} from "./container-card-mount-sources.js";
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
  // Whether the workspace may create storages; it gates the row's own creation
  // button, while `enabled` gates the fields and the Add action.
  writable: boolean;
  // The settings dialogs' creators, so a volume or secret mount can be pointed
  // at a storage created without leaving the row.
  onCreateVolume: (name: string) => Promise<boolean>;
  onCreateSecret: (
    name: string,
    length?: number,
    charset?: string,
  ) => Promise<boolean>;
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
  // Whether a listed row's project path may be retyped. The editor dialogs leave
  // it unset: there a project path is chosen in the Add-mount popup, which
  // validates it on submit. The template popup sets it so a seeded project
  // reference can be corrected in place.
  projectPathEditable?: boolean;
  // A validation message for a listed row — a reference it names that does not
  // exist, or a volume, secret or tmpfs destination the host would refuse. The
  // container form supplies the destination wording; the template popup its own
  // reference checks.
  rowError?: (mount: MountInput, index: number) => string | undefined;
  // Reports that a listed row's project path lost focus, so the caller can
  // re-check it against the host.
  onProjectBlur?: (index: number) => void;
  // Opens the caller's host directory browser for a listed project row, as the
  // row's own Browse action beside Remove. The template popup passes it; the
  // editor dialogs and the container block leave it unset, so their project
  // rows show only the actions they already had.
  onProjectBrowse?: (index: number) => void;
  // The row-action Browse's label. The popup words it without the ellipsis the
  // Add-mount field's own Browse carries; other callers never browse a row.
  projectBrowseLabel?: string;
  // Extra actions rendered beside Add mount — the template popup's Create
  // volume and Create secret. Omitted everywhere else, so the editor's Add
  // control stands alone exactly as it does today.
  actions?: ReactNode;
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
    writable,
    onCreateVolume,
    onCreateSecret,
    projectsRoot,
    directoryPicker,
    confirmRemove,
    primaryProject = "",
    mainProject = "",
    projectPathEditable,
    rowError,
    onProjectBlur,
    onProjectBrowse,
    projectBrowseLabel,
    actions,
    onAdd,
    onRemove,
    onUpdate,
  } = props;
  const [adding, setAdding] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [browseError, setBrowseError] = useState("");
  const [confirmClose, setConfirmClose] = useState(false);
  const [draft, setDraft] = useState<MountInput>(emptyMount());
  // The storage lists may fill or change while the popup stays open — a storage
  // created from it appears in one of them — so an empty draft adopts the first
  // entry of the list its kind reads, exactly what the picker shows. A value
  // already chosen is never replaced.
  useEffect(() => {
    if (!adding) return;
    setDraft((previous) =>
      withPreselectedStorageSource(previous, volumes, secrets)
    );
  }, [adding, volumes, secrets]);
  // Where the draft's project path came from: typing it arms the host check on
  // submit, while a Browse pick skips it.
  const [projectOrigin, setProjectOrigin] = useState<ProjectPathOrigin>(
    "typed",
  );
  // Whether the host check a submit started is still running, and a token that
  // invalidates its result once the popup closes, another submit starts or the
  // draft's project path changes.
  const [checking, setChecking] = useState(false);
  const checkToken = useRef(0);
  // The host's answer to the draft project path the field last listed on blur:
  // the value it was started for, so an answer never marks a newer value, and
  // whether the directory was missing. `listing` blocks Add while the host is
  // still answering.
  const [projectListing, setProjectListing] = useState<
    { project: string; missing: boolean } | undefined
  >(undefined);
  const [listing, setListing] = useState(false);
  // Whether the project field has been left or typed into, so an empty value
  // stays quiet until the user has actually made a choice.
  const [projectTouched, setProjectTouched] = useState(false);
  // The listed rows live in memoized components, so their callbacks keep one
  // identity for as long as the list has the same length. Each callback reads
  // the row and the parent's handler through refs, which therefore always point
  // at the latest render: editing one row re-renders that row alone.
  const mountsRef = useRef(mounts);
  mountsRef.current = mounts;
  const onUpdateRef = useRef(onUpdate);
  onUpdateRef.current = onUpdate;
  const onRemoveRef = useRef(onRemove);
  onRemoveRef.current = onRemove;
  const onProjectBlurRef = useRef(onProjectBlur);
  onProjectBlurRef.current = onProjectBlur;
  const onProjectBrowseRef = useRef(onProjectBrowse);
  onProjectBrowseRef.current = onProjectBrowse;
  const rowCallbacks = useMemo(
    () =>
      Array.from({ length: mounts.length }, (_, index) => ({
        update: (patch: Partial<MountInput>): void => {
          const mount = mountsRef.current[index];
          if (mount === undefined) return;
          onUpdateRef.current?.({ ...mount, ...patch }, index);
        },
        remove: (): void => {
          const mount = mountsRef.current[index];
          if (mount !== undefined) onRemoveRef.current(mount);
        },
        blur: (): void => {
          onProjectBlurRef.current?.(index);
        },
        browse: (): void => {
          onProjectBrowseRef.current?.(index);
        },
      })),
    [mounts.length],
  );
  const updateDraft = (patch: Partial<MountInput>): void => {
    if (patch.project !== undefined) {
      // A new value invalidates the host answer and listing the previous one
      // held: a stale answer must never mark the value on screen. An empty
      // value is not a mistake while it is being retyped, so only a non-empty
      // one counts as touched; leaving the field is what reports emptiness.
      checkToken.current += 1;
      setProjectOrigin("typed");
      setProjectListing(undefined);
      setListing(false);
      setProjectTouched(patch.project !== "");
      setBrowseError("");
    }
    setDraft((prev) => ({ ...prev, ...patch }));
  };
  // Picking a kind is not an edit; anything typed into the pristine kind's
  // fields is, and closing then would lose it. The first storage a kind
  // preselects is not an edit either, so the pristine draft carries it too.
  const dirty = !mountInputsEqual(
    draft,
    withPreselectedStorageSource(emptyMount(draft.kind), volumes, secrets),
  );
  const closeAdd = (): void => {
    checkToken.current += 1;
    setChecking(false);
    setListing(false);
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
  // A volume, secret or tmpfs destination is validated while it is typed, the
  // same rule the host applies: an empty, relative, unclean or overlapping
  // destination refuses Add and says why under the row. A project mount derives
  // its destination, so it is never checked here.
  const draftDestination = nonProjectDestinationError(
    draft.kind,
    draft.destination,
    projectsRoot,
  );
  const draftDestinationError = draftDestination === undefined
    ? undefined
    : t(draftDestination.key, draftDestination.params);
  // The draft's project path is judged lexically as it is typed, with the same
  // pure decision the submit makes; its directory is listed only on blur. A
  // project mount derives its destination, so the destination rule never
  // applies to it, and the other kinds never carry a project path.
  const draftProjectDecision = draft.kind === "project"
    ? decideProjectPath({
      origin: projectOrigin,
      project: draft.project,
      directoryExists: true,
    })
    : undefined;
  const draftProjectMissing = draft.kind === "project" &&
    projectOrigin === "typed" &&
    projectListing !== undefined &&
    projectListing.project === draft.project &&
    projectListing.missing;
  // The row's one error slot carries the project wording for a project mount
  // and the destination wording for every other kind. An empty project path
  // stays quiet until the field is touched, since it is a choice still to
  // make; every other refusal reports itself as it is typed or listed.
  let draftProjectError: string | undefined;
  if (draft.kind === "project" && draftProjectDecision !== undefined) {
    if (!draftProjectDecision.ok) {
      if (draftProjectDecision.reason !== "empty" || projectTouched) {
        draftProjectError = projectPathError(t, draftProjectDecision.reason);
      }
    } else if (draftProjectMissing) {
      draftProjectError = t("mountProjectPathMissing");
    }
  }
  const draftError = draft.kind === "project"
    ? draftProjectError
    : draftDestinationError;
  // Add is refused while the project path is lexically invalid, after the host
  // reported its directory missing, and while a listing is still running. The
  // submit-time check below stays the final gate.
  const canAdd = draftDestination === undefined &&
    (draft.kind === "project"
      ? draftProjectDecision?.ok === true && !draftProjectMissing && !listing
      : draft.kind === "volume"
      ? draft.volume !== ""
      : draft.kind === "secret"
      ? draft.secret !== ""
      : true);
  const openAdd = (): void => {
    checkToken.current += 1;
    setDraft(withPreselectedStorageSource(emptyMount(), volumes, secrets));
    setProjectOrigin("typed");
    setChecking(false);
    setProjectListing(undefined);
    setListing(false);
    setProjectTouched(false);
    setBrowseError("");
    setConfirmClose(false);
    setAdding(true);
  };
  // A typed project path is listed against the host's directory picker when
  // the field loses focus, never on a keystroke: the lexical decision already
  // covers the shape, and only the host knows whether the directory exists. A
  // browsed path names a directory the picker already listed, and a deployment
  // without a picker cannot check one, so both skip the listing and the
  // submit-time check stays the final gate.
  const checkDraftProject = async (): Promise<void> => {
    setProjectTouched(true);
    const decision = decideProjectPath({
      origin: projectOrigin,
      project: draft.project,
      directoryExists: true,
    });
    if (
      draft.kind !== "project" ||
      projectOrigin === "browsed" ||
      !decision.ok ||
      directoryPicker === undefined ||
      checking
    ) {
      return;
    }
    const project = draft.project;
    const token = ++checkToken.current;
    setListing(true);
    try {
      const exists = await projectDirectoryExists(
        directoryPicker,
        projectsRoot,
        project,
      );
      // The popup closed, a submit started or the value changed while the host
      // listed it: this answer belongs to no draft on screen.
      if (token !== checkToken.current) return;
      setProjectListing({ project, missing: !exists });
    } catch {
      // A listing that fails outright says nothing about the path, so the
      // value stays unchecked and the submit-time check decides.
    } finally {
      if (token === checkToken.current) setListing(false);
    }
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
        // The workspace's own project mount is the one row a container's
        // editor locks; every other mount stays removable.
        const removable = !isPrimaryProjectMount(mount, primaryProject);
        const callbacks = rowCallbacks[index];
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
            onUpdate={callbacks.update}
            writable={writable}
            busy={busy}
            onRemove={removable ? callbacks.remove : undefined}
            confirmRemove={confirmRemove}
            removeDisabledReason={removable
              ? undefined
              : t("defaultMountNotRemovable")}
            error={rowError?.(mount, index)}
            onProjectBlur={onProjectBlur === undefined
              ? undefined
              : callbacks.blur}
            onProjectBrowse={onProjectBrowse === undefined
              ? undefined
              : callbacks.browse}
            projectBrowseLabel={projectBrowseLabel}
            projectPathLocked={projectPathEditable !== true}
          />
        );
      })}
      <div
        style={actions === undefined ? undefined : {
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "8px",
        }}
      >
        <Button
          variant="outline"
          size="sm"
          disabled={!enabled}
          onClick={openAdd}
        >
          {t("addMount")}
        </Button>
        {actions ?? null}
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
        {
          /* The row raises its validation message after itself, and the row
            list is what normally supplies the 8px between the two; this
            wrapper stands in for that list, so the dialog's message is not
            flush against the row. Without a message the wrapper holds a single
            child and changes nothing. */
        }
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
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
                  const next = emptyMount(event.target.value);
                  setDraft(
                    withPreselectedStorageSource(next, volumes, secrets),
                  );
                  // Another kind has another source and destination to judge;
                  // the previous project answer and message do not carry over.
                  checkToken.current += 1;
                  setProjectOrigin("typed");
                  setProjectListing(undefined);
                  setListing(false);
                  setProjectTouched(false);
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
            writable={writable}
            busy={busy}
            error={draftError}
            onProjectBlur={() => void checkDraftProject()}
            onCreateVolume={onCreateVolume}
            onCreateSecret={onCreateSecret}
            onBrowse={directoryPicker === undefined ? undefined : () => {
              setBrowseError("");
              setBrowsing(true);
            }}
            browseError={browseError}
          />
        </div>
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
            // A browsed path names a directory the picker just listed: it is
            // checked already, and any listing for the typed value is stale.
            checkToken.current += 1;
            setProjectListing(undefined);
            setListing(false);
            setProjectTouched(false);
            setBrowseError("");
            setBrowsing(false);
          }}
          onClose={() => setBrowsing(false)}
        />
      )}
    </div>
  );
}
