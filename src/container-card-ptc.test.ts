// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  buildParentImages,
  imageCardRows,
  isPtcImage,
  orderedImages,
  PTC_CHIP_KEY,
  PTC_CHIP_TONE,
  PTC_CONTAINER_NAME,
  PTC_IMAGE_ID,
  ptcActionViews,
  ptcChips,
  ptcImageRow,
  ptcStateLabel,
  reservedContainerName,
} from "./client/container-card-ptc.js";
import { absentPtcView } from "./client/card-protocol.js";
import { en, type Translate, zh } from "./client/locales.js";

// The dictionary lookup the components receive, with its placeholder
// interpolation, so the copy a row builds is asserted as the user reads it.
const translate: Translate = (key, params) => {
  const text = en[key];
  if (params === undefined) return text;
  return Object.entries(params).reduce(
    (result, [name, value]) => result.replaceAll(`{${name}}`, value),
    text,
  );
};

// A client source file, read only in a source checkout: `pnpm test` runs from
// dist/, where the card's sources are not shipped.
function clientSource(name: string): string | undefined {
  const url = new URL(`../src/client/${name}`, import.meta.url);
  return existsSync(url) ? readFileSync(url, "utf8") : undefined;
}

test("the PTC marker chip is violet, reads PTC and explains itself", () => {
  assert.equal(PTC_CHIP_TONE, "violet");
  assert.equal(en[PTC_CHIP_KEY], "PTC");
  assert.equal(zh[PTC_CHIP_KEY], "PTC");
  // Both PTC chips carry their own tooltip, translated in both languages.
  assert.equal(
    en.ptcContainerTooltip,
    "This container is used for Programmatic Tool Calling",
  );
  assert.equal(
    en.ptcImageTooltip,
    "This image is used for Programmatic Tool Calling",
  );
  assert.equal(zh.ptcContainerTooltip, "此容器用于程序化工具调用");
  assert.equal(zh.ptcImageTooltip, "此镜像用于程序化工具调用");
});

test("the shared PTC state reads running, stopped or missing", () => {
  assert.equal(ptcStateLabel(translate, "running"), en.statusRunning);
  assert.equal(ptcStateLabel(translate, "stopped"), en.statusStopped);
  assert.equal(ptcStateLabel(translate, "absent"), en.statusMissing);
});

test("the PTC card lists its state chip before the violet marker", () => {
  // An absent container is Missing in the muted tone — never the error red —
  // and the lazily-created fact is the chip's tooltip rather than a hint line.
  assert.deepEqual(ptcChips(translate, "absent"), [
    {
      key: "state",
      tone: "muted",
      label: en.statusMissing,
      title: en.ptcMissing,
    },
    {
      key: "ptc",
      tone: "violet",
      label: en.containerKindPtc,
      title: en.ptcContainerTooltip,
    },
  ]);
  // Running and stopped keep their usual wording and tones.
  assert.deepEqual(ptcChips(translate, "running"), [
    { key: "state", tone: "ok", label: en.statusRunning },
    {
      key: "ptc",
      tone: "violet",
      label: en.containerKindPtc,
      title: en.ptcContainerTooltip,
    },
  ]);
  assert.deepEqual(ptcChips(translate, "stopped"), [
    { key: "state", tone: "muted", label: en.statusStopped },
    {
      key: "ptc",
      tone: "violet",
      label: en.containerKindPtc,
      title: en.ptcContainerTooltip,
    },
  ]);
});

