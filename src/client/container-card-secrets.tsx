// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import {
  ConfirmButton,
  countLabel,
  Field,
  namePattern,
  SecretEnvRow,
} from "./container-card-shared.js";
import { CardGroup } from "./container-card-group.js";
import { recordsEqual } from "./container-card-config.js";
import { scopedActionKey } from "./card-protocol.js";
import {
  cardList,
  cardRow,
  greyId,
  hint,
  imageSelect,
  rowActions,
  rowDivider,
  rowMain,
  rowName,
} from "./container-card-styles.js";
import { ROW_LIST_CLASS } from "./container-card-table-styles.js";
import type { Translate, Translation } from "./locales.js";
import { COMPACT_DIALOG_CLASS } from "./container-card-dialog-styles.js";
import { missingSecretNames } from "./container-template-ui.js";
import {
  conflictingEnvNames,
  emptyEnvRow,
  type EnvEditRow,
  envEditRows,
  envRecordFromRows,
  firstDuplicateEnvName,
} from "../env-rows.js";
import { Button, Input, Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";

// One secret row: its name and the two actions that act on it — Edit, which
// opens the one secret form on this secret's write-only value, then the
// confirm-gated Remove. The value itself never leaves the browser.
export function SecretRow(props: {
  t: Translate;
  name: string;
  writable: boolean;
  last: boolean;
  pendingActions: readonly string[];
  onEdit: (name: string) => void;
  onRemove: (name: string) => void;
}): ReactNode {
  const { t, name, writable, last, pendingActions, onEdit, onRemove } = props;
  const setPending = pendingActions.includes(
    scopedActionKey("secret_set", name),
  );
  const removePending = pendingActions.includes(
    scopedActionKey("secret_remove", name),
  );
  return (
    <div style={last ? cardRow : { ...cardRow, ...rowDivider }}>
      <div style={rowMain}>
        <code
          style={{
            ...greyId,
            ...rowName,
            fontSize: "13px",
            color: "var(--dsw-alias-label-primary)",
          }}
        >
          {name}
        </code>
      </div>
      <div style={rowActions}>
        <Button
          variant="outline"
          size="sm"
          disabled={!writable || setPending}
          onClick={() => onEdit(name)}
        >
          {setPending ? t("busy") : t("edit")}
        </Button>
        <ConfirmButton
          t={t}
          destructive
          label={t("removeSecret")}
          title={t("removeSecretTitle")}
          description={t("confirmRemoveSecret", { secret: name })}
          confirmLabel={t("removeSecretTitle")}
          disabled={!writable}
          pending={removePending}
          onConfirm={() => onRemove(name)}
        />
      </div>
    </div>
  );
}

// The one secret form, shared by creating and editing: creating takes a name,
// an optional length and a charset, while editing takes only the new value of an
// existing secret, which is write-only and so opens blank. The Storage tab and
// the container dialogs all open this dialog, so the form has a single home. It
// owns its draft and resets it on every open, so a caller only learns the secret
// that was created (to list it, or to select it in its own picker) or the value
// that was applied.
export function SecretModal(props: {
  t: Translate;
  // Whether the form creates a secret or edits the value of `name`.
  mode: "create" | "edit";
  // The secret an edit overwrites; ignored while creating.
  name?: string;
  // The name a create form opens on, used when a template (or a row) already
  // names the secret that has to exist.
  initialName?: string;
  open: boolean;
  busy: boolean;
  writable: boolean;
  // Reports the created secret; unused while editing.
  onCreate?: (name: string, length?: number, charset?: string) => void;
  // Applies the value an edit holds; unused while creating.
  onSet?: (name: string, value: string) => void;
  onClose: () => void;
}): ReactNode {
  const {
    t,
    mode,
    name,
    initialName,
    open,
    busy,
    writable,
    onCreate,
    onSet,
    onClose,
  } = props;
  const [newName, setNewName] = useState("");
  const [length, setLength] = useState("32");
  const [charset, setCharset] = useState("alphanumeric");
  const [value, setValue] = useState("");
  const secretNameId = useId();
  const secretLengthId = useId();
  const secretCharsetId = useId();
  const secretValueId = useId();
  const editing = mode === "edit";
  const parsedLength = parseInt(length, 10);
  // An empty length falls back to the host default, which the hint states; a
  // value outside 1–1024 is refused here rather than silently clamped.
  const lengthValid = length.trim() === "" ||
    (/^[0-9]+$/.test(length.trim()) && parsedLength >= 1 &&
      parsedLength <= 1024);
  const canCreate = namePattern.test(newName) && lengthValid;
  const canApply = value !== "";
  // A draft abandoned by closing is dropped, so it can never apply to the next
  // secret.
  useEffect(() => {
    if (!open) return;
    setNewName(editing ? "" : (initialName ?? ""));
    setLength("32");
    setCharset("alphanumeric");
    setValue("");
  }, [open, editing, initialName]);
  const submit = (): void => {
    if (editing) {
      if (value === "" || name === undefined) return;
      onSet?.(name, value);
    } else {
      if (!namePattern.test(newName) || !lengthValid) return;
      onCreate?.(
        newName.trim(),
        length.trim() === "" ? undefined : parsedLength,
        charset,
      );
    }
    onClose();
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={editing ? t("setSecretTitle") : t("createSecret")}
      closeLabel={t("cancel")}
      className={COMPACT_DIALOG_CLASS}
      footer={
        <>
          <Button
            variant="outline"
            size="sm"
            onClick={onClose}
          >
            {t("cancel")}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={!writable || busy || (editing ? !canApply : !canCreate)}
            onClick={submit}
          >
            {editing ? t("save") : t("createSecret")}
          </Button>
        </>
      }
    >
      {editing
        ? (
          <Field label={t("setSecret")} htmlFor={secretValueId}>
            <Input
              id={secretValueId}
              type="password"
              value={value}
              disabled={!writable || busy}
              autoFocus
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") submit();
              }}
            />
          </Field>
        )
        : (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "12px",
            }}
          >
            <Field label={t("secretName")} htmlFor={secretNameId}>
              <Input
                id={secretNameId}
                value={newName}
                disabled={!writable || busy}
                autoFocus
                onChange={(event) => setNewName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") submit();
                }}
              />
              {newName !== "" && !namePattern.test(newName)
                ? (
                  <p style={{ ...hint, margin: 0 }} role="alert">
                    {t("invalidName")}
                  </p>
                )
                : null}
            </Field>
            <Field label={t("secretLength")} htmlFor={secretLengthId}>
              <Input
                id={secretLengthId}
                type="number"
                min={1}
                max={1024}
                value={length}
                disabled={!writable || busy}
                onChange={(event) => setLength(event.target.value)}
              />
              <p style={{ ...hint, margin: 0 }} aria-live="polite">
                {lengthValid ? t("secretLengthHint") : t("invalidSecretLength")}
              </p>
            </Field>
            <Field label={t("secretCharset")} htmlFor={secretCharsetId}>
              <select
                id={secretCharsetId}
                style={imageSelect}
                value={charset}
                disabled={!writable || busy}
                onChange={(event) => setCharset(event.target.value)}
              >
                <option value="alphanumeric">alphanumeric</option>
                <option value="hex">hex</option>
                <option value="base64url">base64url</option>
              </select>
            </Field>
          </div>
        )}
    </Modal>
  );
}

