// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// The two resource tabs: Images lists the images a container can be built from,
// Storage the volumes, secrets and package caches the container references.
// They are separate tabs because choosing an image and freeing storage are
// different tasks even though both act on the same build machinery.

import {
  BaseImageRow,
  ImageBuildModal,
  ImageItem,
} from "./container-card-images.js";
import { CachesSection } from "./container-card-caches.js";
import { SecretsSection } from "./container-card-secrets.js";
import { VolumesSection } from "./container-card-volumes.js";
import { CardGroup } from "./container-card-group.js";
import { countLabel } from "./container-card-shared.js";
import { TABLE_CARD_CLASS } from "./container-card-table-styles.js";
import {
  actionRow,
  cardList,
  emphasisAction,
  hint,
} from "./container-card-styles.js";
import { bareActionKey } from "./card-protocol.js";
import { type CacheView, type ImageView } from "./container-card-controller.js";
import { NS } from "./locales.js";
import { type TranslateNS } from "@deepseek-ai/dsh-client-ui-slots";
import {
  Button,
  RiskConfirmation,
} from "@deepseek-ai/dsh-client-ui-primitives";
import { type ReactNode, useState } from "react";

export function ImagesSection(props: {
  t: TranslateNS<typeof NS>;
  images: readonly ImageView[];
  busy: boolean;
  pendingActions: readonly string[];
  defaultImage: string;
  // The plugin's active locale, so each row dates its build time in it.
  locale: string;
  onBuildImage: (
    imageId: string,
    parent: string,
    packages: string[],
  ) => void;
  onRebuildAllImages: () => void;
  onRebuildBaseImage: (name: string) => void;
  onPullBaseImage: (name: string) => void;
  onRemoveImage: (imageId: string) => void;
  onRebuildImage: (imageId: string) => void;
  onSetDefaultImage: (name: string) => void;
}): ReactNode {
  const {
    t,
    images,
    busy,
    pendingActions,
    defaultImage,
    locale,
    onBuildImage,
    onRebuildAllImages,
    onRebuildBaseImage,
    onPullBaseImage,
    onRemoveImage,
    onRebuildImage,
    onSetDefaultImage,
  } = props;
  const [buildOpen, setBuildOpen] = useState(false);
  const [imageId, setImageId] = useState("");
  const [parent, setParent] = useState("");
  const [packages, setPackages] = useState<string[]>([]);
  const [rebuildAllOpen, setRebuildAllOpen] = useState(false);
  const [rebuildAllAcknowledged, setRebuildAllAcknowledged] = useState(false);
  const rebuildAllPending = pendingActions.includes(
    bareActionKey("image_rebuild_all"),
  );
  const baseImages = images.filter((image) => image.isBase);
  const customImages = images.filter((image) => !image.isBase);
  // Rebuilding covers every image, so it acts on the image set as a whole and
  // stays on the tab's toolbar; building makes a custom image, so its action
  // lives on that card's own title row instead.
  const openBuild = (): void => {
    // A build always starts from a real image: the configured default when it is
    // still a candidate, and the first listed image otherwise. The parent field
    // then never opens on an empty choice.
    const candidates = [...baseImages, ...customImages].map((image) =>
      image.imageId
    );
    setImageId("");
    setParent(
      candidates.includes(defaultImage) ? defaultImage : candidates[0] ?? "",
    );
    setPackages([]);
    setBuildOpen(true);
  };
  const openRebuildAll = (): void => {
    setRebuildAllAcknowledged(false);
    setRebuildAllOpen(true);
  };
  return (
    <>
      <div style={actionRow}>
        <Button
          variant="outline"
          size="sm"
          disabled={rebuildAllPending}
          // A deliberate build action rather than a removal: it carries the
          // business state colour, so it is not read as a neutral control.
          style={emphasisAction.business}
          onClick={openRebuildAll}
        >
          {rebuildAllPending ? t("busy") : t("rebuildAllImages")}
        </Button>
      </div>
      <CardGroup
        title={t("baseImagesTitle")}
        summary={countLabel(
          t,
          baseImages.length,
          "countImageOne",
          "countImageMany",
        )}
        hasContent={baseImages.length > 0}
        className={TABLE_CARD_CLASS}
      >
        {baseImages.length === 0
          ? <p style={{ ...hint, margin: 0 }}>{t("noBaseImages")}</p>
          : (
            <div style={cardList}>
              {baseImages.map((image, index) => (
                <BaseImageRow
                  key={image.imageId}
                  t={t}
                  image={image}
                  defaultImage={defaultImage}
                  locale={locale}
                  last={index === baseImages.length - 1}
                  pendingActions={pendingActions}
                  onRebuild={onRebuildBaseImage}
                  onPull={onPullBaseImage}
                  onSetDefault={onSetDefaultImage}
                />
              ))}
            </div>
          )}
      </CardGroup>
      <CardGroup
        title={t("customImagesTitle")}
        summary={countLabel(
          t,
          customImages.length,
          "countImageOne",
          "countImageMany",
        )}
        hasContent={customImages.length > 0}
        action={
          <Button
            variant="primary"
            size="sm"
            disabled={busy}
            onClick={openBuild}
          >
            {t("buildImage")}
          </Button>
        }
        className={TABLE_CARD_CLASS}
      >
        {customImages.length === 0
          ? <p style={{ ...hint, margin: 0 }}>{t("noCustomImages")}</p>
          : (
            <div style={cardList}>
              {customImages.map((image, index) => (
                <ImageItem
                  key={image.imageId}
                  t={t}
                  image={image}
                  defaultImage={defaultImage}
                  locale={locale}
                  last={index === customImages.length - 1}
                  pendingActions={pendingActions}
                  onRemove={onRemoveImage}
                  onRebuild={onRebuildImage}
                  onSetDefault={onSetDefaultImage}
                />
              ))}
            </div>
          )}
      </CardGroup>
      {
        /* Rebuilding every image in dependency order cannot be undone, so it
          is gated behind an explicit acknowledgement. */
      }
      <RiskConfirmation
        open={rebuildAllOpen}
        title={t("rebuildAllImagesTitle")}
        description={t("confirmRebuildAllImages")}
        acknowledgeLabel={t("acknowledgeRebuildAllImages")}
        cancelLabel={t("cancel")}
        closeLabel={t("cancel")}
        confirmLabel={t("rebuildAllImages")}
        acknowledged={rebuildAllAcknowledged}
        disabled={rebuildAllPending}
        onAcknowledgedChange={setRebuildAllAcknowledged}
        onCancel={() => {
          setRebuildAllAcknowledged(false);
          setRebuildAllOpen(false);
        }}
        onConfirm={() => {
          setRebuildAllAcknowledged(false);
          setRebuildAllOpen(false);
          onRebuildAllImages();
        }}
      />
      <ImageBuildModal
        t={t}
        images={images}
        open={buildOpen}
        imageId={imageId}
        parent={parent}
        packages={packages}
        onImageId={setImageId}
        onParent={setParent}
        onPackages={setPackages}
        onClose={() => setBuildOpen(false)}
        onBuild={() => {
          onBuildImage(imageId.trim(), parent.trim(), packages);
          setImageId("");
          setParent("");
          setPackages([]);
          setBuildOpen(false);
        }}
      />
    </>
  );
}

