// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { ConfirmButton, Field, emptyMount, mountLabel } from "./container-card-shared.js";
import { greyId, imageSelect } from "./container-card-styles.js";
import { type MountInput } from "./container-card-controller.js";
import { type ContainerPluginKey } from "./locales.js";
import { Button, Input, Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import { type ReactNode, useId, useState } from "react";

export function EnvEditor(props: {
  t: (key: ContainerPluginKey) => string;
  env: Record<string, string>;
  busy: boolean;
  onChange: (env: Record<string, string>) => void;
}): ReactNode {
  const { t, env, busy, onChange } = props;
  const entries = Object.entries(env);
  const updateKey = (oldKey: string, key: string, value: string): void => {
    const next: Record<string, string> = {};
    for (const [k, v] of entries) {
      if (k !== oldKey) next[k] = v;
    }
    next[key] = value;
    onChange(next);
  };
  const updateValue = (key: string, value: string): void => {
    onChange({ ...env, [key]: value });
  };
  const remove = (key: string): void => {
    const next: Record<string, string> = { ...env };
    delete next[key];
    onChange(next);
  };
  const add = (): void => {
    onChange({ ...env, "": "" });
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      {entries.map(([key, value]) => (
        <div
          key={key}
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            gap: "8px",
          }}
        >
          <Input
            value={key}
            disabled={busy}
            placeholder={t("envKey")}
            aria-label={t("envKey")}
            onChange={(event) => updateKey(key, event.target.value, value)}
            style={{ width: "160px" }}
          />
          <Input
            value={value}
            disabled={busy}
            placeholder={t("envValue")}
            aria-label={t("envValue")}
            onChange={(event) => updateValue(key, event.target.value)}
            style={{ width: "200px" }}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => remove(key)}
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
  confirmRemove?: boolean;
  onAdd: (mount: MountInput) => void;
  onRemove: (mount: MountInput) => void;
}): ReactNode {
  const {
    t,
    mounts,
    volumes,
    secrets,
    busy,
    enabled,
    confirmRemove,
    onAdd,
    onRemove,
  } = props;
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<MountInput>(emptyMount());
  const mountKindId = useId();
  const mountProjectId = useId();
  const mountPathId = useId();
  const mountDestinationId = useId();
  const mountModeId = useId();
  const mountVolumeId = useId();
  const mountSecretId = useId();
  const updateDraft = (patch: Partial<MountInput>): void => {
    setDraft((prev) => ({ ...prev, ...patch }));
  };
  const canAdd =
    draft.kind === "project"
      ? draft.project.trim() !== ""
      : draft.kind === "volume"
        ? draft.volume !== ""
        : draft.kind === "secret"
          ? draft.secret !== ""
          : true;
  const openAdd = (): void => {
    setDraft(emptyMount());
    setAdding(true);
  };
  const submit = (): void => {
    if (!canAdd) return;
    onAdd(draft);
    setAdding(false);
  };
  const kindField =
    draft.kind === "tmpfs" ? (
      <Field label={t("mountDestination")} htmlFor={mountDestinationId}>
        <Input
          id={mountDestinationId}
          value={draft.destination}
          disabled={busy}
          onChange={(event) => updateDraft({ destination: event.target.value })}
        />
      </Field>
    ) : draft.kind === "volume" ? (
      <>
        <Field label={t("mountVolume")} htmlFor={mountVolumeId}>
          <select
            id={mountVolumeId}
            style={imageSelect}
            value={draft.volume}
            disabled={busy}
            onChange={(event) => updateDraft({ volume: event.target.value })}
          >
            {volumes.length === 0 ? (
              <option value="">{t("none")}</option>
            ) : null}
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
    ) : draft.kind === "secret" ? (
      <>
        <Field label={t("mountSecret")} htmlFor={mountSecretId}>
          <select
            id={mountSecretId}
            style={imageSelect}
            value={draft.secret}
            disabled={busy}
            onChange={(event) => updateDraft({ secret: event.target.value })}
          >
            {secrets.length === 0 ? (
              <option value="">{t("none")}</option>
            ) : null}
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
    ) : (
      <>
        <Field label={t("mountProject")} htmlFor={mountProjectId}>
          <Input
            id={mountProjectId}
            value={draft.project}
            disabled={busy}
            onChange={(event) => updateDraft({ project: event.target.value })}
          />
        </Field>
        <Field label={t("mountPath")} htmlFor={mountPathId}>
          <Input
            id={mountPathId}
            value={draft.path}
            disabled={busy}
            onChange={(event) => updateDraft({ path: event.target.value })}
          />
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
    );
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      {mounts.map((mount) => (
        <div
          key={mountLabel(t, mount)}
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
            {mountLabel(t, mount)}
          </code>
          {confirmRemove ? (
            <ConfirmButton
              t={t}
              label={t("remove")}
              title={t("confirmTitle")}
              description={t("confirmRemoveMount")}
              disabled={!enabled}
              onConfirm={() => onRemove(mount)}
            />
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={!enabled}
              onClick={() => onRemove(mount)}
            >
              {t("remove")}
            </Button>
          )}
        </div>
      ))}
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
              <option value="tmpfs">tmpfs</option>
              <option value="volume">{t("mountVolume")}</option>
              <option value="secret">{t("mountSecret")}</option>
            </select>
          </Field>
          {kindField}
        </div>
      </Modal>
    </div>
  );
}
