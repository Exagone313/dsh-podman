// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// The facts half of an image's block, shared by the settings images tab and the
// template details popup: the name with its status chip and optional default
// pill, the build time, the image it descends from and its packages. The
// settings tab adds the image's own actions through the slot, so both places
// read the same facts instead of drifting.

import {
  Chip,
  imageStatusLabel,
  imageStatusTone,
  StatusChip,
} from "./container-card-shared.js";
import { FIELD_ROW_CLASS } from "./container-card-table-styles.js";
import {
  actionRow,
  containerNameHeading,
  imageFieldLabel,
  imageFieldOwnLine,
  imageFields,
  imageFieldValue,
  rowActions,
  rowMain,
} from "./container-card-styles.js";
import { relativeTimeLabel } from "./relative-time.js";
import type { Translate } from "./locales.js";
import { Pill } from "@deepseek-ai/dsh-client-ui-primitives";
import { type ReactNode } from "react";

// The packages an image was built with, or the fact that none were recorded:
// chips on their own line under the Packages label.
function Packages(props: {
  t: Translate;
  packages: readonly string[];
}): ReactNode {
  const { t, packages } = props;
  if (packages.length === 0) return t("noPackages");
  return (
    <>
      {packages.map((pkg) => <Chip key={pkg} t={t} label={pkg} />)}
    </>
  );
}

// One labelled line of an image's block: the field's label, then its value. The
// class keeps the label beside the value while the block has room and stacks it
// above once it is narrow.
export function ImageField(props: {
  label: string;
  ownLine?: boolean;
  children: ReactNode;
}): ReactNode {
  const { label, ownLine, children } = props;
  return (
    <div className={FIELD_ROW_CLASS}>
      <span style={imageFieldLabel}>{label}</span>
      {ownLine === true
        ? <div style={imageFieldOwnLine}>{children}</div>
        : <span style={imageFieldValue}>{children}</span>}
    </div>
  );
}

// ImageFacts is an image's own block: line one is the name (14/600) with its
// status chip and, for the default image, its pill; the image's own actions sit
// at the line's right end when the caller passes them. Below are one labelled
// line per fact. The action group drops below the name when it no longer fits
// beside it.
export function ImageFacts(props: {
  t: Translate;
  // The plugin's active locale, for the build time's relative wording.
  locale: string;
  imageId: string;
  status: string;
  // The instant the image was built, or "" when no record dates it: the line is
  // then absent rather than a placeholder, and the exact instant stays available
  // as the tooltip the way a container row dates itself.
  builtAt: string;
  // The image this one descends from: a custom image's parent, or a base
  // image's primitive. Empty when neither is known.
  source: string;
  // The packages the image was built with: a base-only image has no package
  // list at all, so the field is omitted rather than stating "No packages.".
  packages?: readonly string[] | undefined;
  // Whether this is the plugin's default image, which carries its own pill.
  isDefault?: boolean;
  // The image's own controls, at the line's right end.
  actions?: ReactNode;
}): ReactNode {
  const {
    t,
    locale,
    imageId,
    status,
    builtAt,
    source,
    packages,
    isDefault,
    actions,
  } = props;
  return (
    <div>
      <div style={actionRow}>
        <div style={rowMain}>
          <span style={containerNameHeading}>{imageId}</span>
          {isDefault === true ? <Pill>{t("defaultImage")}</Pill> : null}
          <StatusChip
            tone={imageStatusTone(status)}
            label={imageStatusLabel(t, status)}
          />
        </div>
        {actions === undefined ? null : <div style={rowActions}>{actions}</div>}
      </div>
      <div style={imageFields}>
        {builtAt === "" ? null : (
          <ImageField label={t("built")}>
            <span title={builtAt}>{relativeTimeLabel(builtAt, locale)}</span>
          </ImageField>
        )}
        {source === ""
          ? null
          : <ImageField label={t("parentImage")}>{source}</ImageField>}
        {packages === undefined
          ? null
          : (
            <ImageField label={t("packages")} ownLine>
              <Packages t={t} packages={packages} />
            </ImageField>
          )}
      </div>
    </div>
  );
}
