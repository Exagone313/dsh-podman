// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import {
  Chip,
  ConfirmButton,
  Field,
  imageIdPattern,
  imageStatusLabel,
  imageStatusTone,
  StatusChip,
  TagInput,
} from "./container-card-shared.js";
import { bareActionKey, scopedActionKey } from "./card-protocol.js";
import { buildParentImages, ptcImageRow } from "./container-card-ptc.js";
import { FIELD_ROW_CLASS } from "./container-card-table-styles.js";
import {
  actionRow,
  cardBlockRow,
  containerNameHeading,
  hint,
  imageFieldLabel,
  imageFieldOwnLine,
  imageFields,
  imageFieldValue,
  imageSelect,
  rowActions,
  rowDivider,
  rowMain,
} from "./container-card-styles.js";
import { type ImageView } from "./container-card-controller.js";
import { relativeTimeLabel } from "./relative-time.js";
import type { Translate } from "./locales.js";
import {
  Button,
  Input,
  Modal,
  Pill,
} from "@deepseek-ai/dsh-client-ui-primitives";
import { type ReactNode, useId } from "react";

// The packages an image was built with, or the fact that none were recorded:
// chips on their own line under the Packages label.
function Packages(props: { t: Translate; image: ImageView }): ReactNode {
  const { t, image } = props;
  if (image.packages.length === 0) return t("noPackages");
  return (
    <>
      {image.packages.map((pkg) => <Chip key={pkg} t={t} label={pkg} />)}
    </>
  );
}