test("the PTC card offers Recreate before the destructive Remove", () => {
  const actions = ptcActionViews(translate, PTC_CONTAINER_NAME);
  assert.deepEqual(actions.map((action) => action.key), [
    "recreate",
    "remove",
  ]);
  assert.deepEqual(actions.map((action) => action.op), [
    "ptc_recreate",
    "ptc_remove",
  ]);
  assert.deepEqual(actions.map((action) => action.label), [
    en.recreate,
    en.remove,
  ]);
  assert.deepEqual(actions.map((action) => action.destructive), [
    false,
    true,
  ]);
  assert.equal(actions[0]?.title, en.recreatePtcTitle);
  assert.equal(
    actions[0]?.description,
    en.confirmRecreatePtc.replace("{container}", PTC_CONTAINER_NAME),
  );
  assert.equal(actions[1]?.title, en.removePtcTitle);
  assert.equal(
    actions[1]?.description,
    en.confirmRemovePtc.replace("{container}", PTC_CONTAINER_NAME),
  );
});

test("the PTC card lives on the Status tab, not among the workspaces", (t) => {
  const card = clientSource("ContainerCard.tsx");
  const status = clientSource("container-card-status.tsx");
  const workspace = clientSource("container-card-workspace.tsx");
  if (card === undefined || status === undefined || workspace === undefined) {
    t.skip("not a source checkout");
    return;
  }
  // The Status tab renders the card, directly below the component rows.
  assert.match(status, /<PtcSection/);
  assert.match(
    card,
    /<StatusSection[\s\S]*onRecreatePtc=\{props\.recreatePtc\}/,
  );
  // The Workspaces panel no longer holds it.
  const workspacesPanel = card.slice(
    card.indexOf('panelId("workspaces")'),
    card.indexOf('panelId("images")'),
  );
  assert.ok(workspacesPanel.length > 0, "the workspaces panel must be found");
  assert.doesNotMatch(workspacesPanel, /PtcSection/);
  assert.doesNotMatch(workspace, /PtcSection/);
});

test("the absent PTC snapshot still names the container and its image", () => {
  assert.deepEqual(absentPtcView(), {
    containerName: PTC_CONTAINER_NAME,
    kind: "ptc",
    state: "absent",
    imageId: PTC_IMAGE_ID,
    createdAt: "",
  });
});

test("the create form reserves the PTC container name", () => {
  assert.equal(reservedContainerName("ptc"), "ptc");
  assert.equal(reservedContainerName("default"), "default");
  assert.equal(reservedContainerName("dev"), undefined);
});

test("the PTC image is the last row of the base card, not a custom one", () => {
  assert.equal(PTC_IMAGE_ID, "ptc");
  assert.equal(isPtcImage("ptc"), true);
  assert.equal(isPtcImage("archlinux"), false);
  assert.deepEqual(
    orderedImages([
      { imageId: "archlinux" },
      { imageId: PTC_IMAGE_ID },
      { imageId: "custom" },
    ]).map((image) => image.imageId),
    ["archlinux", "custom", PTC_IMAGE_ID],
  );

  const rows = imageCardRows([
    { imageId: "archlinux", isBase: true },
    { imageId: "custom", isBase: false },
    { imageId: PTC_IMAGE_ID, isBase: false },
  ]);
  // The reserved image is not a base image by origin, yet the base card owns
  // its row, after the base images; the custom card no longer lists it.
  assert.deepEqual(rows.base.map((image) => image.imageId), ["archlinux"]);
  assert.equal(rows.ptc?.imageId, PTC_IMAGE_ID);
  assert.deepEqual(rows.custom.map((image) => image.imageId), ["custom"]);
  // The base summary counts the reserved row; the custom summary does not.
  assert.equal(rows.baseCount, 2);
  assert.equal(rows.customCount, 1);
  // The editable set never holds the reserved row, so no card lists it there.
  assert.deepEqual(rows.editable.map((image) => image.imageId), [
    "archlinux",
    "custom",
  ]);
});

