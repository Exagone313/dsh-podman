// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { ConfirmButton, Field, namePattern, sanitizeName } from "./container-card-shared.js";
import { hint, sectionTitle, wsBody } from "./container-card-styles.js";
import type { Translate } from "./locales.js";
import { Button, DisclosureRow, Input, Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import { type ReactNode, useId, useState } from "react";

export function VolumesSection(props: {
  t: Translate;
  volumes: readonly { name: string }[];
  busy: boolean;
  writable: boolean;
  onCreate: (name: string) => void;
  onRemove: (name: string) => void;
}): ReactNode {
  const { t, volumes, busy, writable, onCreate, onRemove } = props;
  const [open, setOpen] = useState(false);
  const [openVolume, setOpenVolume] = useState<string | null>(null);
  const [name, setName] = useState("");
  const volumeId = useId();
  const canCreate = namePattern.test(name);
  const submit = (): void => {
    if (!namePattern.test(name)) return;
    onCreate(name.trim());
    setName("");
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
        <div style={{ ...sectionTitle, flex: 1 }}>{t("volumesTitle")}</div>
        <Button
          variant="outline"
          size="sm"
          disabled={!writable || busy}
          onClick={() => setOpen(true)}
        >
          {t("createVolume")}
        </Button>
      </div>
      {volumes.length === 0 ? <p style={hint}>{t("none")}</p> : (
        volumes.map((volume) => (
          <DisclosureRow
            key={volume.name}
            icon={<span />}
            title={volume.name}
            open={openVolume === volume.name}
            expandable
            onToggle={() => setOpenVolume(openVolume === volume.name ? null : volume.name)}
          >
            <div style={wsBody}>
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  alignItems: "center",
                  gap: "8px",
                }}
              >
                <ConfirmButton
                  t={t}
                  label={t("removeVolume")}
                  title={t("confirmTitle")}
                  description={t("confirmRemoveVolume", { volume: volume.name })}
                  disabled={busy}
                  onConfirm={() => onRemove(volume.name)}
                />
              </div>
            </div>
          </DisclosureRow>
        ))
      )}
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={t("volumesTitle")}
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
              {t("createVolume")}
            </Button>
          </>
        }
      >
        <Field label={t("volumeName")} htmlFor={volumeId}>
          <Input
            id={volumeId}
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
      </Modal>
    </section>
  );
}
