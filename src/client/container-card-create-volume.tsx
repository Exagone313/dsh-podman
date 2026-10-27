// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// The one create-volume form. The settings Storage tab and a volume mount row in
// the container editor both open it, so a volume is named and validated once, in
// the same surface, wherever it is created from. It owns its draft and clears it
// on a successful create; the caller learns the created name and lists it, or
// selects it in its own picker, once the host answers.

import { Field } from "./container-card-shared.js";
import { hint } from "./container-card-styles.js";
import { createdName } from "./container-card-names.js";
import type { Translate } from "./locales.js";
import { Button, Input, Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import { type ReactNode, useId, useState } from "react";

export function CreateVolumeModal(props: {
  t: Translate;
  open: boolean;
  busy: boolean;
  writable: boolean;
  onCreate: (name: string) => void;
  onClose: () => void;
}): ReactNode {
  const { t, open, busy, writable, onCreate, onClose } = props;
  const [name, setName] = useState("");
  const volumeId = useId();
  const canCreate = createdName(name) !== undefined;
  const submit = (): void => {
    const volume = createdName(name);
    if (volume === undefined) return;
    onCreate(volume);
    setName("");
    onClose();
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("volumesTitle")}
      closeLabel={t("cancel")}
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
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit();
          }}
        />
        {name !== "" && !canCreate
          ? (
            <p style={{ ...hint, margin: 0 }} role="alert">
              {t("invalidName")}
            </p>
          )
          : null}
      </Field>
    </Modal>
  );
}
