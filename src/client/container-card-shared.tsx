// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import {
  type ActionEmphasis,
  destructiveAction,
  editorGroup,
  emphasisAction,
  envField,
  envFieldLabel,
  envRow,
  fieldHint,
  fieldLine,
  hint,
  imageSelect,
  mountField,
  mountKindField,
  rowActions,
  sectionTitle,
  slotSelect,
  statusChip,
} from "./container-card-styles.js";
import {
  FIELD_CLASS,
  SLOT_CLASS,
  SLOT_INVALID_CLASS,
} from "./container-card-field-styles.js";
import {
  MOUNT_ACTIONS_CLASS,
  MOUNT_DESTINATION_CLASS,
  MOUNT_FIELD_CLASS,
  MOUNT_KIND_CLASS,
  MOUNT_KIND_VALUE_CLASS,
  MOUNT_ROW_CLASS,
} from "./container-card-table-styles.js";
import { normalizeMountKind, normalizeMountMode } from "../mount-enums.js";
import {
  type MountInput,
  type ProjectMountView,
} from "./container-card-controller.js";
import { type ContainerPluginKey, type Translate } from "./locales.js";
import {
  Button,
  IconCheckOutlineRegular,
  IconCopyOutlineRegular,
  Input,
  Modal,
  writeClipboard,
} from "@deepseek-ai/dsh-client-ui-primitives";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";

// Localized cardinal count: the singular key renders only at exactly one, so
// both languages can word the count their own way.
export function countLabel(
  t: Translate,
  n: number,
  one: ContainerPluginKey,
  many: ContainerPluginKey,
): string {
  return t(n === 1 ? one : many, { n: String(n) });
}

export function Field(props: {
  label: string;
  htmlFor: string;
  children: ReactNode;
}): ReactNode {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
      <label
        htmlFor={props.htmlFor}
        style={{ fontSize: "13px", color: "var(--dsw-alias-label-secondary)" }}
      >
        {props.label}
      </label>
      {props.children}
    </div>
  );
}

// The lock a fixed value carries at the leading edge of its field: a rounded
// body under a shackle arc, drawn in the field's own muted colour through the
// input's leading-icon slot. The icon set carries no lock glyph, so it is drawn
// here; it repeats the fact the tinted surface states — the value is shown, not
// chosen — and carries no wording of its own, which is why it is hidden from
// assistive technology.
export function LockGlyph(): ReactNode {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <rect x="2.5" y="5.5" width="7" height="5" rx="1.5" />
      <path d="M4 5.5V4a2 2 0 0 1 4 0v1.5" />
    </svg>
  );
}

// The value line of a read-only field: the value itself, which the caller owns,
// and that field's own copy control. `copyValue` overrides what the control
// writes when the shown value is a wording of the real one (a relative creation
// time still copies its instant), `hint` states a fact beside the value without
// replacing it, and an empty value reads as the shared placeholder with nothing
// to copy. It is the value slot of CopyField and of a mount row's read-only
// fields, so a mount reads the same in the block and in the Mounts editor. Every
// value it renders is fixed, so it always leads with the lock.
export function ReadOnlyValue(props: {
  t: Translate;
  id: string;
  value: string;
  copyLabel: string;
  copyValue?: string;
  hint?: string;
}): ReactNode {
  const { t, id, value, copyLabel, copyValue, hint } = props;
  return (
    <div style={fieldLine}>
      <Input
        id={id}
        className={`${SLOT_CLASS} ${FIELD_CLASS}`}
        icon={<LockGlyph />}
        readOnly
        value={value}
        placeholder={value === "" ? t("valueMissing") : undefined}
      />
      <CopyButton
        t={t}
        value={copyValue ?? value}
        label={copyLabel}
      />
      {hint === undefined ? null : <span style={fieldHint}>{hint}</span>}
    </div>
  );
}

// One read-only field of a container block: a visible label above the value and
// that field's own copy control.
export function CopyField(props: {
  t: Translate;
  label: string;
  value: string;
  copyLabel: string;
  copyValue?: string;
}): ReactNode {
  const { t, label, value, copyLabel, copyValue } = props;
  const id = useId();
  return (
    <div style={envField}>
      <label htmlFor={id} style={envFieldLabel}>{label}</label>
      <ReadOnlyValue
        t={t}
        id={id}
        value={value}
        copyLabel={copyLabel}
        copyValue={copyValue}
      />
    </div>
  );
}

