// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { ConfirmButton, countLabel } from "./container-card-shared.js";
import { CardGroup } from "./container-card-group.js";
import { CreateVolumeModal } from "./container-card-create-volume.js";
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
import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import { type ReactNode, useState } from "react";

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
      <CreateVolumeModal
        t={t}
        open={open}
        busy={busy}
        writable={writable}
        onCreate={onCreate}
        onClose={() => setOpen(false)}
      />
    </CardGroup>
  );
}
