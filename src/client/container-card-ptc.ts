// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import {
  PTC_CONTAINER_NAME,
  PTC_IMAGE_ID,
  type PtcView,
} from "./card-protocol.js";
import type { ContainerPluginKey, Translate } from "./locales.js";

export { PTC_CONTAINER_NAME, PTC_IMAGE_ID };

// The one name the orchestrator reserves for a workspace's default container.
export const DEFAULT_CONTAINER_NAME = "default";

const RESERVED_CONTAINER_NAMES = [
  DEFAULT_CONTAINER_NAME,
  PTC_CONTAINER_NAME,
] as const;

export type ReservedContainerName = typeof RESERVED_CONTAINER_NAMES[number];

// reservedContainerName names the reserved container a typed name would claim,
// or undefined for a name the create form may offer.
export function reservedContainerName(
  name: string,
): ReservedContainerName | undefined {
  return RESERVED_CONTAINER_NAMES.find((reserved) => reserved === name);
}

// The translation key the PTC marker reads through. It stays a dictionary entry
// even though both languages spell it "PTC", so every visible string has one.
export const PTC_CHIP_KEY: ContainerPluginKey = "containerKindPtc";

// The marker repeats the container kind in the violet tone tmpfs already uses.
export const PTC_CHIP_TONE = "violet";

// The colour a PTC chip reads with, kept to the tones these rows use so this
// module stays a pure data helper the tests can import without the card's
// component tree.
export type PtcChipTone = "ok" | "muted" | "error" | "violet";

// One chip of a PTC row: its identity (the row renders them in order), the tone
// that repeats the fact in colour and the words that state it outright. A chip
// whose word alone needs context carries the sentence as a tooltip.
export interface PtcChipView {
  key: "state" | "ptc";
  tone: PtcChipTone;
  label: string;
  title?: string;
}

// The phrase the shared PTC container's state reads with. Absent is the normal
// state before the container is created on its first use, not an error, so it
// reads as Missing rather than as an absence the user has to interpret.
export function ptcStateLabel(t: Translate, state: PtcView["state"]): string {
  if (state === "running") return t("statusRunning");
  if (state === "stopped") return t("statusStopped");
  return t("statusMissing");
}

// The status chip of the shared container: a running one is fine and a stopped
// one is neutral, while an absent one is Missing in the muted tone — explicitly
// not the error red, since the container is created lazily on first use. The
// sentence explaining that laziness is the chip's tooltip rather than a line of
// its own.
export function ptcStatusChip(
  t: Translate,
  state: PtcView["state"],
): PtcChipView {
  const chip: PtcChipView = {
    key: "state",
    tone: state === "running" ? "ok" : "muted",
    label: ptcStateLabel(t, state),
  };
  return state === "absent" ? { ...chip, title: t("ptcMissing") } : chip;
}

// The marker chip every PTC row carries. Its tooltip says which PTC object the
// row describes, because the three-letter marker alone does not.
export function ptcChip(
  t: Translate,
  titleKey: "ptcContainerTooltip" | "ptcImageTooltip",
): PtcChipView {
  return {
    key: "ptc",
    tone: PTC_CHIP_TONE,
    label: t(PTC_CHIP_KEY),
    title: t(titleKey),
  };
}

// The PTC card's chips, in the order it renders them: the container's state,
// then the violet marker with the container's tooltip.
export function ptcChips(
  t: Translate,
  state: PtcView["state"],
): readonly PtcChipView[] {
  return [
    ptcStatusChip(t, state),
    ptcChip(t, "ptcContainerTooltip"),
  ];
}

// One action of the PTC card: the confirmation copy it opens with, whether it
// is a removal, and the command whose in-flight key disables it.
export interface PtcActionView {
  key: "recreate" | "remove";
  op: "ptc_recreate" | "ptc_remove";
  label: string;
  title: string;
  description: string;
  destructive: boolean;
}

// The PTC card's actions, in order: Recreate (the workspace-less remove
// followed by the ensure) and the destructive Remove. The container has no
// editable field, so both act on its fixed identity.
export function ptcActionViews(
  t: Translate,
  containerName: string,
): readonly PtcActionView[] {
  return [
    {
      key: "recreate",
      op: "ptc_recreate",
      label: t("recreate"),
      title: t("recreatePtcTitle"),
      description: t("confirmRecreatePtc", { container: containerName }),
      destructive: false,
    },
    {
      key: "remove",
      op: "ptc_remove",
      label: t("remove"),
      title: t("removePtcTitle"),
      description: t("confirmRemovePtc", { container: containerName }),
      destructive: true,
    },
  ];
}

