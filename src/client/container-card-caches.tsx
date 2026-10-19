// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { ConfirmButton, countLabel } from "./container-card-shared.js";
import { CardGroup } from "./container-card-group.js";
import { scopedActionKey } from "./card-protocol.js";
import {
  cardList,
  cardRow,
  containerNameHeading,
  hint,
  rowDivider,
  rowMain,
  rowMeta,
} from "./container-card-styles.js";
import { type CacheView } from "./container-card-controller.js";
import { NS } from "./locales.js";
import { type TranslateNS } from "@deepseek-ai/dsh-client-ui-slots";
import { type ReactNode } from "react";

// Format a byte count with binary units, e.g. "1.2 GiB".
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? String(value) : value.toFixed(1)} ${units[unit]}`;
}

// The package-manager build caches: one row per manager with its current size,
// and the two cleanup actions on the card's title row. Keeping the latest
// versions only prunes older files, so it reads as the warn-tinted, cautious
// action it is; removing every cached package stays error-coloured, because it
// is a full clear.
export function CachesSection(props: {
  t: TranslateNS<typeof NS>;
  caches: readonly CacheView[];
  pendingActions: readonly string[];
  onClean: (mode: string) => void;
}): ReactNode {
  const { t, caches, pendingActions, onClean } = props;
  const disabled = caches.length === 0;
  return (
    <CardGroup
      title={t("cachesTitle")}
      summary={countLabel(t, caches.length, "countCacheOne", "countCacheMany")}
      hasContent={caches.length > 0}
      action={
        <>
          <ConfirmButton
            t={t}
            emphasis="warn"
            label={t("cacheKeepLatest")}
            title={t("cacheKeepLatest")}
            description={t("confirmCacheKeepLatest")}
            confirmLabel={t("cacheKeepLatest")}
            disabled={disabled}
            pending={pendingActions.includes(
              scopedActionKey("cache_clean", "keep-latest"),
            )}
            onConfirm={() => onClean("keep-latest")}
          />
          <ConfirmButton
            t={t}
            destructive
            label={t("cacheRemoveAll")}
            title={t("cacheRemoveAll")}
            description={t("confirmCacheRemoveAll")}
            confirmLabel={t("cacheRemoveAll")}
            disabled={disabled}
            pending={pendingActions.includes(
              scopedActionKey("cache_clean", "all"),
            )}
            onConfirm={() => onClean("all")}
          />
        </>
      }
    >
      {caches.length === 0
        ? <p style={{ ...hint, margin: 0 }}>{t("noCaches")}</p>
        : (
          <div style={cardList}>
            {caches.map((cache, index) => (
              <div
                key={cache.manager}
                style={index === caches.length - 1
                  ? cardRow
                  : { ...cardRow, ...rowDivider }}
              >
                <div style={rowMain}>
                  <span style={containerNameHeading}>{cache.manager}</span>
                  <span style={rowMeta}>
                    {t("cacheUsage", {
                      size: formatBytes(cache.bytes),
                      n: cache.files,
                    })}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
    </CardGroup>
  );
}
