// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// The default container environment: the map seeded into every new container,
// plus the git shortcut that fills the four identity variables from one name
// and one email.

import { EnvEditor } from "./container-card-editors.js";
import { ConfirmButton, Field } from "./container-card-shared.js";
import { greyId, hint } from "./container-card-styles.js";
import { readGitIdentity, setGitIdentity } from "../container-env.js";
import { type ContainerPluginKey } from "./locales.js";
import { Button, Input, Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import { type ReactNode, useId, useState } from "react";

function formatEnv(env: Record<string, string>): string {
  const entries = Object.entries(env);
  if (entries.length === 0) return "";
  return entries.map(([key, value]) => `${key}=${value}`).join(", ");
}

export function DefaultEnvironmentSection(props: {
  t: (key: ContainerPluginKey) => string;
  env: Record<string, string>;
  busy: boolean;
  writable: boolean;
  onSave: (env: Record<string, string>) => void;
  onSync: (workspace: string) => void;
}): ReactNode {
  const { t, env, busy, writable, onSave, onSync } = props;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, string>>(env);
  const [gitOpen, setGitOpen] = useState(false);
  const [gitName, setGitName] = useState("");
  const [gitEmail, setGitEmail] = useState("");
  const nameId = useId();
  const emailId = useId();
  const summary = formatEnv(env);
  const openEditor = (): void => {
    setDraft(env);
    setEditing(true);
  };
  const openGit = (): void => {
    const identity = readGitIdentity(env);
    setGitName(identity.name);
    setGitEmail(identity.email);
    setGitOpen(true);
  };
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "6px",
        padding: "8px 0",
      }}
    >
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "8px",
        }}
      >
        <label
          style={{
            fontSize: "13px",
            color: "var(--dsw-alias-label-secondary)",
            minWidth: "110px",
          }}
        >
          {t("defaultEnvironment")}
        </label>
        <code
          style={{
            ...greyId,
            flex: 1,
            fontSize: "13px",
            minWidth: "160px",
          }}
        >
          {summary === "" ? t("none") : summary}
        </code>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !writable}
          onClick={openEditor}
        >
          {t("edit")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !writable}
          onClick={openGit}
        >
          {t("gitIdentity")}
        </Button>
        <ConfirmButton
          t={t}
          label={t("applyDefaults")}
          title={t("confirmTitle")}
          description={t("confirmApplyDefaults")}
          disabled={busy || !writable || summary === ""}
          onConfirm={() => onSync("")}
        />
      </div>
      <p style={{ ...hint, margin: 0 }}>{t("defaultEnvironmentHint")}</p>
      <Modal
        open={editing}
        onClose={() => setEditing(false)}
        title={t("defaultEnvironment")}
        closeLabel={t("cancel")}
        footer={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEditing(false)}
            >
              {t("cancel")}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={busy}
              onClick={() => {
                onSave(draft);
                setEditing(false);
              }}
            >
              {t("save")}
            </Button>
          </>
        }
      >
        <EnvEditor t={t} env={draft} busy={busy} onChange={setDraft} />
      </Modal>
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
              disabled={busy || readGitIdentity(env).name === ""}
              onClick={() => {
                onSave(setGitIdentity(env, "", ""));
                setGitOpen(false);
              }}
            >
              {t("clear")}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setGitOpen(false)}>
              {t("cancel")}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={busy || gitName === "" || gitEmail === ""}
              onClick={() => {
                onSave(setGitIdentity(env, gitName, gitEmail));
                setGitOpen(false);
              }}
            >
              {t("save")}
            </Button>
          </>
        }
      >
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          <Field label={t("gitName")} htmlFor={nameId}>
            <Input
              id={nameId}
              value={gitName}
              disabled={busy}
              onChange={(event) => setGitName(event.target.value)}
            />
          </Field>
          <Field label={t("gitEmail")} htmlFor={emailId}>
            <Input
              id={emailId}
              value={gitEmail}
              disabled={busy}
              onChange={(event) => setGitEmail(event.target.value)}
            />
          </Field>
          <p style={{ ...hint, margin: 0 }}>{t("gitIdentityHint")}</p>
        </div>
      </Modal>
    </div>
  );
}
