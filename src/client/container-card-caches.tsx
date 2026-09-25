// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { ConfirmButton } from "./container-card-shared.js";
import { hint, sectionTitle, wsBody } from "./container-card-styles.js";
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

// The package-manager build caches: their current size and the two cleanup
// actions. The caches are re-downloadable, so neither action is destructive.
export function CachesSection(props: {
  t: TranslateNS<typeof NS>;
  caches: readonly CacheView[];
  busy: boolean;
  onClean: (mode: string) => void;
}): ReactNode {
  const { t, caches, busy, onClean } = props;
  const disabled = busy || caches.length === 0;
  return (
    <>
      <div style={sectionTitle}>{t("cachesTitle")}</div>
      <div style={wsBody}>
        {caches.length === 0 ? <p style={{ ...hint, margin: 0 }}>{t("noCaches")}</p> : (
          caches.map((cache) => (
            <div
              key={cache.manager}
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                gap: "8px",
              }}
            >
              <strong style={{ color: "var(--dsw-alias-label-primary)" }}>
                {cache.manager}
              </strong>
              <span style={hint}>
                {t("cacheUsage", { size: formatBytes(cache.bytes), n: cache.files })}
              </span>
            </div>
          ))
        )}
        <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
          <ConfirmButton
            t={t}
            label={t("cacheKeepLatest")}
            title={t("confirmTitle")}
            description={t("confirmCacheKeepLatest")}
            disabled={disabled}
            onConfirm={() => onClean("keep-latest")}
          />
          <ConfirmButton
            t={t}
            label={t("cacheRemoveAll")}
            title={t("confirmTitle")}
            description={t("confirmCacheRemoveAll")}
            disabled={disabled}
            onConfirm={() => onClean("all")}
          />
        </div>
      </div>
    </>
  );
}