// The copy control a field carries: a discreet icon button whose accessible
// name says what it copies, and whose check — with its own "copied" wording —
// confirms the write for a moment.
export function CopyButton(props: {
  t: Translate;
  value: string;
  label: string;
}): ReactNode {
  const { t, value, label } = props;
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout>>();
  const copy = (): void => {
    void writeClipboard(value).then((ok) => {
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
  const name = copied ? t("copied") : label;
  return (
    <Button
      variant="ghost"
      size="sm"
      icon={copied ? <IconCheckOutlineRegular /> : <IconCopyOutlineRegular />}
      aria-label={name}
      disabled={value === ""}
      onClick={copy}
    />
  );
}

export const namePattern = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/;

export const imageIdPattern = /^[a-zA-Z0-9_][a-zA-Z0-9_.\-/:]{0,127}$/;

// The colour a state chip reads with, independent of the words it carries.
export type StatusTone =
  | "ok"
  | "warn"
  | "error"
  | "business"
  | "violet"
  | "muted";

// Each tone's foreground and fill come from the design system's state palette.
// No error- or business-tertiary fill exists, so those tones tint their own
// primary; violet has no token at all, so it tints its own literal.
const STATUS_TONES: Record<StatusTone, React.CSSProperties> = {
  ok: {
    color: "var(--dsw-alias-state-success-primary)",
    background: "var(--dsw-alias-state-success-tertiary)",
  },
  warn: {
    color: "var(--dsw-alias-state-warn-primary)",
    background: "var(--dsw-alias-state-warn-tertiary)",
  },
  error: {
    color: "var(--dsw-alias-state-error-primary)",
    background:
      "color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent)",
  },
  business: {
    color: "var(--dsw-alias-state-business-primary)",
    background:
      "color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent)",
  },
  violet: {
    color: "#a78bfa",
    background: "color-mix(in srgb, #a78bfa 12%, transparent)",
  },
  muted: {
    color: "var(--dsw-alias-label-tertiary)",
    background: "var(--dsw-alias-bg-layer-3)",
  },
};

// A state chip: the words state the fact and the tone repeats it in colour, so
// a failure is visible without relying on colour alone. A chip whose word needs
// context carries that context as its tooltip, never as a second line of copy.
export function StatusChip(props: {
  tone: StatusTone;
  label: ReactNode;
  title?: string;
}): ReactNode {
  const { tone, label, title } = props;
  return (
    <span style={{ ...statusChip, ...STATUS_TONES[tone] }} title={title}>
      {label}
    </span>
  );
}

// The short kind chip a mount row leads with. Its tone repeats the kind in
// colour at a glance, while the chip's word still names it outright.
export function MountKindChip(props: {
  label: string;
  tone: StatusTone;
}): ReactNode {
  const { label, tone } = props;
  return <span style={{ ...statusChip, ...STATUS_TONES[tone] }}>{label}</span>;
}

// The Kind field a mount row leads with: the same label-over-value stack a
// read-only field uses, with the chip in the value slot so it reads on the same
// line as the fields beside it. The value line reserves an input's own height
// while the row has room, so the chip sits on the inputs' line; the field's own
// class gives it a full line on a narrow row, where the container query drops
// that height again because no input is left to align with. A chip is not a form
// control, so its label is a span rather than a `<label>`. While a mount is
// being added the value slot holds the kind picker instead of the chip.
export function MountKindField(props: {
  t: Translate;
  kind: string;
  children?: ReactNode;
}): ReactNode {
  const { t, kind, children } = props;
  return (
    <div className={MOUNT_KIND_CLASS} style={mountKindField}>
      <span style={envFieldLabel}>{t("mountKind")}</span>
      <div className={MOUNT_KIND_VALUE_CLASS} style={fieldLine}>
        {children ?? (
          <MountKindChip
            label={mountKindLabel(t, kind)}
            tone={mountKindTone(kind)}
          />
        )}
      </div>
    </div>
  );
}

// One labelled value slot of a shared field row: the field's label above
// whatever the caller puts in the value position — a read-only value with its
// copy control in the container block, an editable control in an editor — with
// the label naming that control through its id.
export function FieldSlot(props: {
  label: string;
  htmlFor: string;
  // An extra class the slot's own field carries when it wants a different share
  // of the row's line than the default field. The field class itself is always
  // kept, so the narrow-row rule that gives a field a full line still applies.
  className?: string;
  children: ReactNode;
}): ReactNode {
  const { className } = props;
  return (
    <div
      className={className === undefined
        ? MOUNT_FIELD_CLASS
        : `${MOUNT_FIELD_CLASS} ${className}`}
      style={mountField}
    >
      <label htmlFor={props.htmlFor} style={envFieldLabel}>
        {props.label}
      </label>
      {props.children}
    </div>
  );
}

// One labelled slot a caller hands a shared field row: the label it shows and
// the render function that fills the value position. The render function
// receives the id its control must carry, so the visible label names it.
export interface FieldRowSlot {
  label: string;
  // An extra class the slot's own field carries when it wants a different share
  // of the row's line than the default field — the Destination does, so a wide
  // row spends its free space there.
  className?: string;
  render: (id: string) => ReactNode;
}

// The canonical field row the container block, the Mounts editor and the three
// other editors all render through: an optional leading Kind slot, the labelled
// value slots in order, and the row's own trailing actions. The container block
// fills each slot with a read-only value and an editor fills it with an editable
// control, so both render one layout and cannot drift. The row is its own
// containment context (the class), so its slots share the line while there is
// room and stack identically on a narrow row, in a card and in a dialog alike.
export function FieldRow(props: {
  // The Kind slot a mount row leads with; omitted by every other row.
  leading?: ReactNode;
  fields: readonly FieldRowSlot[];
  actions?: ReactNode;
}): ReactNode {
  const { leading, fields, actions } = props;
  const base = useId();
  return (
    <div className={MOUNT_ROW_CLASS} style={envRow}>
      {leading}
      {fields.map((field, index) => {
        const id = `${base}-${index}`;
        return (
          <FieldSlot
            key={index}
            label={field.label}
            htmlFor={id}
            className={field.className}
          >
            {field.render(id)}
          </FieldSlot>
        );
      })}
      {actions === undefined
        ? null
        : (
          <div className={MOUNT_ACTIONS_CLASS} style={rowActions}>
            {actions}
          </div>
        )}
    </div>
  );
}

// The mode a shared field row renders in: the container block shows the
// container's own value, an editor shows the control that changes it. Every
// group — the image, the environment variables, the mounts, the PATH additions,
// the secret environment variables and the published ports — is one component
// rendered in both modes, so a change to a row lands on the block and on the
// editors at once.
export type RowMode = "view" | "edit";

// The value slot of a shared row: the container's own value as a read-only
// field in the block, the caller's control in an editor — each with that
// field's own copy control, so a value is copyable wherever it is rendered.
// `below` carries a line that belongs under the control (a browse error) and
// `hint` states a fact beside the value itself, so neither ever replaces the
// value; `trailing` is a control the row itself owns (an editor's Remove),
// placed after the copy control at the line's end so the row keeps the block's
// field widths.
function ValueField(props: {
  t: Translate;
  mode: RowMode;
  id: string;
  value: string;
  copyLabel: string;
  copyValue?: string;
  hint?: string;
  below?: ReactNode;
  trailing?: ReactNode;
  children?: ReactNode;
}): ReactNode {
  const {
    t,
    mode,
    id,
    value,
    copyLabel,
    copyValue,
    hint,
    below,
    trailing,
    children,
  } = props;
  if (mode === "view") {
    return (
      <ReadOnlyValue
        t={t}
        id={id}
        value={value}
        copyLabel={copyLabel}
        copyValue={copyValue}
        hint={hint}
      />
    );
  }
  return (
    <>
      <div style={fieldLine}>
        {children}
        <CopyButton t={t} value={copyValue ?? value} label={copyLabel} />
        {trailing ?? null}
      </div>
      {below ?? null}
    </>
  );
}

// The Image field, shared by the container block and every dialog that edits a
// container: the block states the image the container runs, the editors offer
// the image picker. The candidates are listed base images first, custom ones
// after, and an image the snapshot no longer lists stays selectable rather than
// being silently replaced by the first candidate.
export function ImageRow(props: {
  t: Translate;
  mode: RowMode;
  image: string;
  candidates?: readonly string[];
  disabled?: boolean;
  onChange?: (image: string) => void;
}): ReactNode {
  const { t, mode, image, candidates, disabled, onChange } = props;
  const options = candidates ?? [];
  return (
    <FieldRow
      fields={[{
        label: t("image"),
        render: (id) => (
          <ValueField
            t={t}
            mode={mode}
            id={id}
            value={image}
            copyLabel={t("copyImage")}
          >
            <select
              id={id}
              style={imageSelect}
              value={image}
              disabled={disabled === true}
              aria-label={t("image")}
              onChange={(event) => onChange?.(event.target.value)}
            >
              {image !== "" && options.includes(image)
                ? null
                : (
                  <option value={image}>
                    {image === "" ? t("none") : image}
                  </option>
                )}
              {options.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {candidate}
                </option>
              ))}
            </select>
          </ValueField>
        ),
      }]}
    />
  );
}

// One environment variable's row, shared by the container block and the
// environment editor: its Key and Value as separate fields, never a merged
// KEY=value string. The block shows both as read-only copyable fields; the
// editor shows the two controls that change them and the row's own Remove,
// which sits at the value line's end exactly where the block puts that field's
// copy control, so both render the same two fields at the same widths.
export function EnvRow(props: {
  t: Translate;
  mode: RowMode;
  name: string;
  value: string;
  disabled?: boolean;
  // The row an editor is still typing: it focuses itself and commits on blur or
  // Enter.
  autoFocus?: boolean;
  onChangeName?: (name: string) => void;
  onChangeValue?: (value: string) => void;
  onRemove?: () => void;
  removeLabel?: string;
  // Whether the row's key conflicts in an editor — empty, or a name used twice —
  // which paints only the key with the error state's stroke. A conflict is about
  // the name, never the value, so the value field keeps its neutral stroke.
  keyInvalid?: boolean;
}): ReactNode {
  const {
    t,
    mode,
    name,
    value,
    disabled,
    autoFocus,
    onChangeName,
    onChangeValue,
    onRemove,
    removeLabel,
    keyInvalid,
  } = props;
  const disabledField = disabled === true;
  const keyClass = keyInvalid === true
    ? `${SLOT_CLASS} ${SLOT_INVALID_CLASS}`
    : SLOT_CLASS;
  const removeControl = mode === "edit" && onRemove !== undefined
    ? (
      <Button
        variant="outline"
        size="sm"
        aria-label={removeLabel ?? t("removeEnv")}
        disabled={disabledField}
        style={destructiveAction}
        onClick={onRemove}
      >
        {t("removeEnv")}
      </Button>
    )
    : undefined;
  return (
    <FieldRow
      fields={[
        {
          label: t("envKey"),
          render: (id) => (
            <ValueField
              t={t}
              mode={mode}
              id={id}
              value={name}
              copyLabel={t("copyEnvKey", { key: name })}
            >
              <Input
                id={id}
                className={keyClass}
                value={name}
                disabled={disabledField}
                placeholder={t("envKey")}
                autoFocus={autoFocus}
                onChange={(event) => onChangeName?.(event.target.value)}
              />
            </ValueField>
          ),
        },
        {
          label: t("envValue"),
          render: (id) => (
            <ValueField
              t={t}
              mode={mode}
              id={id}
              value={value}
              copyLabel={t("copyEnvValue", { key: name })}
              trailing={removeControl}
            >
              <Input
                id={id}
                className={SLOT_CLASS}
                value={value}
                disabled={disabledField}
                placeholder={t("envValue")}
                onChange={(event) => onChangeValue?.(event.target.value)}
              />
            </ValueField>
          ),
        },
      ]}
    />
  );
}

// The short mode one mount carries, in the words the mode pickers use.
const mountModeLabel = (t: Translate, mode: string): string =>
  normalizeMountMode(mode) === "read_only" ? t("readOnly") : t("readWrite");

// The source control a mount kind takes, in a mount row's source slot: the
// project path, the volume picker or the secret picker. A tmpfs row never asks
// for it, since tmpfs mounts no source. The select fills its slot exactly like
// the text field beside it, so switching a mount's kind never resizes the row.
function MountSourceControl(props: {
  t: Translate;
  id: string;
  kind: string;
  project: string;
  volume: string;
  secret: string;
  volumes: readonly { name: string }[];
  secrets: readonly { name: string }[];
  disabled: boolean;
  // The reason a project path is stated rather than offered: the mount it
  // belongs to is the default container's main project mount, which cannot be
  // removed. Absent on every other mount, whose path stays editable.
  projectReadOnlyReason?: string;
  onProject: (project: string) => void;
  onVolume: (volume: string) => void;
  onSecret: (secret: string) => void;
}): ReactNode {
  const { t, id, kind, disabled } = props;
  const normalized = normalizeMountKind(kind);
  if (normalized === "volume") {
    // A volume the snapshot no longer lists stays selectable rather than being
    // silently replaced by the first candidate.
    const missing = props.volume !== "" &&
      !props.volumes.some((volume) => volume.name === props.volume);
    return (
      <select
        id={id}
        style={slotSelect}
        value={props.volume}
        disabled={disabled}
        onChange={(event) => props.onVolume(event.target.value)}
      >
        {missing ? <option value={props.volume}>{props.volume}</option> : null}
        {props.volumes.length === 0
          ? <option value="">{t("none")}</option>
          : null}
        {props.volumes.map((volume) => (
          <option key={volume.name} value={volume.name}>
            {volume.name}
          </option>
        ))}
      </select>
    );
  }
  if (normalized === "secret") {
    const missing = props.secret !== "" &&
      !props.secrets.some((secret) => secret.name === props.secret);
    return (
      <select
        id={id}
        style={slotSelect}
        value={props.secret}
        disabled={disabled}
        onChange={(event) => props.onSecret(event.target.value)}
      >
        {missing ? <option value={props.secret}>{props.secret}</option> : null}
        {props.secrets.length === 0
          ? <option value="">{t("none")}</option>
          : null}
        {props.secrets.map((secret) => (
          <option key={secret.name} value={secret.name}>
            {secret.name}
          </option>
        ))}
      </select>
    );
  }
  return (
    <Input
      id={id}
      className={props.projectReadOnlyReason === undefined
        ? SLOT_CLASS
        : `${SLOT_CLASS} ${FIELD_CLASS}`}
      icon={props.projectReadOnlyReason === undefined
        ? undefined
        : <LockGlyph />}
      value={props.project}
      // The path of a mount that cannot be removed cannot be typed into either:
      // it stays readable and selectable, on the fixed value's own surface, with
      // the reason as its tooltip.
      readOnly={props.projectReadOnlyReason !== undefined}
      title={props.projectReadOnlyReason}
      disabled={disabled}
      onChange={(event) => props.onProject(event.target.value)}
    />
  );
}

// The canonical mount row: Kind, Destination, the source field the kind takes
// and Mode, in that order, plus the editor's own trailing actions, through the
// one shared field row. The row itself decides which fields a kind carries:
// tmpfs mounts no source, and a secret or tmpfs carries no mode. The block
// fills each field with the container's own value; an editor fills it with the
// control that changes it.
export function MountRow(props: {
  t: Translate;
  mode: RowMode;
  mount: MountInput;
  // The destination the row shows: the snapshot's derived mirror under the
  // projects root in the block, the preview of it in an editor.
  destination: string;
  // The Kind value slot: the chip for the kind by default, or the kind picker
  // while a mount is being added.
  kindValue?: ReactNode;
  disabled?: boolean;
  volumes?: readonly { name: string }[];
  secrets?: readonly { name: string }[];
  onUpdate?: (patch: Partial<MountInput>) => void;
  // The browse affordance and the message it may raise; a row whose project
  // path is typed rather than browsed omits both.
  onBrowse?: () => void;
  browseError?: string;
  // The row's own Remove, which an editor passes and the block omits. Removing
  // a mount from a live container is gated behind that confirmation, and a
  // mount that cannot be removed keeps its Remove in place, greyed out and
  // disabled, with the reason as its tooltip. The same reason states that
  // mount's project path, which renders read-only.
  onRemove?: () => void;
  confirmRemove?: boolean;
  removeDisabledReason?: string;
}): ReactNode {
  const {
    t,
    mode,
    mount,
    destination,
    kindValue,
    disabled,
    volumes,
    secrets,
    onUpdate,
    onBrowse,
    browseError,
    onRemove,
    confirmRemove,
    removeDisabledReason,
  } = props;
  const disabledField = disabled === true;
  const update = (patch: Partial<MountInput>): void => onUpdate?.(patch);
  // A project mount never takes a destination of its own — the host derives its
  // mirror under the projects root — so the preview of it is a fixed value.
  const destinationFixed = normalizeMountKind(mount.kind) === "project";
  const fields: FieldRowSlot[] = [
    {
      label: t("mountDestination"),
      className: MOUNT_DESTINATION_CLASS,
      render: (id) => (
        <ValueField
          t={t}
          mode={mode}
          id={id}
          value={destination}
          copyLabel={t("copyMountPath", {
            path: destination === "" ? t("valueMissing") : destination,
          })}
        >
          <Input
            id={id}
            className={destinationFixed
              ? `${SLOT_CLASS} ${FIELD_CLASS}`
              : SLOT_CLASS}
            icon={destinationFixed ? <LockGlyph /> : undefined}
            value={destination}
            readOnly={destinationFixed}
            disabled={disabledField}
            onChange={(event) => update({ destination: event.target.value })}
            style={{ width: "100%" }}
          />
        </ValueField>
      ),
    },
  ];
  const source = mountSourceName(mount);
  if (mountHasSource(mount.kind)) {
    fields.push({
      label: mountSourceLabel(t, mount.kind),
      render: (id) => (
        <ValueField
          t={t}
          mode={mode}
          id={id}
          value={source}
          copyLabel={t("copyMountName", { name: source })}
          below={browseError === undefined || browseError === ""
            ? undefined
            : (
              <p style={{ margin: 0, fontSize: "13px" }} role="alert">
                {browseError}
              </p>
            )}
        >
          <MountSourceControl
            t={t}
            id={id}
            kind={mount.kind}
            project={mount.project}
            volume={mount.volume}
            secret={mount.secret}
            volumes={volumes ?? []}
            secrets={secrets ?? []}
            disabled={disabledField}
            projectReadOnlyReason={removeDisabledReason}
            onProject={(project) => update({ project })}
            onVolume={(volume) => update({ volume })}
            onSecret={(secret) => update({ secret })}
          />
          {onBrowse === undefined ? null : (
            <Button
              variant="outline"
              size="sm"
              // The path that cannot be typed into cannot be browsed to either:
              // the Browse stays in place, greyed out and disabled, with the
              // reason as its tooltip.
              disabled={disabledField || removeDisabledReason !== undefined}
              title={removeDisabledReason}
              aria-label={removeDisabledReason}
              onClick={onBrowse}
            >
              {t("browse")}
            </Button>
          )}
        </ValueField>
      ),
    });
  }
  const modeLabel = mountModeLabel(t, mount.mode);
  if (mountHasMode(mount.kind)) {
    fields.push({
      label: t("mountMode"),
      render: (id) => (
        <ValueField
          t={t}
          mode={mode}
          id={id}
          value={modeLabel}
          copyLabel={t("copyMountMode", { mode: modeLabel })}
        >
          <select
            id={id}
            style={slotSelect}
            value={normalizeMountMode(mount.mode)}
            disabled={disabledField}
            onChange={(event) => update({ mode: event.target.value })}
          >
            <option value="read_only">{t("readOnly")}</option>
            <option value="read_write">{t("readWrite")}</option>
          </select>
        </ValueField>
      ),
    });
  }
  const actions = mode === "view"
    ? undefined
    : removeDisabledReason !== undefined
    ? (
      /* The default container's main project mount cannot be removed. Its
         Remove stays in place, greyed out and disabled, so its inputs keep the
         width of every other project mount's. */
      <Button
        variant="outline"
        size="sm"
        disabled
        title={removeDisabledReason}
        aria-label={removeDisabledReason}
      >
        {t("remove")}
      </Button>
    )
    : onRemove === undefined
    ? undefined
    : confirmRemove === true
    ? (
      <ConfirmButton
        t={t}
        destructive
        label={t("remove")}
        title={t("removeMountTitle")}
        description={t("confirmRemoveMount", {
          mount: mountLabel(t, mount, false),
        })}
        confirmLabel={t("removeMountTitle")}
        disabled={disabledField}
        onConfirm={onRemove}
      />
    )
    : (
      <Button
        variant="outline"
        size="sm"
        disabled={disabledField}
        style={destructiveAction}
        onClick={onRemove}
      >
        {t("remove")}
      </Button>
    );
  return (
    <FieldRow
      leading={
        <MountKindField t={t} kind={mount.kind}>{kindValue}</MountKindField>
      }
      fields={fields}
      actions={actions}
    />
  );
}

// The compact controls a PATH row carries beside its field: the drag handle and
// the move/remove buttons are symbols, so their meaning lives in the title and
// the accessible name instead of a visible label.
const rowButton: React.CSSProperties = {
  padding: 0,
  minWidth: "28px",
};

const dragHandle: React.CSSProperties = {
  cursor: "grab",
  background: "none",
  border: "none",
  padding: 0,
  color: "var(--dsw-alias-label-tertiary)",
};

// One PATH addition, shared by the container block and the PATH editor: the
// block shows the entry as a read-only copyable field, the editor shows the
// input and the row's own reorder and remove controls.
export function PathRow(props: {
  t: Translate;
  mode: RowMode;
  path: string;
  disabled?: boolean;
  autoFocus?: boolean;
  first?: boolean;
  last?: boolean;
  onChange?: (path: string) => void;
  onMove?: (delta: number) => void;
  onRemove?: () => void;
  onDragStart?: () => void;
  onDrop?: () => void;
}): ReactNode {
  const {
    t,
    mode,
    path,
    disabled,
    autoFocus,
    first,
    last,
    onChange,
    onMove,
    onRemove,
    onDragStart,
    onDrop,
  } = props;
  const disabledField = disabled === true;
  return (
    <FieldRow
      fields={[{
        label: t("path"),
        render: (id) => (
          <ValueField
            t={t}
            mode={mode}
            id={id}
            value={path}
            copyLabel={t("copyPathEntry", { path })}
          >
            <Input
              id={id}
              value={path}
              disabled={disabledField}
              autoFocus={autoFocus}
              onChange={(event) => onChange?.(event.target.value)}
              style={{ width: "100%" }}
            />
          </ValueField>
        ),
      }]}
      actions={mode === "edit"
        ? (
          <>
            {onDragStart === undefined ? null : (
              <button
                type="button"
                title={t("dragToReorder")}
                aria-label={t("dragToReorder")}
                draggable={!disabledField}
                onDragStart={onDragStart}
                onDragOver={(event) => event.preventDefault()}
                onDrop={onDrop}
                style={dragHandle}
              >
                ≡
              </button>
            )}
            {onMove === undefined ? null : (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  title={t("moveUp")}
                  aria-label={t("moveUp")}
                  disabled={disabledField || first === true}
                  onClick={() => onMove(-1)}
                  style={rowButton}
                >
                  ↑
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  title={t("moveDown")}
                  aria-label={t("moveDown")}
                  disabled={disabledField || last === true}
                  onClick={() => onMove(1)}
                  style={rowButton}
                >
                  ↓
                </Button>
              </>
            )}
            {onRemove === undefined ? null : (
              <Button
                variant="outline"
                size="sm"
                title={t("remove")}
                aria-label={t("remove")}
                disabled={disabledField}
                onClick={onRemove}
                style={{ ...rowButton, ...destructiveAction }}
              >
                ×
              </Button>
            )}
          </>
        )
        : undefined}
    />
  );
}

// One secret environment variable, shared by the container block and the secret
// editor: the block shows the variable and the secret it points at as read-only
// copyable fields, the editor shows the variable name and the secret picker with
// the row's own Remove at the value line's end, exactly where the block puts
// that field's copy control, so both render the same two fields at the same
// widths. Removing one only stages the change, so it needs no confirmation.
export function SecretEnvRow(props: {
  t: Translate;
  mode: RowMode;
  name: string;
  secret: string;
  // The secrets an editor offers; the block shows the attached name as it is.
  secrets?: readonly { name: string }[];
  disabled?: boolean;
  autoFocus?: boolean;
  onChangeName?: (name: string) => void;
  onChangeSecret?: (secret: string) => void;
  // The row's own Remove, which an editor passes and the block omits.
  onRemove?: () => void;
  // Whether the row's key conflicts in an editor — empty, or a name used twice —
  // which paints only the key with the error state's stroke; the secret picker
  // never carries it.
  keyInvalid?: boolean;
}): ReactNode {
  const {
    t,
    mode,
    name,
    secret,
    secrets,
    disabled,
    autoFocus,
    onChangeName,
    onChangeSecret,
    onRemove,
    keyInvalid,
  } = props;
  const disabledField = disabled === true;
  const candidates = secrets ?? [];
  const removeControl = mode === "edit" && onRemove !== undefined
    ? (
      <Button
        variant="outline"
        size="sm"
        disabled={disabledField}
        style={destructiveAction}
        onClick={onRemove}
      >
        {t("remove")}
      </Button>
    )
    : undefined;
  return (
    <FieldRow
      fields={[
        {
          label: t("envKey"),
          render: (id) => (
            <ValueField
              t={t}
              mode={mode}
              id={id}
              value={name}
              copyLabel={t("copyEnvKey", { key: name })}
            >
              <Input
                id={id}
                className={keyInvalid === true
                  ? `${SLOT_CLASS} ${SLOT_INVALID_CLASS}`
                  : SLOT_CLASS}
                value={name}
                disabled={disabledField}
                placeholder={t("secretEnvName")}
                autoFocus={autoFocus}
                onChange={(event) => onChangeName?.(event.target.value)}
              />
            </ValueField>
          ),
        },
        {
          label: t("envValue"),
          render: (id) => (
            <ValueField
              t={t}
              mode={mode}
              id={id}
              value={secret}
              copyLabel={t("copyEnvValue", { key: name })}
              trailing={removeControl}
            >
              <select
                id={id}
                style={slotSelect}
                value={secret}
                disabled={disabledField}
                onChange={(event) => onChangeSecret?.(event.target.value)}
              >
                {
                  /* A secret the snapshot no longer lists stays selectable
                     rather than being silently replaced. */
                }
                {candidates.some((candidate) => candidate.name === secret)
                  ? null
                  : <option value={secret}>{secret}</option>}
                {candidates.length === 0
                  ? <option value="">{t("none")}</option>
                  : null}
                {candidates.map((candidate) => (
                  <option key={candidate.name} value={candidate.name}>
                    {candidate.name}
                  </option>
                ))}
              </select>
            </ValueField>
          ),
        },
      ]}
    />
  );
}

// One published port, shared by the container block and the port editor: the
// container port, then the host port the gateway bound — or, while the gateway
// has not bound one yet, the host port the user asked for with "(pending)"
// appended inside the field, so the entered port stays visible — then the
// protocol, each copyable on its own. The block shows the port as it is; the
// editor adds the row's own Remove or Unpublish action.
export function PortRow(props: {
  t: Translate;
  mode: RowMode;
  port: number;
  protocol: string;
  hostPort: number;
  // The host port the user asked the gateway for; 0 when none was named.
  suggestedHostPort?: number;
  // Whether the gateway has not bound the port yet.
  pending?: boolean;
  disabled?: boolean;
  onRemove?: () => void;
  removeLabel?: string;
}): ReactNode {
  const {
    t,
    mode,
    port,
    protocol,
    hostPort,
    suggestedHostPort = 0,
    pending,
    disabled,
    onRemove,
    removeLabel,
  } = props;
  const containerPort = String(port);
  const bound = hostPort > 0 ? String(hostPort) : "";
  const requested = suggestedHostPort > 0 ? String(suggestedHostPort) : "";
  const hostValue = bound !== "" ? bound : requested;
  // A port the gateway has not bound yet keeps the value the user entered and
  // says so inside the field, rather than replacing the value with that fact.
  const pendingSuffix = pending === true ? t("portPendingSuffix") : "";
  const hostField = hostValue === ""
    ? pendingSuffix
    : pendingSuffix === ""
    ? hostValue
    : `${hostValue} ${pendingSuffix}`;
  return (
    <FieldRow
      fields={[
        {
          label: t("containerPort"),
          render: (id) => (
            <ValueField
              t={t}
              mode="view"
              id={id}
              value={containerPort}
              copyLabel={t("copyContainerPort", { port: containerPort })}
            />
          ),
        },
        {
          label: t("hostPort"),
          render: (id) => (
            <ValueField
              t={t}
              mode="view"
              id={id}
              value={hostField}
              copyValue={hostValue}
              copyLabel={t("copyHostPort", {
                port: hostValue === "" ? t("valueMissing") : hostValue,
              })}
            />
          ),
        },
        {
          label: t("protocol"),
          render: (id) => (
            <ValueField
              t={t}
              mode="view"
              id={id}
              value={protocol}
              copyLabel={t("copyProtocol", { protocol })}
            />
          ),
        },
      ]}
      actions={mode === "edit" && onRemove !== undefined
        ? (
          <Button
            variant="outline"
            size="sm"
            disabled={disabled === true}
            style={destructiveAction}
            onClick={onRemove}
          >
            {removeLabel ?? t("remove")}
          </Button>
        )
        : undefined}
    />
  );
}

// The tone a container's status reads with; an unreadable status stays neutral
// rather than guessing at a failure.
export function containerStatusTone(status: string): StatusTone {
  if (status === "running") return "ok";
  if (status === "missing") return "error";
  return "muted";
}

// The tone an image's status reads with: an image that is present (built or
// pulled) is fine, a missing one is a failure.
export function imageStatusTone(status: string): StatusTone {
  if (status === "built" || status === "pulled") return "ok";
  if (status === "missing") return "error";
  return "muted";
}

// A titled region of the card: a `<section>` with a real heading instead of a
// styled div, so assistive technology can name and navigate it. `action` is a
// control that shares the heading's line (Build, Create, Copy…).
export function Subsection(props: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}): ReactNode {
  const { title, action, children } = props;
  const headingId = useId();
  return (
    <section aria-labelledby={headingId}>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "8px",
        }}
      >
        <h3 id={headingId} style={{ ...sectionTitle, flex: 1 }}>{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

// One labelled group of a dialog: the heading, one line saying what the group
// is for, and its controls. The heading is a real heading under the dialog's
// own title (a dialog group is a `<section>`), and it never carries a rule.
export function DialogGroup(props: {
  title: string;
  // One line saying what the group is for; it is the group's guidance instead
  // of a dense field list, and a group that needs none omits it.
  guidance?: string;
  children: ReactNode;
}): ReactNode {
  const { title, guidance, children } = props;
  const headingId = useId();
  return (
    <section style={editorGroup} aria-labelledby={headingId}>
      <h3 id={headingId} style={sectionTitle}>{title}</h3>
      {guidance === undefined
        ? null
        : <p style={{ ...hint, margin: 0 }}>{guidance}</p>}
      {children}
    </section>
  );
}

// The short kind a mount row leads with, one chip per kind. The words reuse the
// kind picker's own labels wherever they are already short (tmpfs, Volume,
// Secret); a project gets a shorter one, since its picker entry also names the
// mount.
export const mountKindLabel = (t: Translate, kind: string): string => {
  const normalized = normalizeMountKind(kind);
  if (normalized === "tmpfs") return t("mountTmpfs");
  if (normalized === "volume") return t("mountVolume");
  if (normalized === "secret") return t("mountSecret");
  return t("mountProjectShort");
};

// The tone a mount's kind chip reads with: the business blue for a project, the
// success green for a volume, the warn amber for a secret, and a violet literal
// for tmpfs, which has no design-system token of its own.
export const mountKindTone = (kind: string): StatusTone => {
  const normalized = normalizeMountKind(kind);
  if (normalized === "volume") return "ok";
  if (normalized === "secret") return "warn";
  if (normalized === "tmpfs") return "violet";
  return "business";
};

// The label of the field carrying a mount's source: a project by its path, a
// volume and a secret by their own names. tmpfs has no source to label.
export const mountSourceLabel = (t: Translate, kind: string): string => {
  const normalized = normalizeMountKind(kind);
  if (normalized === "volume") return t("volumeName");
  if (normalized === "secret") return t("secretName");
  return t("mountPath");
};

// The source one mount names: its project path, its volume or its secret. tmpfs
// is the one kind that mounts no source at all.
export const mountSourceName = (mount: MountInput): string => {
  const normalized = normalizeMountKind(mount.kind);
  if (normalized === "volume") return mount.volume;
  if (normalized === "secret") return mount.secret;
  if (normalized === "project") return mount.project;
  return "";
};

// Whether a mount kind names a source at all. tmpfs is the one kind that mounts
// no source, so its row carries no source field.
export const mountHasSource = (kind: string): boolean =>
  normalizeMountKind(kind) !== "tmpfs";

// Whether a mount kind carries a mode at all. A project and a volume mount are
// the ones a caller may switch; a secret is fixed read-only and a tmpfs is
// always read-write, so neither shows a mode control.
export const mountHasMode = (kind: string): boolean => {
  const normalized = normalizeMountKind(kind);
  return normalized === "project" || normalized === "volume";
};

export const mountViewToInput = (mount: ProjectMountView): MountInput => {
  const kind = normalizeMountKind(mount.kind);
  return {
    kind,
    project: mount.projectName,
    // A project mount never carries a destination on the wire: the host derives
    // its mirror under the projects root. The snapshot keeps the derived path
    // for the container block to render.
    destination: kind === "project" ? "" : mount.destination,
    mode: normalizeMountMode(mount.mode),
    volume: mount.volume,
    secret: mount.secret,
  };
};

// The category a mount sorts under in an ordered mounts list: the workspace's
// main project mount first, then read-write projects, read-only projects,
// read-write volumes, read-only volumes, secrets and tmpfs.
function mountRank(mount: MountInput, mainProject: string): number {
  if (
    mount.kind === "project" && mainProject !== "" &&
    mount.project === mainProject
  ) {
    return 0;
  }
  if (mount.kind === "project") return mount.mode === "read_write" ? 1 : 2;
  if (mount.kind === "volume") return mount.mode === "read_write" ? 3 : 4;
  if (mount.kind === "secret") return 5;
  return 6;
}

// The mounts in the one order both the editors and a container block list them
// in: one category at a time, sorted by mounted path inside the category. Each
// entry keeps the index it has in the draft, so an edit or a removal still
// targets the entry behind the row.
export function orderedMounts(
  mounts: readonly MountInput[],
  mainProject: string,
): { mount: MountInput; index: number }[] {
  return mounts
    .map((mount, index) => ({ mount, index }))
    .sort((left, right) => {
      const rank = mountRank(left.mount, mainProject) -
        mountRank(right.mount, mainProject);
      if (rank !== 0) return rank;
      // A stable sort keeps the draft order inside a category when two mounts
      // share a destination.
      const a = left.mount.destination;
      const b = right.mount.destination;
      return a < b ? -1 : a > b ? 1 : 0;
    });
}

export const mountLabel = (
  t: (key: ContainerPluginKey) => string,
  mount: MountInput,
  withMode = true,
): string => {
  const destination = mount.destination !== "" ? ` → ${mount.destination}` : "";
  if (mount.kind === "tmpfs") {
    return `${t("mountTmpfs")}${
      mount.destination !== "" ? ` ${t("mountAt")} ${mount.destination}` : ""
    }`;
  }
  if (mount.kind === "volume") {
    return `${t("mountVolume")} ${mount.volume}${destination}`;
  }
  if (mount.kind === "secret") {
    return `${t("mountSecret")} ${mount.secret}${destination}`;
  }
  const mode = withMode
    ? ` ${
      t(
        mount.mode === "read_only"
          ? "mountReadOnlySuffix"
          : "mountReadWriteSuffix",
      )
    }`
    : "";
  return `${t("mountProject")} ${mount.project}${destination}${mode}`;
};

// The protocol status strings the orchestrator reports are localized here; a
// value the card does not know yet is shown as it arrived rather than hidden.
export function containerStatusLabel(t: Translate, status: string): string {
  if (status === "running") return t("statusRunning");
  if (status === "stopped") return t("statusStopped");
  return status;
}

export function imageStatusLabel(t: Translate, status: string): string {
  if (status === "built") return t("statusBuilt");
  if (status === "pulled") return t("statusPulled");
  if (status === "missing") return t("statusMissing");
  return status;
}

// Adding a mount defaults to read-only, so granting write access is always a
// deliberate choice. tmpfs is scratch space and must be writable.
export const emptyMount = (kind = "project"): MountInput => ({
  kind,
  project: "",
  destination: "",
  mode: kind === "tmpfs" ? "read_write" : "read_only",
  volume: "",
  secret: "",
});

// The step that keeps a dialog from closing over an unsaved draft: the caller
// routes every close (Cancel, the header button, Escape, the mask) through it
// and only closes once the user confirms the discard.
export function DiscardChangesModal(props: {
  t: Translate;
  open: boolean;
  onCancel: () => void;
  onDiscard: () => void;
}): ReactNode {
  const { t, open, onCancel, onDiscard } = props;
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={t("discardChangesTitle")}
      closeLabel={t("cancel")}
      footer={
        <>
          <Button variant="outline" size="sm" onClick={onCancel}>
            {t("cancel")}
          </Button>
          <Button variant="primary" size="sm" onClick={onDiscard}>
            {t("discardChanges")}
          </Button>
        </>
      }
    >
      <p style={{ ...hint, margin: 0 }}>{t("confirmDiscardChanges")}</p>
    </Modal>
  );
}