// Whether an image is the one reserved for the shared PTC container.
export function isPtcImage(imageId: string): boolean {
  return imageId === PTC_IMAGE_ID;
}

// buildParentImages lists the images a custom-image build may choose as its
// parent: every image except the reserved PTC one, in snapshot order. The PTC
// image keeps its row in the base card, but the orchestrator owns its single
// on-demand build, so no build form may offer it as a parent.
export function buildParentImages<T extends { imageId: string }>(
  images: readonly T[],
): readonly T[] {
  return images.filter((image) => !isPtcImage(image.imageId));
}

// orderedImages lists the snapshot's images with the reserved PTC image last:
// the order a card fills itself from, so the base card can append the PTC row
// after the images it lists while the custom card never sees it.
export function orderedImages<T extends { imageId: string }>(
  images: readonly T[],
): readonly T[] {
  return [
    ...buildParentImages(images),
    ...images.filter((image) => isPtcImage(image.imageId)),
  ];
}

// The rows of the Images tab's two cards. The reserved PTC image is not a base
// image by origin, yet the base card lists it after its own rows; the custom
// card only holds the custom images, so it neither lists nor counts it.
export interface ImageCardRows<T> {
  // Every image of the editable set, in snapshot order: never the PTC one.
  editable: readonly T[];
  // The base card's own rows.
  base: readonly T[];
  // The reserved PTC image the base card appends, when the snapshot has it.
  ptc: T | undefined;
  // The custom card's rows.
  custom: readonly T[];
  // The count beside each card's title: the base card counts the reserved row
  // it lists, the custom card only its own.
  baseCount: number;
  customCount: number;
}

export function imageCardRows<T extends { imageId: string; isBase: boolean }>(
  images: readonly T[],
): ImageCardRows<T> {
  const listed = orderedImages(images);
  const ptc = listed.find((image) => isPtcImage(image.imageId));
  const editable = listed.filter((image) => !isPtcImage(image.imageId));
  const base = editable.filter((image) => image.isBase);
  const custom = editable.filter((image) => !image.isBase);
  return {
    editable,
    base,
    ptc,
    custom,
    baseCount: base.length + (ptc === undefined ? 0 : 1),
    customCount: custom.length,
  };
}

// The PTC image row: the image's name, its build date, its parent, its status
// chip and the violet marker, with a Build/Rebuild action beside a Set default
// button that is disabled, because the PTC image is never a workspace's
// default. Its tooltip states why rather than leaving the disabled control
// unexplained. A missing image reads in the error red like every other image
// row's Missing chip; only the Status card renders an absent container in the
// muted tone.
export interface PtcImageRowView {
  imageId: string;
  // The instant the image was built, shown the way every other image row dates
  // its own build; empty when the image is missing and has no build moment.
  builtAt: string;
  // The image the PTC image is built from, shown the way every other image row
  // shows its parent.
  parent: string;
  chips: readonly PtcChipView[];
  build: {
    label: string;
  };
  setDefault: {
    disabled: boolean;
    label: string;
    tooltip: string;
  };
}

export function ptcImageRow(
  t: Translate,
  image: {
    imageId: string;
    status: string;
    parent?: string;
    primitive?: string;
    builtAt?: string;
  },
): PtcImageRowView {
  const built = image.status === "built";
  const parent = image.parent ?? "";
  return {
    imageId: image.imageId,
    builtAt: image.builtAt ?? "",
    // The PTC image names its parent as the primitive it builds from; a row
    // that only carries that primitive still shows it rather than an empty
    // field.
    parent: parent !== "" ? parent : image.primitive ?? "",
    chips: [
      {
        key: "state",
        tone: built ? "ok" : "error",
        label: built ? t("statusBuilt") : t("statusMissing"),
      },
      ptcChip(t, "ptcImageTooltip"),
    ],
    // A missing PTC image is built through the container's ensure (which
    // creates the container too), while an existing one is only rebuilt.
    build: { label: built ? t("rebuildImage") : t("build") },
    setDefault: {
      disabled: true,
      label: t("setDefaultImage"),
      tooltip: t("ptcImageReserved"),
    },
  };
}