// One labelled line of an image's block: the field's label, then its value. The
// class keeps the label beside the value while the card has room and stacks it
// above once the card is narrow.
function ImageField(props: {
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

// The image's own block: line one is the name (14/600) with its status chip and
// the image's own actions at the line's right end, then one labelled line per
// field. The block's action group drops below the name when it no longer fits
// beside it; the destructive Remove is part of that same group, so a custom
// image's three actions read together.
function ImageBlock(props: {
  t: Translate;
  image: ImageView;
  defaultImage: string;
  // The plugin's active locale, for the build time's relative wording.
  locale: string;
  // The image's non-destructive actions (Build/Pull/Rebuild, Set default).
  actions: ReactNode;
}): ReactNode {
  const { t, image, defaultImage, locale, actions } = props;
  // The upstream image a base image is built from lives in `primitive`, while a
  // custom image names its parent; both are the image this one descends from.
  const source = image.parent !== "" ? image.parent : image.primitive;
  return (
    <div>
      <div style={actionRow}>
        <div style={rowMain}>
          <span style={containerNameHeading}>{image.imageId}</span>
          {image.imageId === defaultImage
            ? <Pill>{t("defaultImage")}</Pill>
            : null}
          <StatusChip
            tone={imageStatusTone(image.status)}
            label={imageStatusLabel(t, image.status)}
          />
        </div>
        <div style={rowActions}>{actions}</div>
      </div>
      <div style={imageFields}>
        {
          /* An image that was never built has no build moment, so the line is
            absent rather than a placeholder; the exact instant stays available
            as the tooltip, the way a container row dates itself. */
        }
        {image.builtAt === "" ? null : (
          <ImageField label={t("built")}>
            <span title={image.builtAt}>
              {relativeTimeLabel(image.builtAt, locale)}
            </span>
          </ImageField>
        )}
        {source === ""
          ? null
          : <ImageField label={t("parentImage")}>{source}</ImageField>}
        <ImageField label={t("packages")} ownLine>
          <Packages t={t} image={image} />
        </ImageField>
      </div>
    </div>
  );
}

// One custom image row: the image block with its Rebuild, Set default and
// destructive Remove together on the name line. The card's rows are hairline
// separated; the last row carries no divider.
export function ImageItem(props: {
  t: Translate;
  image: ImageView;
  defaultImage: string;
  locale: string;
  last: boolean;
  pendingActions: readonly string[];
  onRemove: (imageId: string) => void;
  onRebuild: (imageId: string) => void;
  onSetDefault: (imageId: string) => void;
}): ReactNode {
  const {
    t,
    image,
    defaultImage,
    locale,
    last,
    pendingActions,
    onRemove,
    onRebuild,
    onSetDefault,
  } = props;
  const rebuildPending = pendingActions.includes(
    scopedActionKey("image_rebuild", image.imageId),
  );
  const removePending = pendingActions.includes(
    scopedActionKey("image_remove", image.imageId),
  );
  return (
    <div style={last ? cardBlockRow : { ...cardBlockRow, ...rowDivider }}>
      <ImageBlock
        t={t}
        image={image}
        defaultImage={defaultImage}
        locale={locale}
        actions={
          <>
            <ConfirmButton
              t={t}
              label={t("rebuildImage")}
              title={t("rebuildImageTitle")}
              description={t("confirmRebuildImage", { image: image.imageId })}
              confirmLabel={t("rebuildImageTitle")}
              pending={rebuildPending}
              onConfirm={() => onRebuild(image.imageId)}
            />
            <Button
              variant="outline"
              size="sm"
              disabled={image.imageId === defaultImage}
              onClick={() => onSetDefault(image.imageId)}
            >
              {t("setDefaultImage")}
            </Button>
            <ConfirmButton
              t={t}
              destructive
              label={t("removeImage")}
              title={t("removeImageTitle")}
              description={t("confirmRemoveImage", { image: image.imageId })}
              confirmLabel={t("removeImageTitle")}
              pending={removePending}
              onConfirm={() => onRemove(image.imageId)}
            />
          </>
        }
      />
    </div>
  );
}

// One base image row: the same block and name-line actions, with the base
// image's own control (Pull, Build or Rebuild, depending on what the snapshot
// reports) beside Set default.
export function BaseImageRow(props: {
  t: Translate;
  image: ImageView;
  defaultImage: string;
  locale: string;
  last: boolean;
  pendingActions: readonly string[];
  onRebuild: (name: string) => void;
  onPull: (name: string) => void;
  onSetDefault: (imageId: string) => void;
}): ReactNode {
  const {
    t,
    image,
    defaultImage,
    locale,
    last,
    pendingActions,
    onRebuild,
    onPull,
    onSetDefault,
  } = props;
  const pullPending = pendingActions.includes(
    scopedActionKey("image_base_pull", image.imageId),
  );
  const rebuildPending = pendingActions.includes(
    scopedActionKey("image_base_rebuild", image.imageId),
  );
  const pull = image.basePublic &&
    (image.status === "missing" || image.status === "pulled");
  const build = !image.basePublic && image.status === "missing";
  const rebuild = !image.basePublic && image.status === "built";
  return (
    <div style={last ? cardBlockRow : { ...cardBlockRow, ...rowDivider }}>
      <ImageBlock
        t={t}
        image={image}
        defaultImage={defaultImage}
        locale={locale}
        actions={
          <>
            {pull
              ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pullPending}
                  onClick={() => onPull(image.imageId)}
                >
                  {pullPending ? t("busy") : t("pullImage")}
                </Button>
              )
              : null}
            {build
              ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={rebuildPending}
                  onClick={() => onRebuild(image.imageId)}
                >
                  {rebuildPending ? t("busy") : t("build")}
                </Button>
              )
              : null}
            {rebuild
              ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={rebuildPending}
                  onClick={() => onRebuild(image.imageId)}
                >
                  {rebuildPending ? t("busy") : t("rebuildImage")}
                </Button>
              )
              : null}
            <Button
              variant="outline"
              size="sm"
              disabled={image.imageId === defaultImage}
              onClick={() => onSetDefault(image.imageId)}
            >
              {t("setDefaultImage")}
            </Button>
          </>
        }
      />
    </div>
  );
}

