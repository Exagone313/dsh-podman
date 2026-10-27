// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// The action a mount row offers beside its source field. It is decided by the
// kind alone: a project path is browsed for on the host, a volume opens the
// create-volume form and a secret the create-secret one, while tmpfs offers
// nothing. Creating from the row is what lets a volume or a secret mount be
// pointed at a storage that does not exist yet; both dialogs are the settings
// ones, so the validation and the host commands are the same everywhere.

import { CreateVolumeModal } from "./container-card-create-volume.js";
import {
  mountSourceAffordance,
  mountSourceCreationDisabled,
} from "./container-card-mount-sources.js";
import { SecretModal } from "./container-card-secrets.js";
import type { Translate } from "./locales.js";
import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import { type ReactNode, useState } from "react";

export function MountSourceActions(props: {
  t: Translate;
  kind: string;
  // The snapshot's write permission and whether a command is in flight, the
  // two gates the creation buttons share with the settings storage tab.
  writable: boolean;
  busy: boolean;
  // Whether the browse button is disabled. The creation buttons do not use it:
  // the default container's locked project mount must not block them.
  disabled: boolean;
  onBrowse?: () => void;
  onCreateVolume?: (name: string) => Promise<boolean>;
  onCreateSecret?: (
    name: string,
    length?: number,
    charset?: string,
  ) => Promise<boolean>;
}): ReactNode {
  const {
    t,
    kind,
    writable,
    busy,
    disabled,
    onBrowse,
    onCreateVolume,
    onCreateSecret,
  } = props;
  const [volumeOpen, setVolumeOpen] = useState(false);
  const [secretOpen, setSecretOpen] = useState(false);
  const affordance = mountSourceAffordance(kind);
  if (affordance === "browse") {
    return onBrowse === undefined ? null : (
      <Button
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={onBrowse}
      >
        {t("browse")}
      </Button>
    );
  }
  if (affordance === "create-volume") {
    return onCreateVolume === undefined ? null : (
      <>
        <Button
          variant="outline"
          size="sm"
          disabled={mountSourceCreationDisabled(writable, busy)}
          onClick={() => setVolumeOpen(true)}
        >
          {t("createVolume")}
        </Button>
        <CreateVolumeModal
          t={t}
          open={volumeOpen}
          busy={busy}
          writable={writable}
          onCreate={(name) => {
            void onCreateVolume(name);
          }}
          onClose={() => setVolumeOpen(false)}
        />
      </>
    );
  }
  if (affordance === "create-secret") {
    return onCreateSecret === undefined ? null : (
      <>
        <Button
          variant="outline"
          size="sm"
          disabled={mountSourceCreationDisabled(writable, busy)}
          onClick={() => setSecretOpen(true)}
        >
          {t("createSecret")}
        </Button>
        <SecretModal
          t={t}
          mode="create"
          open={secretOpen}
          busy={busy}
          writable={writable}
          onCreate={(name, length, charset) => {
            void onCreateSecret(name, length, charset);
          }}
          onClose={() => setSecretOpen(false)}
        />
      </>
    );
  }
  return null;
}