export function ConfirmButton(props: {
  t: Translate;
  label: string;
  title: string;
  description: string;
  // The id of the trigger, so a visible label can name it.
  id?: string;
  disabled?: boolean;
  // Whether this very action is in flight: the trigger is disabled and shows
  // progress, while unrelated commands leave it usable.
  pending?: boolean;
  ariaLabel?: string;
  // The visual weight of the trigger; a row's single primary action names
  // itself, while every other control stays an outline button.
  variant?: "primary" | "outline";
  // Whether the trigger is a removal: its text and stroke carry the error
  // state colour, while the confirming button keeps the dialog's own primary.
  destructive?: boolean;
  // The state colour a non-destructive trigger carries, so a cautious or
  // deliberate action reads as one; it is ignored when `destructive` is set,
  // since a removal always keeps the error colour.
  emphasis?: ActionEmphasis;
  // The wording of the confirming button; it defaults to the trigger's own
  // label so the dialog names the action instead of saying "Confirm".
  confirmLabel?: string;
  onConfirm: () => void;
}): ReactNode {
  const {
    t,
    label,
    title,
    description,
    id,
    disabled,
    pending,
    ariaLabel,
    variant,
    destructive,
    emphasis,
    onConfirm,
  } = props;
  const [open, setOpen] = useState(false);
  const confirm = (): void => {
    setOpen(false);
    onConfirm();
  };
  const triggerStyle = destructive === true
    ? destructiveAction
    : emphasis === undefined
    ? undefined
    : emphasisAction[emphasis];
  return (
    <>
      <Button
        id={id}
        variant={variant ?? "outline"}
        size="sm"
        disabled={disabled === true || pending === true}
        aria-label={ariaLabel}
        style={triggerStyle}
        onClick={() => setOpen(true)}
      >
        {pending === true ? t("busy") : label}
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={title}
        closeLabel={t("cancel")}
        footer={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setOpen(false)}
            >
              {t("cancel")}
            </Button>
            <Button variant="primary" size="sm" onClick={confirm}>
              {props.confirmLabel ?? label}
            </Button>
          </>
        }
      >
        <p style={{ ...hint, margin: 0 }}>{description}</p>
      </Modal>
    </>
  );
}