export function StorageSection(props: {
  t: TranslateNS<typeof NS>;
  volumes: readonly { name: string }[];
  secrets: readonly { name: string }[];
  caches: readonly CacheView[];
  busy: boolean;
  writable: boolean;
  pendingActions: readonly string[];
  onCleanCaches: (mode: string) => void;
  onCreateVolume: (name: string) => void;
  onRemoveVolume: (name: string) => void;
  onCreateSecret: (name: string, length?: number, charset?: string) => void;
  onRemoveSecret: (name: string) => void;
  onSetSecret: (name: string, value: string) => void;
}): ReactNode {
  const {
    t,
    volumes,
    secrets,
    caches,
    busy,
    writable,
    pendingActions,
    onCleanCaches,
    onCreateVolume,
    onRemoveVolume,
    onCreateSecret,
    onRemoveSecret,
    onSetSecret,
  } = props;
  return (
    <>
      <VolumesSection
        t={t}
        volumes={volumes}
        busy={busy}
        writable={writable}
        pendingActions={pendingActions}
        onCreate={onCreateVolume}
        onRemove={onRemoveVolume}
      />
      <SecretsSection
        t={t}
        secrets={secrets}
        busy={busy}
        writable={writable}
        pendingActions={pendingActions}
        onCreate={onCreateSecret}
        onRemove={onRemoveSecret}
        onSet={onSetSecret}
      />
      <CachesSection
        t={t}
        caches={caches}
        pendingActions={pendingActions}
        onClean={onCleanCaches}
      />
    </>
  );
}
