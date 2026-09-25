// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { ConfirmButton, Field, namePattern, sanitizeName } from "./container-card-shared.js";
import { greyId, hint, imageSelect, sectionTitle, wsBody } from "./container-card-styles.js";
import type { Translate } from "./locales.js";
import { Button, DisclosureRow, Input, Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import { type ReactNode, useId, useState } from "react";

export function SecretRow(props: {
  t: Translate;
  name: string;
  busy: boolean;
  writable: boolean;
  onSet: (name: string, value: string) => void;
  onRemove: (name: string) => void;
}): ReactNode {
  const { t, name, busy, writable, onSet, onRemove } = props;
  const [content, setContent] = useState("");
  const canSave = content !== "" && !busy;
  const submit = (): void => {
    if (content === "") return;
    onSet(name, content);
    setContent("");
  };
  return (
    <div
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
        {name}
      </code>
      <Input
        type="password"
        value={content}
        disabled={!writable || busy}
        placeholder={t("setSecret")}
        onChange={(event) => setContent(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") submit();
        }}
        style={{ width: "200px" }}
      />
      <ConfirmButton
        t={t}
        label={t("setSecret")}
        title={t("confirmTitle")}
        description={t("confirmSetSecret", { secret: name })}
        disabled={!writable || !canSave}
        onConfirm={submit}
      />
      <ConfirmButton
        t={t}
        label={t("removeSecret")}
        title={t("confirmTitle")}
        description={t("confirmRemoveSecret", { secret: name })}
        disabled={!writable || busy}
        onConfirm={() => onRemove(name)}
      />
    </div>
  );
}

export function SecretsSection(props: {
  t: Translate;
  secrets: readonly { name: string }[];
  busy: boolean;
  writable: boolean;
  onCreate: (name: string, length?: number, charset?: string) => void;
  onRemove: (name: string) => void;
  onSet: (name: string, value: string) => void;
}): ReactNode {
  const { t, secrets, busy, writable, onCreate, onRemove, onSet } = props;
  const [open, setOpen] = useState(false);
  const [openSecret, setOpenSecret] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [length, setLength] = useState("32");
  const [charset, setCharset] = useState("alphanumeric");
  const secretNameId = useId();
  const secretLengthId = useId();
  const secretCharsetId = useId();
  const canCreate = namePattern.test(name);
  const submit = (): void => {
    if (!namePattern.test(name)) return;
    const parsedLength = parseInt(length, 10);
    const normalized = length.trim() === "" || Number.isNaN(parsedLength) || parsedLength < 1
      ? undefined
      : parsedLength;
    onCreate(name.trim(), normalized, charset);
    setName("");
    setLength("32");
    setCharset("alphanumeric");
    setOpen(false);
  };
  return (
    <section>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "8px",
        }}
      >
        <div style={{ ...sectionTitle, flex: 1 }}>{t("secretsTitle")}</div>
        <Button
          variant="outline"
          size="sm"
          disabled={!writable || busy}
          onClick={() => setOpen(true)}
        >
          {t("createSecret")}
        </Button>
      </div>
      {secrets.length === 0 ? <p style={hint}>{t("none")}</p> : (
        secrets.map((secret) => (
          <DisclosureRow
            key={secret.name}
            icon={<span />}
            title={secret.name}
            open={openSecret === secret.name}
            expandable
            onToggle={() => setOpenSecret(openSecret === secret.name ? null : secret.name)}
          >
            <div style={wsBody}>
              <SecretRow
                t={t}
                name={secret.name}
                busy={busy}
                writable={writable}
                onSet={onSet}
                onRemove={onRemove}
              />
            </div>
          </DisclosureRow>
        ))
      )}
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={t("secretsTitle")}
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
            <Button
              variant="primary"
              size="sm"
              disabled={!canCreate}
              onClick={submit}
            >
              {t("createSecret")}
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
          <Field label={t("secretName")} htmlFor={secretNameId}>
            <Input
              id={secretNameId}
              value={name}
              disabled={!writable || busy}
              autoFocus
              onChange={(event) => setName(sanitizeName(event.target.value))}
              onKeyDown={(event) => {
                if (event.key === "Enter") submit();
              }}
            />
            {name !== "" && !namePattern.test(name)
              ? <p style={{ ...hint, margin: 0 }}>{t("invalidName")}</p>
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
      </Modal>
    </section>
  );
}