// The secret environment variables of a container being configured: one row
// per attached variable — the shared secret row, its Key editable like the
// environment editor's and its Value the picker that chooses another secret,
// each with its own Remove — then the button that appends a row for another
// variable. Nothing applies until the dialog's own action, so removing one or
// renaming its variable only stages the change. A workspace without secrets
// offers no picker and no "None" the user could pick, only the one action that
// fixes it. Creating a secret opens the shared dialog on top of the caller's
// own, and selects the new secret as soon as the snapshot lists it, so the
// caller's draft is never disturbed.
export function SecretEnvEditor(props: {
  t: Translate;
  secretEnv: Record<string, string>;
  secrets: readonly { name: string }[];
  busy: boolean;
  enabled: boolean;
  writable: boolean;
  onCreateSecret: (name: string, length?: number, charset?: string) => void;
  onChange: (next: Record<string, string>) => void;
  // Reports the message a conflicting row raises — a name that has gone empty,
  // or one used twice — or undefined once none blocks it, so the dialog's footer
  // can refuse to apply it and say why.
  onBlockingError?: (error: Translation | undefined) => void;
  // The other group's variable names, the environment variables including the
  // row that editor is still typing, so a name used in both groups counts as a
  // duplicate here too.
  otherNames?: readonly string[];
  // Reports the variable names this editor holds — every named row and the
  // unnamed row it is still typing — so the other group's editor catches a name
  // used in both groups before either row is applied.
  onNames?: (names: readonly string[]) => void;
  // A validation message for a row — a secret it names that the workspace does
  // not hold. The editor dialogs leave it unset.
  rowError?: (name: string, secret: string) => string | undefined;
}): ReactNode {
  const {
    t,
    secretEnv,
    secrets,
    busy,
    enabled,
    writable,
    onCreateSecret,
    onChange,
    onBlockingError,
    otherNames,
    onNames,
    rowError,
  } = props;
  // The rows are the editor's own: a row keeps its place while its name is
  // retyped, so clearing a key never drops the row — it stays, red, until its
  // own Remove — and renaming one onto a name another row already holds keeps
  // both rows. The parent's record is derived from the named rows alone, so an
  // unnamed row is never attached.
  const [rows, setRows] = useState<EnvEditRow[]>(() => envEditRows(secretEnv));
  // A parent record that no longer matches what these rows derive is an outside
  // change — the snapshot resynced after an apply — so the rows are rebuilt
  // from it instead of echoing the ones it replaced.
  if (!recordsEqual(secretEnv, envRecordFromRows(rows))) {
    setRows(envEditRows(secretEnv));
  }
  const [createOpen, setCreateOpen] = useState(false);
  // The name the create form opens on: a missing requirement's own name, or
  // empty for the generic Create secret button.
  const [createName, setCreateName] = useState("");
  const missingSecrets = missingSecretNames(secretEnv, secrets);
  const [pendingSecret, setPendingSecret] = useState("");
  // The row the user appended, where a newly created secret is selected; it is
  // kept while that row exists, so the secret lands where the user was working.
  const [draftRowId, setDraftRowId] = useState<number | undefined>(undefined);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  // The host creates a secret asynchronously, so it cannot be selected at
  // submit time; it is selected on the first snapshot that lists it, in the row
  // the caller already opened.
  useEffect(() => {
    if (
      pendingSecret === "" ||
      !secrets.some((secret) => secret.name === pendingSecret)
    ) {
      return;
    }
    setPendingSecret("");
    if (draftRowId === undefined) return;
    const next = rowsRef.current.map((row) =>
      row.id === draftRowId ? { ...row, value: pendingSecret } : row
    );
    setRows(next);
    onChange(envRecordFromRows(next));
  }, [secrets, pendingSecret, draftRowId, onChange]);
  // Every name this group holds — the rows as they are typed — then the other
  // group's. A name that is empty or listed twice is a conflict, recomputed
  // from the current rows on every change.
  const names = useMemo(() => rows.map((row) => row.key), [rows]);
  const conflicts = conflictingEnvNames([...names, ...(otherNames ?? [])]);
  const duplicate = firstDuplicateEnvName([...names, ...(otherNames ?? [])]);
  const nameMissing = names.includes("");
  useEffect(() => {
    onBlockingError?.(
      nameMissing
        ? { key: "envNameRequired" }
        : duplicate === undefined
        ? undefined
        : { key: "envNameDuplicate", params: { key: duplicate } },
    );
  }, [nameMissing, duplicate, onBlockingError]);
  useEffect(() => {
    onNames?.(names);
  }, [names, onNames]);
  // The rows are memoized, so their callbacks keep one identity while the list
  // holds the same row ids. Each one reads the latest rows and handler through a
  // ref, so typing in one row re-renders that row alone.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const writeRows = useCallback((next: EnvEditRow[]): void => {
    setRows(next);
    onChangeRef.current(envRecordFromRows(next));
  }, []);
  const updateRowAt = useCallback(
    (id: number, patch: Partial<EnvEditRow>): void => {
      writeRows(
        rowsRef.current.map((row) =>
          row.id === id ? { ...row, ...patch } : row
        ),
      );
    },
    [writeRows],
  );
  const removeRowAt = useCallback(
    (id: number): void => {
      setDraftRowId((previous) => previous === id ? undefined : previous);
      writeRows(rowsRef.current.filter((row) => row.id !== id));
    },
    [writeRows],
  );
  // Opens the create form on the secret the row still names, so a template's
  // missing requirement can be satisfied in place.
  const openCreateFor = useCallback((id: number): void => {
    const row = rowsRef.current.find((candidate) => candidate.id === id);
    if (row === undefined || row.value === "") return;
    setDraftRowId(id);
    setCreateName(row.value);
    setCreateOpen(true);
  }, []);
  const rowIds = rows.map((row) => row.id).join(",");
  const rowCallbacks = useMemo(() => {
    const callbacks = new Map<number, {
      changeName: (name: string) => void;
      changeSecret: (secret: string) => void;
      remove: () => void;
      createSecret: () => void;
    }>();
    for (const row of rowsRef.current) {
      const id = row.id;
      callbacks.set(id, {
        changeName: (name) => updateRowAt(id, { key: name }),
        changeSecret: (secret) => updateRowAt(id, { value: secret }),
        remove: () => removeRowAt(id),
        createSecret: () => openCreateFor(id),
      });
    }
    return callbacks;
  }, [rowIds, updateRowAt, removeRowAt, openCreateFor]);
  const update = (next: EnvEditRow[]): void => writeRows(next);
  const addRow = (): void => {
    const row = { ...emptyEnvRow(), value: secrets[0]?.name ?? "" };
    setDraftRowId(row.id);
    update([...rows, row]);
  };
  return (
    <div
      className={ROW_LIST_CLASS}
      style={{ display: "flex", flexDirection: "column", gap: "8px" }}
    >
      {rows.map((row) => {
        const callbacks = rowCallbacks.get(row.id);
        return (
          <SecretEnvRow
            key={row.id}
            t={t}
            mode="edit"
            name={row.key}
            secret={row.value}
            secrets={secrets}
            disabled={!enabled}
            autoFocus={row.id === draftRowId}
            keyInvalid={conflicts.has(row.key)}
            error={rowError?.(row.key, row.value)}
            onChangeName={callbacks?.changeName}
            onChangeSecret={callbacks?.changeSecret}
            onRemove={callbacks?.remove}
            onCreateSecret={row.value !== "" &&
                missingSecrets.includes(row.value)
              ? callbacks?.createSecret
              : undefined}
          />
        );
      })}
      {
        /* A workspace without secrets shows no picker and no "none" line: the
          one action that fixes it, Create secret, is offered below. */
      }
      {secrets.length === 0 ? null : (
        <div>
          <Button
            variant="outline"
            size="sm"
            disabled={!enabled}
            onClick={addRow}
          >
            {t("addSecretEnv")}
          </Button>
        </div>
      )}
      <div>
        <Button
          variant="outline"
          size="sm"
          disabled={!writable || busy}
          onClick={() => {
            setCreateName("");
            setCreateOpen(true);
          }}
        >
          {t("createSecret")}
        </Button>
      </div>
      <SecretModal
        t={t}
        mode="create"
        initialName={createName}
        open={createOpen}
        busy={busy}
        writable={writable}
        onCreate={(name, length, charset) => {
          setPendingSecret(name);
          onCreateSecret(name, length, charset);
        }}
        onClose={() => setCreateOpen(false)}
      />
    </div>
  );
}

