// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import {
  Chip,
  ConfirmButton,
  Field,
  imageIdPattern,
  sanitizeImageId,
  TagInput,
} from "./container-card-shared.js";
import {
  actions,
  hint,
  imageSelect,
  tableStyle,
  tdStyle,
  thStyle,
  wsBody,
} from "./container-card-styles.js";
import { type ImageView } from "./container-card-controller.js";
import type { Translate } from "./locales.js";
import { Button, DisclosureRow, Input, Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import { type ReactNode, useId, useState } from "react";

export function ImageItem(props: {
  t: Translate;
  image: ImageView;
  busy: boolean;
  defaultImage: string;
  onRemove: (imageId: string) => void;
  onRebuild: (imageId: string) => void;
  onSetDefault: (imageId: string) => void;
}): ReactNode {
  const { t, image, busy, defaultImage, onRemove, onRebuild, onSetDefault } = props;
  const [open, setOpen] = useState(false);
  return (
    <DisclosureRow
      icon={<span />}
      title={image.imageId}
      open={open}
      expandable
      onToggle={() => setOpen(!open)}
    >
      <div style={wsBody}>
        <table style={tableStyle}>
          <tbody>
            <tr>
              <th style={thStyle} scope="row">{t("parent")}</th>
              <td style={tdStyle}>{image.parent}</td>
            </tr>
            <tr>
              <th style={thStyle} scope="row">{t("imageTag")}</th>
              <td style={tdStyle}>{image.imageTag}</td>
            </tr>
            <tr>
              <th style={thStyle} scope="row">{t("builtAt")}</th>
              <td style={tdStyle}>{image.builtAt}</td>
            </tr>
            <tr>
              <th style={thStyle} scope="row">{t("packages")}</th>
              <td style={tdStyle}>
                {image.packages.length === 0
                  ? (
                    t("none")
                  )
                  : (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                      {image.packages.map((pkg) => <Chip key={pkg} t={t} label={pkg} />)}
                    </div>
                  )}
              </td>
            </tr>
          </tbody>
        </table>
        <div style={actions}>
          <ConfirmButton
            t={t}
            label={t("rebuildImage")}
            title={t("confirmTitle")}
            description={t("confirmRebuildImage", { image: image.imageId })}
            disabled={busy}
            onConfirm={() => onRebuild(image.imageId)}
          />
          <ConfirmButton
            t={t}
            label={t("removeImage")}
            title={t("confirmTitle")}
            description={t("confirmRemoveImage", { image: image.imageId })}
            disabled={busy}
            onConfirm={() => onRemove(image.imageId)}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={busy || image.imageId === defaultImage}
            onClick={() => onSetDefault(image.imageId)}
          >
            {t("setDefaultImage")}
          </Button>
        </div>
      </div>
    </DisclosureRow>
  );
}

export function BaseImageRow(props: {
  t: Translate;
  image: ImageView;
  busy: boolean;
  defaultImage: string;
  onRebuild: (name: string) => void;
  onPull: (name: string) => void;
  onSetDefault: (imageId: string) => void;
}): ReactNode {
  const { t, image, busy, defaultImage, onRebuild, onPull, onSetDefault } = props;
  const [open, setOpen] = useState(false);
  const pull = image.basePublic && (image.status === "missing" || image.status === "pulled");
  const build = !image.basePublic && image.status === "missing";
  const rebuild = !image.basePublic && image.status === "built";
  return (
    <DisclosureRow
      icon={<span />}
      title={image.imageId}
      open={open}
      expandable
      onToggle={() => setOpen(!open)}
    >
      <div style={wsBody}>
        <table style={tableStyle}>
          <tbody>
            <tr>
              <th style={thStyle} scope="row">{t("primitive")}</th>
              <td style={tdStyle}>{image.primitive}</td>
            </tr>
            <tr>
              <th style={thStyle} scope="row">{t("packageManager")}</th>
              <td style={tdStyle}>{image.packageManager}</td>
            </tr>
            <tr>
              <th style={thStyle} scope="row">{t("status")}</th>
              <td style={tdStyle}>{image.status}</td>
            </tr>
            <tr>
              <th style={thStyle} scope="row">{t("builtAt")}</th>
              <td style={tdStyle}>{image.builtAt === "" ? t("none") : image.builtAt}</td>
            </tr>
            <tr>
              <th style={thStyle} scope="row">{t("packages")}</th>
              <td style={tdStyle}>
                {image.packages.length === 0
                  ? (
                    t("none")
                  )
                  : (
                    <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
                      {image.packages.map((pkg) => <Chip key={pkg} t={t} label={pkg} />)}
                    </div>
                  )}
              </td>
            </tr>
          </tbody>
        </table>
        <div style={actions}>
          {pull
            ? (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => onPull(image.imageId)}
              >
                {t("pullImage")}
              </Button>
            )
            : null}
          {build
            ? (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => onRebuild(image.imageId)}
              >
                {t("build")}
              </Button>
            )
            : null}
          {rebuild
            ? (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => onRebuild(image.imageId)}
              >
                {t("rebuildImage")}
              </Button>
            )
            : null}
          <Button
            variant="outline"
            size="sm"
            disabled={busy || image.imageId === defaultImage}
            onClick={() => onSetDefault(image.imageId)}
          >
            {t("setDefaultImage")}
          </Button>
        </div>
      </div>
    </DisclosureRow>
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
  const baseImages = images.filter((image) => image.isBase);
  const customImages = images.filter((image) => !image.isBase);
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
        <Field label={t("imageId")} htmlFor={imageIdLabel}>
          <Input
            id={imageIdLabel}
            value={imageId}
            onChange={(event) => onImageId(sanitizeImageId(event.target.value))}
          />
          {imageId !== "" && !imageIdPattern.test(imageId)
            ? <p style={{ ...hint, margin: 0 }}>{t("invalidImageId")}</p>
            : null}
        </Field>
        <Field label={t("parent")} htmlFor={parentLabel}>
          <select
            id={parentLabel}
            style={imageSelect}
            value={parent}
            onChange={(event) => onParent(event.target.value)}
          >
            <option value="">{t("selectImage")}</option>
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
          />
        </Field>
      </div>
    </Modal>
  );
}