export function Chip(props: {
  t: Translate;
  label: string;
  disabled?: boolean;
  onRemove?: () => void;
}): ReactNode {
  const { t, label, disabled, onRemove } = props;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: "2px",
        height: "24px",
        padding: onRemove === undefined ? "0 8px" : "0 4px 0 8px",
        borderRadius: "999px",
        border: "1px solid var(--dsw-alias-border-l2)",
        background: "var(--dsw-alias-bg-layer-3)",
        fontSize: "12px",
        fontFamily: "var(--dsw-alias-font-mono, ui-monospace, monospace)",
        color: "var(--dsw-alias-label-primary)",
      }}
    >
      {label}
      {onRemove === undefined ? null : (
        <Button
          variant="ghost"
          size="sm"
          aria-label={`${t("removeTag")} ${label}`}
          disabled={disabled}
          onClick={onRemove}
          style={{
            padding: 0,
            minWidth: "18px",
            height: "18px",
            lineHeight: 1,
            fontSize: "13px",
            color: "var(--dsw-alias-label-tertiary)",
          }}
        >
          ×
        </Button>
      )}
    </span>
  );
}

export function TagInput(props: {
  t: Translate;
  value: readonly string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  // Whether the chips render under the input, in a slot whose height is
  // reserved even while it is empty, instead of wrapping beside it. The build
  // dialog's packages field uses it, so the input never moves while typing.
  chipsBelow?: boolean;
}): ReactNode {
  const { t, value, onChange, placeholder, disabled, id, chipsBelow } = props;
  const [draft, setDraft] = useState("");
  const commit = (raw: string): void => {
    const tag = raw.trim();
    if (tag === "" || value.includes(tag)) return;
    onChange([...value, tag]);
  };
  const chips = value.map((tag) => (
    <Chip
      key={tag}
      t={t}
      label={tag}
      disabled={disabled}
      onRemove={() => onChange(value.filter((item) => item !== tag))}
    />
  ));
  const field = (
    <Input
      id={id}
      value={draft}
      disabled={disabled}
      placeholder={placeholder}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === " " || event.key === "," || event.key === "Enter") {
          if (event.key === " " || event.key === ",") event.preventDefault();
          commit(draft);
          setDraft("");
        } else if (event.key === "Backspace" && draft === "") {
          const last = value[value.length - 1];
          if (last !== undefined) onChange(value.slice(0, -1));
        }
      }}
      onPaste={(event) => {
        const text = event.clipboardData.getData("text");
        if (text === "") return;
        event.preventDefault();
        const tokens = text.split(/[\s,]+/);
        const next = [...value];
        for (const token of tokens) {
          const tag = token.trim();
          if (tag !== "" && !next.includes(tag)) next.push(tag);
        }
        if (next.length !== value.length) onChange(next);
      }}
      style={chipsBelow ? { width: "100%" } : { flex: 1, minWidth: "160px" }}
    />
  );
  if (chipsBelow) {
    return (
      <div style={{ display: "flex", flexDirection: "column" }}>
        {field}
        <div style={tagSlot}>{chips}</div>
      </div>
    );
  }
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: "6px",
      }}
    >
      {chips}
      {field}
    </div>
  );
}

// The packages slot under the build dialog's input: its height is reserved from
// the first chip's own size, so the field below never shifts when a chip is
// added or removed.
const tagSlot: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "6px",
  minHeight: "24px",
  marginTop: "6px",
};
