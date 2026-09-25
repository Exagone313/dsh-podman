// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// The default container environment: the map seeded into every new container,
// edited with the same EnvEditor a container row uses. The setting is
// persisted, so the draft is committed with Save, and the git shortcut fills
// the four identity variables in that same draft.

import { EnvEditor } from "./container-card-editors.js";
import { ConfirmButton, Field } from "./container-card-shared.js";
import { hint, sectionTitle, wsBody } from "./container-card-styles.js";
import { readGitIdentity, setGitIdentity } from "../container-env.js";
import { type ContainerPluginKey } from "./locales.js";
import { Button, Input, Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import { type ReactNode, useEffect, useId, useState } from "react";

export function DefaultEnvironmentSection(props: {
  t: (key: ContainerPluginKey) => string;
  env: Record<string, string>;
  busy: boolean;
  writable: boolean;
  onSave: (env: Record<string, string>) => void;
  onSync: (workspace: string) => void;
}): ReactNode {
  const { t, env, busy, writable, onSave, onSync } = props;
  const [draft, setDraft] = useState<Record<string, string>>(env);
  const [gitOpen, setGitOpen] = useState(false);
  const [gitName, setGitName] = useState("");
  const [gitEmail, setGitEmail] = useState("");
  const nameId = useId();
  const emailId = useId();
  // An external settings change resyncs the draft; an unrelated refresh does
  // not, so an edit in progress is never clobbered. Same rule as a container
  // row's environment editor.
  const serverEnv = JSON.stringify(env);
  useEffect(() => {
    setDraft(env);
  }, [serverEnv]);
  const dirty = JSON.stringify(draft) !== serverEnv;
  const disabled = busy || !writable;
  const openGit = (): void => {
    const identity = readGitIdentity(draft);
    setGitName(identity.name);
    setGitEmail(identity.email);
    setGitOpen(true);
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      <div style={sectionTitle}>{t("defaultEnvironment")}</div>
      <div style={wsBody}>
        <EnvEditor t={t} env={draft} busy={disabled} onChange={setDraft} />
      </div>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "8px",
        }}
      >
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={openGit}
        >
          {t("gitIdentity")}
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={disabled || !dirty}
          onClick={() => onSave(draft)}
        >
          {t("save")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy || !dirty}
          onClick={() => setDraft(env)}
        >
          {t("discard")}
        </Button>
      </div>
      <div>
        <ConfirmButton
          t={t}
          label={t("applyDefaults")}
          title={t("confirmTitle")}
          description={t("confirmApplyDefaults")}
          disabled={disabled || dirty || Object.keys(env).length === 0}
          onConfirm={() => onSync("")}
        />
      </div>
      <p style={{ ...hint, margin: 0 }}>{t("defaultEnvironmentHint")}</p>
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
              disabled={busy || readGitIdentity(draft).name === ""}
              onClick={() => {
                setDraft(setGitIdentity(draft, "", ""));
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
                setDraft(setGitIdentity(draft, gitName, gitEmail));
                setGitOpen(false);
              }}
            >
              {t("apply")}
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