test("the build parent choices never include the reserved PTC image", (t) => {
  const images = [
    { imageId: "archlinux", isBase: true },
    { imageId: PTC_IMAGE_ID, isBase: false },
    { imageId: "custom", isBase: false },
  ];
  // The helper keeps every other image, in snapshot order, and drops the
  // reserved one whether it is listed as a base or a custom image.
  assert.deepEqual(
    buildParentImages(images).map((image) => image.imageId),
    ["archlinux", "custom"],
  );

  const modal = clientSource("container-card-images.tsx");
  const resources = clientSource("container-card-resources.tsx");
  if (modal === undefined || resources === undefined) {
    t.skip("not a source checkout");
    return;
  }
  // Both the form's options and its preselected parent come from the helper,
  // so the reserved image cannot slip in through the snapshot.
  assert.match(modal, /buildParentImages\(images\)/);
  assert.match(resources, /buildParentImages\(images\)/);
});

test("the image pickers never offer the reserved PTC image", (t) => {
  const form = clientSource("container-card-form.tsx");
  const templates = clientSource("container-card-templates.tsx");
  const shared = clientSource("container-card-shared.tsx");
  if (form === undefined || templates === undefined || shared === undefined) {
    t.skip("not a source checkout");
    return;
  }
  // The container editor filters the snapshot through the existing helper and
  // only then applies base-first ordering, so the reserved image can never be
  // picked for a new selection and the other images keep their order.
  assert.match(form, /const offered = buildParentImages\(images\);/);
  assert.match(
    form,
    /\.\.\.offered\.filter\(\(candidate\) => candidate\.isBase\),/,
  );
  assert.match(
    form,
    /\.\.\.offered\.filter\(\(candidate\) => !candidate\.isBase\),/,
  );
  // The template popup builds its candidates through templateImageCandidates,
  // which filters through the same helper and then adds the template's own
  // image; it never starts from the raw snapshot.
  assert.match(templates, /templateImageCandidates\(/);
  assert.doesNotMatch(
    templates,
    /\.\.\.images\.filter\(\(candidate\) => candidate\.isBase\),/,
  );
  // The filtered order is still base images first, custom ones after.
  const offered = buildParentImages([
    { imageId: "custom", isBase: false },
    { imageId: PTC_IMAGE_ID, isBase: true },
    { imageId: "archlinux", isBase: true },
  ]);
  assert.deepEqual(
    [
      ...offered.filter((image) => image.isBase),
      ...offered.filter((image) => !image.isBase),
    ].map((image) => image.imageId),
    ["archlinux", "custom"],
  );
  // With only the reserved image present there is nothing to offer.
  assert.deepEqual(
    buildParentImages([{ imageId: PTC_IMAGE_ID, isBase: false }]),
    [],
  );
  // A container already on the reserved image keeps it as the current value:
  // ImageRow adds an option for a value outside the candidate list instead of
  // letting the first candidate replace it.
  assert.match(shared, /image !== "" && options\.includes\(image\)/);
  assert.match(shared, /<option value=\{image\}>/);
});

test("the base card renders the PTC row after its own images", (t) => {
  const resources = clientSource("container-card-resources.tsx");
  if (resources === undefined) {
    t.skip("not a source checkout");
    return;
  }
  const baseCard = resources.slice(
    resources.indexOf('title={t("baseImagesTitle")}'),
    resources.indexOf('title={t("customImagesTitle")}'),
  );
  const customCard = resources.slice(
    resources.indexOf('title={t("customImagesTitle")}'),
  );
  assert.ok(baseCard.length > 0, "the base card must be found");
  assert.ok(customCard.length > 0, "the custom card must be found");
  assert.match(baseCard, /<PtcImageRow/);
  assert.ok(
    baseCard.indexOf("<PtcImageRow") > baseCard.indexOf("baseImages.map"),
    "the PTC row must follow the base image rows",
  );
  assert.doesNotMatch(customCard, /PtcImageRow/);
});

test("the PTC image row states its status, build date, parent, marker and locked default", () => {
  const parent = "docker.io/library/node:26-slim";
  const builtAt = "2026-10-20T14:16:39Z";
  const built = ptcImageRow(translate, {
    imageId: PTC_IMAGE_ID,
    status: "built",
    parent,
    builtAt,
  });
  assert.equal(built.imageId, PTC_IMAGE_ID);
  // A built image carries the instant every other image row dates itself with.
  assert.equal(built.builtAt, builtAt);
  assert.equal(built.parent, parent);
  // A present image is rebuilt; the action goes through the PTC ensure path.
  assert.deepEqual(built.build, { label: en.rebuildImage });
  assert.deepEqual(built.chips, [
    { key: "state", tone: "ok", label: en.statusBuilt },
    {
      key: "ptc",
      tone: "violet",
      label: en.containerKindPtc,
      title: en.ptcImageTooltip,
    },
  ]);
  // The image is reserved: Set default is disabled rather than hidden, and its
  // tooltip names the reservation.
  assert.deepEqual(built.setDefault, {
    disabled: true,
    label: en.setDefaultImage,
    tooltip: en.ptcImageReserved,
  });

  const missing = ptcImageRow(translate, {
    imageId: PTC_IMAGE_ID,
    status: "missing",
    primitive: parent,
  });
  // A missing image has no build moment, so its Build line is absent exactly
  // as it is on every other row.
  assert.equal(missing.builtAt, "");
  // A missing image has no parent record yet, so the row falls back to the
  // primitive it builds from, and it offers Build instead of Rebuild.
  assert.equal(missing.parent, parent);
  assert.deepEqual(missing.build, { label: en.build });
  // A missing PTC image reads in the same error red as every other image row,
  // unlike the Status card's own absent container.
  assert.deepEqual(missing.chips[0], {
    key: "state",
    tone: "error",
    label: en.statusMissing,
  });
  assert.equal(missing.chips[1]?.tone, PTC_CHIP_TONE);
});

test("the PTC image row renders a Built line before Parent image", (t) => {
  const images = clientSource("container-card-images.tsx");
  if (images === undefined) {
    t.skip("not a source checkout");
    return;
  }
  const ptcRow = images.slice(
    images.indexOf("export function PtcImageRow"),
    images.indexOf("export function ImageBuildModal"),
  );
  assert.ok(ptcRow.length > 0, "the PTC image row must be found");
  // The line uses the same label and relative wording as every other row, with
  // the exact instant as the tooltip.
  assert.match(ptcRow, /label=\{t\("built"\)\}/);
  assert.match(ptcRow, /title=\{row\.builtAt\}/);
  assert.match(ptcRow, /relativeTimeLabel\(row\.builtAt, locale\)/);
  assert.ok(
    ptcRow.indexOf('t("built")') < ptcRow.indexOf('t("parentImage")'),
    "the Built line must precede the Parent image line",
  );
  // A missing image has no build moment, so the line is absent rather than a
  // placeholder, just as on the other rows.
  assert.match(ptcRow, /\{row\.builtAt === "" \? null : \(/);
});

test("the PTC block is its own untitled card below the component card", (t) => {
  const status = clientSource("container-card-status.tsx");
  const section = clientSource("container-card-ptc-section.tsx");
  if (status === undefined || section === undefined) {
    t.skip("not a source checkout");
    return;
  }
  // The block uses the shared card surface, not a subsection of the Status
  // card.
  assert.match(section, /<section style=\{card\}>/);
  assert.doesNotMatch(section, /Subsection/);
  // It carries no heading for now: the identity line names the container.
  assert.doesNotMatch(section, /<h[1-6]/);
  assert.doesNotMatch(section, /ptcTitle/);
  // The Status tab renders it after the component card, as a sibling card.
  assert.ok(
    status.indexOf("</CardGroup>") < status.indexOf("<PtcSection"),
    "the PTC card must follow the component card",
  );
});

test("the PTC card disables its actions while the container is absent", (t) => {
  const section = clientSource("container-card-ptc-section.tsx");
  if (section === undefined) {
    t.skip("not a source checkout");
    return;
  }
  assert.match(section, /disabled=\{absent\}/);
  // The image field reads whatever the snapshot carries, so the host fills the
  // absent row's image rather than the client guessing one.
  assert.match(section, /image=\{ptc\.imageId\}/);
});