// The one reserved PTC image row: the image's name, its status chip and the
// violet PTC marker, its build date and parent line, then its Build/Rebuild
// action beside the disabled Set default. The PTC image is never a workspace's
// default, so that button stays disabled and its tooltip says why; the row has
// no Remove and is not a parent candidate, because the orchestrator owns its
// single image.
export function PtcImageRow(props: {
  t: Translate;
  image: ImageView;
  // The plugin's active locale, for the build time's relative wording.
  locale: string;
  last: boolean;
  pendingActions: readonly string[];
  onRebuild: (imageId: string) => void;
  // Building a missing image also creates the container, so it goes through
  // the ensure rather than the image-only rebuild.
  onBuild: () => void;
}): ReactNode {
  const {
    t,
    image,
    locale,
    last,
    pendingActions,
    onRebuild,
    onBuild,
  } = props;
  const row = ptcImageRow(t, image);
  const built = image.status === "built";
  const pending = pendingActions.includes(
    built
      ? scopedActionKey("image_rebuild", image.imageId)
      : bareActionKey("ptc_build"),
  );
  return (
    <div style={last ? cardBlockRow : { ...cardBlockRow, ...rowDivider }}>
      <div style={actionRow}>
        <div style={rowMain}>
          <span style={containerNameHeading}>{row.imageId}</span>
          {row.chips.map((chip) => (
            <StatusChip
              key={chip.key}
              tone={chip.tone}
              label={chip.label}
              title={chip.title}
            />
          ))}
        </div>
        <div style={rowActions}>
          <Button
            variant="outline"
            size="sm"
            disabled={pending}
            onClick={() => (built ? onRebuild(image.imageId) : onBuild())}
          >
            {pending ? t("busy") : row.build.label}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={row.setDefault.disabled}
            title={row.setDefault.tooltip}
          >
            {row.setDefault.label}
          </Button>
        </div>
      </div>
      <div style={imageFields}>
        {
          /* A missing image was never built, so the line is absent there just
            as it is on every other row; the exact instant stays available as
            the tooltip. */
        }
        {row.builtAt === "" ? null : (
          <ImageField label={t("built")}>
            <span title={row.builtAt}>
              {relativeTimeLabel(row.builtAt, locale)}
            </span>
          </ImageField>
        )}
        {row.parent === ""
          ? null
          : <ImageField label={t("parentImage")}>{row.parent}</ImageField>}
      </div>
    </div>
  );
}

export function ImageBuildModal(props: {
  t: Translate;
  images: readonly { imageId: string; isBase: boolean }[];
  open: boolean;
  imageId: string;
  parent: string;
  packages: readonly string[];
  onImageId: (value: string) => void;
  onParent: (value: string) => void;
  onPackages: (tags: string[]) => void;
  onClose: () => void;
  onBuild: () => void;
}): ReactNode {
  const {
    t,
    images,
    open,
    imageId,
    parent,
    packages,
    onImageId,
    onParent,
    onPackages,
    onClose,
    onBuild,
  } = props;
  const canBuild = imageIdPattern.test(imageId) && parent.trim() !== "";
  const imageIdLabel = useId();
  const parentLabel = useId();
  const packagesLabel = useId();
  // The parent choices exclude the reserved PTC image even if the caller hands
  // in the whole snapshot: the PTC image is listed in the base card but built
  // only by the orchestrator, never as a custom image's parent.
  const parentImages = buildParentImages(images);
  const baseImages = parentImages.filter((image) => image.isBase);
  const customImages = parentImages.filter((image) => !image.isBase);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("buildImageTitle")}
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
            disabled={!canBuild}
            onClick={onBuild}
          >
            {t("buildImage")}
          </Button>
        </>
      }
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: "12px",
        }}
      >
        <Field label={t("imageName")} htmlFor={imageIdLabel}>
          <Input
            id={imageIdLabel}
            value={imageId}
            onChange={(event) => onImageId(event.target.value)}
          />
          {imageId !== "" && !imageIdPattern.test(imageId)
            ? (
              <p style={{ ...hint, margin: 0 }} role="alert">
                {t("invalidImageId")}
              </p>
            )
            : null}
        </Field>
        <Field label={t("parentImage")} htmlFor={parentLabel}>
          <select
            id={parentLabel}
            style={imageSelect}
            value={parent}
            onChange={(event) => onParent(event.target.value)}
          >
            {baseImages.map((image) => (
              <option key={image.imageId} value={image.imageId}>
                {image.imageId}
              </option>
            ))}
            {customImages.map((image) => (
              <option key={image.imageId} value={image.imageId}>
                {image.imageId}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("packages")} htmlFor={packagesLabel}>
          <TagInput
            id={packagesLabel}
            t={t}
            value={packages}
            onChange={onPackages}
            chipsBelow
          />
        </Field>
      </div>
    </Modal>
  );
}