export function SecretsSection(props: {
  t: Translate;
  secrets: readonly { name: string }[];
  busy: boolean;
  writable: boolean;
  pendingActions: readonly string[];
  onCreate: (name: string, length?: number, charset?: string) => void;
  onRemove: (name: string) => void;
  onSet: (name: string, value: string) => void;
}): ReactNode {
  const {
    t,
    secrets,
    busy,
    writable,
    pendingActions,
    onCreate,
    onRemove,
    onSet,
  } = props;
  const [createOpen, setCreateOpen] = useState(false);
  // The secret whose value the shared form edits; undefined while the form is
  // closed or creating another secret.
  const [editing, setEditing] = useState<string | undefined>(undefined);
  return (
    <CardGroup
      title={t("secretsTitle")}
      summary={countLabel(
        t,
        secrets.length,
        "countSecretOne",
        "countSecretMany",
      )}
      hasContent={secrets.length > 0}
      action={
        <Button
          variant="primary"
          size="sm"
          disabled={!writable || busy}
          onClick={() => setCreateOpen(true)}
        >
          {t("createSecret")}
        </Button>
      }
    >
      {secrets.length === 0
        ? <p style={{ ...hint, margin: 0 }}>{t("noSecrets")}</p>
        : (
          <div style={cardList}>
            {secrets.map((secret, index) => (
              <SecretRow
                key={secret.name}
                t={t}
                name={secret.name}
                writable={writable}
                last={index === secrets.length - 1}
                pendingActions={pendingActions}
                onEdit={(name) => setEditing(name)}
                onRemove={onRemove}
              />
            ))}
          </div>
        )}
      <SecretModal
        t={t}
        mode={editing === undefined ? "create" : "edit"}
        name={editing}
        open={createOpen || editing !== undefined}
        busy={busy}
        writable={writable}
        onCreate={onCreate}
        onSet={onSet}
        onClose={() => {
          setCreateOpen(false);
          setEditing(undefined);
        }}
      />
    </CardGroup>
  );
}
