// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import {
  ConfirmButton,
  countLabel,
  Field,
  namePattern,
} from "./container-card-shared.js";
import { CardGroup } from "./container-card-group.js";
import { scopedActionKey } from "./card-protocol.js";
import {
  cardList,
  cardRow,
  containerNameHeading,
  hint,
  rowActions,
  rowDivider,
  rowMain,
} from "./container-card-styles.js";
import type { Translate } from "./locales.js";
import { Button, Input, Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import { type ReactNode, useId, useState } from "react";

export function VolumesSection(props: {
  t: Translate;
  volumes: readonly { name: string }[];
  busy: boolean;
  writable: boolean;
  pendingActions: readonly string[];
  onCreate: (name: string) => void;
  onRemove: (name: string) => void;
}): ReactNode {
  const { t, volumes, busy, writable, pendingActions, onCreate, onRemove } =
    props;
  const [open, setOpen] = useState(false);
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
    <CardGroup
      title={t("volumesTitle")}
      summary={countLabel(
        t,
        volumes.length,
        "countVolumeOne",
        "countVolumeMany",
      )}
      hasContent={volumes.length > 0}
      action={
        <Button
          variant="primary"
          size="sm"
          disabled={!writable || busy}
          onClick={() => setOpen(true)}
        >
          {t("createVolume")}
        </Button>
      }
    >
      {volumes.length === 0
        ? <p style={{ ...hint, margin: 0 }}>{t("noVolumes")}</p>
        : (
          <div style={cardList}>
            {volumes.map((volume, index) => (
              <div
                key={volume.name}
                style={index === volumes.length - 1
                  ? cardRow
                  : { ...cardRow, ...rowDivider }}
              >
                <div style={rowMain}>
                  <span style={containerNameHeading}>{volume.name}</span>
                </div>
                <div style={rowActions}>
                  <ConfirmButton
                    t={t}
                    destructive
                    label={t("removeVolume")}
                    title={t("removeVolumeTitle")}
                    description={t("confirmRemoveVolume", {
                      volume: volume.name,
                    })}
                    confirmLabel={t("removeVolumeTitle")}
                    pending={pendingActions.includes(
                      scopedActionKey("volume_remove", volume.name),
                    )}
                    onConfirm={() => onRemove(volume.name)}
                  />
                </div>
              </div>
            ))}
          </div>
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
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submit();
            }}
          />
          {name !== "" && !namePattern.test(name)
            ? (
              <p style={{ ...hint, margin: 0 }} role="alert">
                {t("invalidName")}
              </p>
            )
            : null}
        </Field>
      </Modal>
    </CardGroup>
  );
}
