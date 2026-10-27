// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  effectiveImage,
  exportContainerTemplate,
  parseContainerTemplate,
  templateImageIdFromDigest,
  templateImagePlan,
  templateMountInputs,
  withForcedProjectMount,
} from "./container-template.js";
import { GIT_IDENTITY_KEYS } from "./container-env.js";
import {
  createDialogConfig,
  initialConfig,
  initialMounts,
} from "./client/container-card-create-config.js";
import { isPrimaryProjectMount } from "./mount-order.js";
import {
  invalidTemplateReason,
  missingSecretNames,
  templateBlockReason,
  templateBuildAction,
  templateChoiceActionable,
  templateConfigForEditor,
  type TemplateCurrentConfig,
  templateDisplayName,
  templateDraftImageFacts,
  templateDraftMissingReferences,
  templateDraftReferences,
  type TemplateEditorConfig,
  templateImageAction,
  templateImageCandidates,
  templateImageFacts,
  templatePortRowValue,
  type TemplateProjectCheck,
  templateProjectChecksEqual,
  templateProjectPathDecision,
  templateProjectPathError,
  templateSecretNames,
  templateSpecSummary,
  templateSummaryAccessibleLabel,
  templateSummaryLineText,
  templateSummarySegments,
  templateSummarySegmentText,
} from "./client/container-template-ui.js";
import {
  CONTAINER_DIALOG_STYLES,
  TEMPLATE_DIALOG_CLASS,
  TEMPLATE_DIALOG_CONTENT_CLASS,
} from "./client/container-card-dialog-styles.js";
import { PTC_IMAGE_ID } from "./client/card-protocol.js";
import { en, zh } from "./client/locales.js";
import type { Translate } from "./client/locales.js";

// A client source file, read only in a source checkout: `pnpm test` runs from
// dist/, where the card's sources are not shipped.
function clientSource(name: string): string | undefined {
  const url = new URL(`../src/client/${name}`, import.meta.url);
  return existsSync(url) ? readFileSync(url, "utf8") : undefined;
}

test("Create opens the default editor when empty, the named one otherwise", (t) => {
  const modal = clientSource("container-card-templates.tsx");
  const workspace = clientSource("container-card-workspace.tsx");
  if (modal === undefined || workspace === undefined) {
    t.skip("not a source checkout");
    return;
  }
  const detailsStart = modal.indexOf("function TemplateDetailsModal");
  const wrapperStart = modal.indexOf("export function LoadTemplateModal");
  assert.ok(detailsStart >= 0 && wrapperStart > detailsStart);
  const details = modal.slice(detailsStart, wrapperStart);
  // Create says where the name comes from and evaluates none of it here: the
  // default editor fixes the name, the named editor lets the user choose it.
  assert.match(details, /t\("templateCreateHint"\)/);
  assert.match(details, /t\("templateCreateDefaultHint"\)/);
  assert.doesNotMatch(
    details,
    /templateCreateTarget|templateNameTaken|templateNameReserved/,
  );
  assert.doesNotMatch(details, /containerNameForTemplate/);
  // An empty workspace passes "default", so the default create editor opens; a
  // workspace with a container passes no name, so the named editor opens empty.
  assert.match(details, /containers\.length === 0 \? "default" : ""/);
  assert.match(
    details,
    /onContinue\(\s*"create",\s*containers\.length === 0 \? "default" : "",/,
  );
  assert.match(
    workspace,
    /container === "default" \? "default" : "named"/,
  );
  assert.match(workspace, /name: container === "default" \? "" : container/);
});

test("the create draft carries the template mounts exactly as it writes them", () => {
  const template = parseContainerTemplate(`version: 1
kind: dsh-podman/container-template
spec:
  image: ubuntu
  env: {NODE_ENV: development, FROM: template}
  secretEnv: {TOKEN: token}
  mounts:
    - {kind: project, project: app, mode: read_only}
    - {kind: project, project: docs}
    - {kind: volume, volume: cache, destination: /cache, mode: read_write}
  paths: [/usr/local/bin]
  ports:
    - {container: 8080, host: 8080, protocol: tcp}
`);
  const config = templateConfigForEditor(template, "ubuntu", {
    defaultEnv: { FROM: "default", KEEP: "1" },
  });
  assert.equal(config.image, "ubuntu");
  assert.deepEqual(config.env, {
    FROM: "template",
    KEEP: "1",
    NODE_ENV: "development",
  });
  // The same ordering the create dialog's own draft uses, so the seeded rows
  // read where the editor lists them.
  assert.deepEqual(Object.keys(config.env), ["FROM", "KEEP", "NODE_ENV"]);
  // The workspace's project mount keeps the read_only mode the template wrote;
  // the editor synthesises nothing.
  assert.deepEqual(config.mounts[0], {
    kind: "project",
    project: "app",
    destination: "",
    mode: "read_only",
    volume: "",
    secret: "",
  });
  assert.deepEqual(config.mounts[1], {
    kind: "project",
    project: "docs",
    destination: "",
    mode: "read_only",
    volume: "",
    secret: "",
  });
  assert.equal(config.mounts[2].kind, "volume");
  assert.deepEqual(config.paths, ["/usr/local/bin"]);
  assert.deepEqual(config.secretEnv, { TOKEN: "token" });
  assert.deepEqual(config.ports, [{
    port: 8080,
    protocol: "tcp",
    endpoint: "",
    suggestedHostPort: 8080,
    hostPort: 0,
  }]);
});

test("forcing the workspace project mount keeps its declared mode and stays first", () => {
  const volume = {
    kind: "volume",
    project: "",
    destination: "/cache",
    mode: "read_write",
    volume: "cache",
    secret: "",
  };
  const docs = {
    kind: "project",
    project: "docs",
    destination: "",
    mode: "read_write",
    volume: "",
    secret: "",
  };
  const appReadOnly = {
    kind: "project",
    project: "app",
    destination: "",
    mode: "read_only",
    volume: "",
    secret: "",
  };
  // The declared mount keeps its mode, moves first and is de-duplicated even
  // when the template (or an exported container) lists it more than once.
  assert.deepEqual(
    withForcedProjectMount([
      volume,
      appReadOnly,
      docs,
      { ...appReadOnly, mode: "read_write" },
    ], "app"),
    [appReadOnly, volume, docs],
  );
  // A template that does not declare the workspace's project mount gets the
  // read-write default, still first.
  assert.deepEqual(withForcedProjectMount([volume], "app"), [{
    kind: "project",
    project: "app",
    destination: "",
    mode: "read_write",
    volume: "",
    secret: "",
  }, volume]);
  // The host apply path reads the same helper, so a declared read_only survives
  // applying a template as well as prefilling an editor.
  const template = parseContainerTemplate(`version: 1
kind: dsh-podman/container-template
spec:
  image: ubuntu
  mounts:
    - {kind: project, project: app, mode: read_only}
`);
  assert.deepEqual(templateMountInputs(template, "app")[0], appReadOnly);
});

test("only the default create forces and locks the workspace project mount", () => {
  const declaredTemplate = parseContainerTemplate(`version: 1
kind: dsh-podman/container-template
spec:
  image: ubuntu
  mounts:
    - {kind: project, project: app, mode: read_only}
    - {kind: volume, volume: cache, destination: /cache}
`);
  const declared = templateConfigForEditor(declaredTemplate, "ubuntu");
  const lockedProject = (
    config: { mounts: readonly { kind: string; project: string }[] },
    primaryProject: string,
  ) =>
    config.mounts.filter((mount) =>
      isPrimaryProjectMount(mount, primaryProject)
    );
  // The default create keeps the template's read_only mode and locks that row:
  // the editor is handed the workspace project as its primary project.
  const defaultDraft = createDialogConfig(declared, false, "app");
  assert.equal(defaultDraft.mounts[0].mode, "read_only");
  assert.equal(lockedProject(defaultDraft, "app").length, 1);
  // The same template on a named create opens with exactly its mounts, and no
  // row is locked because the named editor has no primary project.
  const namedDraft = createDialogConfig(declared, true, "app");
  assert.deepEqual(namedDraft.mounts, declared.mounts);
  assert.equal(lockedProject(namedDraft, "").length, 0);

  // Without a declared workspace mount the default create adds it read-write
  // and locks it, while the named create opens without it.
  const implicitTemplate = parseContainerTemplate(`version: 1
kind: dsh-podman/container-template
spec:
  image: ubuntu
  mounts:
    - {kind: volume, volume: cache, destination: /cache}
`);
  const implicit = templateConfigForEditor(implicitTemplate, "ubuntu");
  assert.equal(
    implicit.mounts.some((mount) =>
      mount.kind === "project" && mount.project === "app"
    ),
    false,
  );
  const defaultImplicit = createDialogConfig(implicit, false, "app");
  assert.deepEqual(defaultImplicit.mounts[0], {
    kind: "project",
    project: "app",
    destination: "",
    mode: "read_write",
    volume: "",
    secret: "",
  });
  assert.equal(lockedProject(defaultImplicit, "app").length, 1);
  const namedImplicit = createDialogConfig(implicit, true, "app");
  assert.deepEqual(namedImplicit.mounts, implicit.mounts);
  assert.equal(lockedProject(namedImplicit, "").length, 0);

  // A plain Add (no template) still opens on the default workspace mount the
  // dialog seeds, and that row is removable.
  const workspace = { projectName: "app", imageId: "" };
  const plainAdd = createDialogConfig(
    initialConfig(workspace, "ubuntu", {}),
    true,
    "app",
  );
  assert.deepEqual(plainAdd.mounts, initialMounts(workspace));
  assert.equal(lockedProject(plainAdd, "").length, 0);
});

test("a locked project mount loses only its Remove; its mode stays editable", (t) => {
  const editors = clientSource("container-card-editors.tsx");
  const shared = clientSource("container-card-shared.tsx");
  if (editors === undefined || shared === undefined) {
    t.skip("not a source checkout");
    return;
  }
  // The lock is the shared primary-project predicate, and it only withholds the
  // row's Remove action (with the reason on the disabled button).
  assert.match(
    editors,
    /const removable = !isPrimaryProjectMount\(mount, primaryProject\)/,
  );
  assert.match(
    editors,
    /onRemove=\{removable \? callbacks\.remove : undefined\}/,
  );
  assert.match(
    editors,
    /removeDisabledReason=\{removable[\s\S]*?defaultMountNotRemovable/,
  );
  // The mode picker lives in the row and is disabled only by the editor's busy
  // state, never by the lock, so the mode of a locked mount stays editable.
  const modeStart = shared.indexOf('label: t("mountMode")');
  const modeEnd = shared.indexOf("</ValueField>", modeStart);
  assert.ok(modeStart >= 0 && modeEnd > modeStart);
  const modeField = shared.slice(modeStart, modeEnd);
  assert.match(modeField, /<select/);
  assert.match(modeField, /disabled=\{disabledField\}/);
  assert.doesNotMatch(modeField, /removable|removeDisabledReason/);
});

test("the details draft carries the template's own mounts and references", () => {
  // A template that lists the workspace's own project mount keeps that row:
  // the seed is the template's mounts, not a synthesised forced one.
  const template = parseContainerTemplate(`version: 1
kind: dsh-podman/container-template
spec:
  image: ubuntu
  secretEnv: {TOKEN: token}
  mounts:
    - {kind: volume, volume: cache, destination: /cache, mode: read_write}
    - {kind: project, project: app, mode: read_only}
    - {kind: secret, secret: token, destination: /run/token}
  ports:
    - {container: 8080, host: 8080, protocol: tcp}
`);
  const draft = templateConfigForEditor(template, "ubuntu");
  // The mounts are exactly the template's, in its order: nothing is forced
  // first for a project the template happens to declare.
  assert.deepEqual(draft.mounts, [
    {
      kind: "volume",
      project: "",
      destination: "/cache",
      mode: "read_write",
      volume: "cache",
      secret: "",
    },
    {
      kind: "project",
      project: "app",
      destination: "",
      mode: "read_only",
      volume: "",
      secret: "",
    },
    {
      kind: "secret",
      project: "",
      destination: "/run/token",
      mode: "read_only",
      volume: "",
      secret: "token",
    },
  ]);
  // Every reference the draft carries, with the row it comes from.
  assert.deepEqual(templateDraftReferences(draft), [
    { kind: "secret", name: "token", env: "TOKEN" },
    { kind: "volume", name: "cache", mountIndex: 0 },
    { kind: "project", name: "app", mountIndex: 1 },
    { kind: "secret", name: "token", mountIndex: 2 },
  ]);
  // A draft with no mounts stays empty, so the popup keeps its placeholders.
  const empty = templateConfigForEditor(
    parseContainerTemplate(`version: 1
kind: dsh-podman/container-template
spec:
  image: ubuntu
`),
    "ubuntu",
  );
  assert.deepEqual(empty.mounts, []);
  assert.deepEqual(templateDraftReferences(empty), []);
});

test("the draft image decides the build action", () => {
  const plan = {
    imageId: "template-web",
    needsBuild: true,
  } as any;
  // No chosen template means no details, so no build action at all.
  assert.equal(
    templateBuildAction({
      plan: null,
      draftImage: "",
      building: false,
      buildFailed: "",
    }),
    "none",
  );
  // The template's own id gets Build while its plan needs one, and progress
  // while that build runs.
  assert.equal(
    templateBuildAction({
      plan,
      draftImage: "template-web",
      building: false,
      buildFailed: "",
    }),
    "build",
  );
  assert.equal(
    templateBuildAction({
      plan,
      draftImage: "template-web",
      building: true,
      buildFailed: "",
    }),
    "building",
  );
  // A ready template image gets Rebuild; a failed build keeps the action.
  const ready = { ...plan, needsBuild: false } as any;
  assert.equal(
    templateBuildAction({
      plan: ready,
      draftImage: "template-web",
      building: false,
      buildFailed: "",
    }),
    "rebuild",
  );
  assert.equal(
    templateBuildAction({
      plan: ready,
      draftImage: "template-web",
      building: true,
      buildFailed: "",
    }),
    "rebuilding",
  );
  assert.equal(
    templateBuildAction({
      plan,
      draftImage: "template-web",
      building: false,
      buildFailed: "boom",
    }),
    "build",
  );
  // Another listed image is not this popup's to build: no action, whatever the
  // template's own plan says.
  assert.equal(
    templateBuildAction({
      plan,
      draftImage: "ubuntu",
      building: true,
      buildFailed: "boom",
    }),
    "none",
  );
  // A base-only plan's image is its effective base, so a draft on either the
  // plan's id or that base is the template's own and follows the plan: Build
  // while the base is missing, Rebuild once it is ready.
  const basePlan = {
    imageId: "template-derived",
    effective: { kind: "base", base: "alpine" },
    needsBuild: true,
  } as any;
  for (const draftImage of ["template-derived", "alpine"]) {
    assert.equal(
      templateBuildAction({
        plan: basePlan,
        draftImage,
        building: false,
        buildFailed: "",
      }),
      "build",
    );
  }
  assert.equal(
    templateBuildAction({
      plan: { ...basePlan, needsBuild: false },
      draftImage: "alpine",
      building: false,
      buildFailed: "",
    }),
    "rebuild",
  );
  // Any other image, even one the list holds, still gets no action.
  assert.equal(
    templateBuildAction({
      plan: basePlan,
      draftImage: "ubuntu",
      building: false,
      buildFailed: "",
    }),
    "none",
  );
});

test("the image card's action and command follow the draft image", () => {
  const listed = (
    imageId: string,
    status: string,
    options: { isBase?: boolean; basePublic?: boolean } = {},
  ) => ({
    imageId,
    parent: options.isBase === true ? "" : "ubuntu",
    primitive: "docker.io/library/ubuntu:24.04",
    packages: ["jq"],
    builtAt: status === "missing" ? "" : "2026-10-20T14:16:39Z",
    status,
    isBase: options.isBase ?? false,
    basePublic: options.basePublic ?? false,
  });
  const images = [
    listed("custom-a", "built"),
    listed("custom-b", "missing"),
    listed("alpine", "built", { isBase: true }),
    listed("debian", "missing", { isBase: true }),
    // A present local base normally reads "built"; a pulled one still offers
    // Rebuild, because a local base is never pulled into place by the tab.
    listed("ubuntu", "pulled", { isBase: true }),
    listed("fedora", "missing", { isBase: true, basePublic: true }),
    listed("archlinux", "pulled", { isBase: true, basePublic: true }),
    listed(PTC_IMAGE_ID, "built"),
  ];
  const plan = {
    imageId: "template-web",
    effective: { kind: "template", base: "ubuntu", packages: ["jq"] },
    needsBuild: true,
  } as any;
  const ready = { ...plan, needsBuild: false } as any;
  const action = (
    draftImage: string,
    planValue: any = plan,
    building = false,
  ) =>
    templateImageAction({
      plan: planValue,
      draftImage,
      images,
      building,
      buildFailed: "",
    });
  // No chosen template means no details and no action, whatever the list holds.
  assert.deepEqual(action("custom-a", null), {
    action: "none",
    command: "none",
  });
  // The template's own image keeps the template route: Build while its plan
  // needs one, Rebuild once ready, and its own progress while either runs.
  assert.deepEqual(action("template-web"), {
    action: "build",
    command: "template-build",
  });
  assert.deepEqual(action("template-web", plan, true), {
    action: "building",
    command: "template-build",
  });
  assert.deepEqual(action("template-web", ready), {
    action: "rebuild",
    command: "template-rebuild",
  });
  assert.deepEqual(action("template-web", ready, true), {
    action: "rebuilding",
    command: "template-rebuild",
  });
  // A base-only plan's id and its effective base both count as the template's
  // own image, so both keep the template build route.
  const baseOnly = {
    imageId: "template-derived",
    effective: { kind: "base", base: "alpine" },
    needsBuild: true,
  } as any;
  for (const draftImage of ["template-derived", "alpine"]) {
    assert.deepEqual(action(draftImage, baseOnly), {
      action: "build",
      command: "template-build",
    });
  }
  // Another listed custom image: Rebuild the built record, Build the missing
  // one from the record's own parent and packages.
  assert.deepEqual(action("custom-a"), {
    action: "rebuild",
    command: "custom-rebuild",
  });
  assert.deepEqual(action("custom-b"), {
    action: "build",
    command: "custom-build",
  });
  // Another listed base image: Rebuild or Build a local base, Pull a public
  // one, matching the Images tab.
  assert.deepEqual(action("alpine"), {
    action: "rebuild",
    command: "base-rebuild",
  });
  assert.deepEqual(action("ubuntu"), {
    action: "rebuild",
    command: "base-rebuild",
  });
  assert.deepEqual(action("debian"), {
    action: "build",
    command: "base-build",
  });
  assert.deepEqual(action("fedora"), {
    action: "pull",
    command: "base-pull",
  });
  assert.deepEqual(action("archlinux"), {
    action: "pull",
    command: "base-pull",
  });
  // An image the list does not hold, and the reserved PTC image the picker
  // never offers, get no action at all.
  assert.deepEqual(action("gone"), { action: "none", command: "none" });
  assert.deepEqual(action(PTC_IMAGE_ID), {
    action: "none",
    command: "none",
  });
});

test("the template's own image leads the picker's candidates", () => {
  const images = [
    { imageId: "ubuntu", isBase: true },
    { imageId: "custom-b", isBase: false },
    { imageId: "alpine", isBase: true },
    { imageId: "custom-a", isBase: false },
  ];
  const customPlan = {
    imageId: "template-web",
    effective: { kind: "template", base: "ubuntu", packages: [] },
  } as any;
  // The template's own derived id leads although the workspace list does not
  // hold it yet; the other bases come next and the other customs last, each
  // group sorted by image id rather than by snapshot order.
  assert.deepEqual(templateImageCandidates(customPlan, images), [
    "template-web",
    "alpine",
    "ubuntu",
    "custom-a",
    "custom-b",
  ]);
  // An own id the list already holds appears exactly once, at the front.
  assert.deepEqual(
    templateImageCandidates({ ...customPlan, imageId: "custom-a" }, images),
    ["custom-a", "alpine", "ubuntu", "custom-b"],
  );
  // A base-only plan offers its effective base once, at the front, and not
  // again among the other bases.
  const basePlan = {
    imageId: "template-derived",
    effective: { kind: "base", base: "archlinux" },
  } as any;
  assert.deepEqual(
    templateImageCandidates(basePlan, [
      { imageId: "ubuntu", isBase: true },
      { imageId: "alpine", isBase: true },
      { imageId: "custom-b", isBase: false },
      { imageId: "custom-a", isBase: false },
    ]),
    ["archlinux", "alpine", "ubuntu", "custom-a", "custom-b"],
  );
  // An already-listed base is not repeated among the other bases.
  assert.deepEqual(
    templateImageCandidates(basePlan, [
      { imageId: "archlinux", isBase: true },
      { imageId: "custom", isBase: false },
    ]),
    ["archlinux", "custom"],
  );
  // An empty group adds nothing.
  assert.deepEqual(
    templateImageCandidates(basePlan, [
      { imageId: "ubuntu", isBase: true },
      { imageId: "alpine", isBase: true },
    ]),
    ["archlinux", "alpine", "ubuntu"],
  );
  assert.deepEqual(
    templateImageCandidates(basePlan, [
      { imageId: "custom-b", isBase: false },
      { imageId: "custom-a", isBase: false },
    ]),
    ["archlinux", "custom-a", "custom-b"],
  );
  // The empty ids, the duplicates and the reserved PTC image never reach the
  // picker; without a plan the snapshot's images are still grouped and sorted.
  assert.deepEqual(
    templateImageCandidates(null, [
      { imageId: "custom", isBase: false },
      { imageId: "custom", isBase: false },
      { imageId: "", isBase: false },
      { imageId: PTC_IMAGE_ID, isBase: false },
      { imageId: "ubuntu", isBase: true },
    ]),
    ["ubuntu", "custom"],
  );
  // Ids sort case-insensitively.
  assert.deepEqual(
    templateImageCandidates(null, [
      { imageId: "Zulu", isBase: true },
      { imageId: "alpha", isBase: true },
      { imageId: "Beta", isBase: false },
      { imageId: "custom-a", isBase: false },
    ]),
    ["alpha", "Zulu", "Beta", "custom-a"],
  );
});

test("the editor's picker and image card keep their own facts", (t) => {
  const form = clientSource("container-card-form.tsx");
  const images = clientSource("container-card-images.tsx");
  if (form === undefined || images === undefined) {
    t.skip("not a source checkout");
    return;
  }
  // The container editor still offers exactly the workspace snapshot's images,
  // base first, with no template plan to add to it.
  assert.match(form, /const offered = buildParentImages\(images\);/);
  assert.doesNotMatch(form, /templateImageCandidates|inspection\.image/);
  // The settings images tab still reads a base image's upstream reference from
  // its own primitive, never from a template plan.
  assert.match(
    images,
    /image\.parent !== "" \? image\.parent : image\.primitive/,
  );
  assert.doesNotMatch(
    images,
    /templateImageFacts|templateImageCandidates|templateDraftImageFacts/,
  );
});

test("Continue waits for the draft image, its references and a target", () => {
  const inspection = {
    warnings: [],
    image: { imageId: "template-web", needsBuild: true },
  } as any;
  const base = {
    inspection,
    draftImage: "template-web",
    images: [{ imageId: "template-web" }, { imageId: "ubuntu" }],
    buildInProgress: false,
    buildFailed: "",
    pendingReferences: 0,
    missingReferences: 0,
    mode: "create" as const,
    replaceTarget: "",
  };
  // The derived image blocks until its build succeeded.
  assert.equal(templateBlockReason(base), "build");
  assert.equal(
    templateBlockReason({ ...base, buildInProgress: true }),
    "build",
  );
  const ready = {
    ...base,
    inspection: {
      ...inspection,
      image: { ...inspection.image, needsBuild: false },
    },
  };
  assert.equal(templateBlockReason(ready), undefined);
  // A failed build of the derived image blocks until it is retried.
  assert.equal(
    templateBlockReason({ ...ready, buildFailed: "boom" }),
    "build-failed",
  );
  // Switching to another listed image removes the build requirement, including
  // a failure that belongs to the template's own image.
  assert.equal(
    templateBlockReason({
      ...ready,
      draftImage: "ubuntu",
      buildFailed: "boom",
      buildInProgress: true,
    }),
    undefined,
  );
  // An image the list no longer holds is missing and not buildable here.
  assert.equal(
    templateBlockReason({ ...ready, draftImage: "gone" }),
    "image-missing",
  );
  // A pending check is the checking state only while nothing is missing.
  assert.equal(
    templateBlockReason({ ...ready, pendingReferences: 1 }),
    "checking",
  );
  // Missing references outrank a pending check: a pending project still counts
  // as outstanding, so its row's number is what the footer keeps showing.
  assert.equal(
    templateBlockReason({
      ...ready,
      pendingReferences: 1,
      missingReferences: 1,
    }),
    "missing-references",
  );
  assert.equal(
    templateBlockReason({
      ...ready,
      pendingReferences: 2,
      missingReferences: 1,
    }),
    "missing-references",
  );
  // Missing references block by count, whatever their kind.
  assert.equal(
    templateBlockReason({ ...ready, missingReferences: 2 }),
    "missing-references",
  );
  // A replace needs a chosen container; Create never blocks on a name.
  assert.equal(
    templateBlockReason({ ...ready, mode: "replace", replaceTarget: "" }),
    "no-container",
  );
  assert.equal(
    templateBlockReason({ ...ready, mode: "replace", replaceTarget: "dev" }),
    undefined,
  );
  // A loading plan blocks everything else.
  assert.equal(
    templateBlockReason({ ...ready, inspection: null }),
    "loading",
  );
});

test("draft references resolve against the workspace and deduplicate", () => {
  const draft: TemplateEditorConfig = {
    image: "ubuntu",
    env: {},
    mounts: [
      {
        kind: "project",
        project: "app",
        destination: "",
        mode: "read_only",
        volume: "",
        secret: "",
      },
      {
        kind: "volume",
        volume: "cache",
        destination: "/cache",
        mode: "read_write",
        project: "",
        secret: "",
      },
      {
        kind: "secret",
        secret: "token",
        destination: "/run/token",
        mode: "read_only",
        project: "",
        volume: "",
      },
    ],
    paths: [],
    secretEnv: { TOKEN: "token", KEEP: "kept" },
    ports: [],
  };
  const references = templateDraftReferences(draft);
  assert.deepEqual(references, [
    { kind: "secret", name: "token", env: "TOKEN" },
    { kind: "secret", name: "kept", env: "KEEP" },
    { kind: "project", name: "app", mountIndex: 0 },
    { kind: "volume", name: "cache", mountIndex: 1 },
    { kind: "secret", name: "token", mountIndex: 2 },
  ]);
  // A secret used by a variable and a mount is one missing reference; the
  // project and volume are missing under their own kinds.
  const missing = templateDraftMissingReferences(references, {
    secrets: [],
    volumes: [],
    projects: [],
  });
  assert.deepEqual(missing, [
    { kind: "secret", name: "token", env: "TOKEN" },
    { kind: "secret", name: "kept", env: "KEEP" },
    { kind: "project", name: "app", mountIndex: 0 },
    { kind: "volume", name: "cache", mountIndex: 1 },
  ]);
  // Editing a reference to an existing one unblocks it; back to an unknown one
  // re-blocks it.
  const resolved = templateDraftMissingReferences(references, {
    secrets: [{ name: "token" }, { name: "kept" }],
    volumes: [{ name: "cache" }],
    projects: ["app"],
  });
  assert.deepEqual(resolved, []);
  assert.deepEqual(
    templateDraftMissingReferences(
      [{ kind: "volume", name: "unknown", mountIndex: 1 }],
      { secrets: [], volumes: [{ name: "cache" }], projects: [] },
    ),
    [{ kind: "volume", name: "unknown", mountIndex: 1 }],
  );
  // A project whose host check is still pending has not been accepted yet, so
  // it stays outstanding and keeps the footer's number unchanged while the
  // check reruns.
  assert.deepEqual(
    templateDraftMissingReferences(references, {
      secrets: [{ name: "token" }, { name: "kept" }],
      volumes: [{ name: "cache" }],
      projects: [],
    }),
    [{ kind: "project", name: "app", mountIndex: 0 }],
  );
  // A row the user emptied still reaches the editor, so it counts as missing.
  assert.deepEqual(
    templateDraftReferences({
      ...draft,
      mounts: [{ ...draft.mounts[0], project: "" }],
    }),
    [
      { kind: "secret", name: "token", env: "TOKEN" },
      { kind: "secret", name: "kept", env: "KEEP" },
      { kind: "project", name: "", mountIndex: 0 },
    ],
  );
});

test("a typed project is checked lexically, then through the host picker", async () => {
  // A lexically invalid value is refused before the host is asked at all.
  const listed: string[] = [];
  const list = async (path: string): Promise<unknown> => {
    listed.push(path);
    return { entries: [] };
  };
  assert.deepEqual(
    await templateProjectPathDecision({
      project: "/absolute",
      projectsRoot: "/projects",
      listDirectory: list,
    }),
    { ok: false, reason: "absolute" },
  );
  assert.deepEqual(
    await templateProjectPathDecision({
      project: "../outside",
      projectsRoot: "/projects",
      listDirectory: list,
    }),
    { ok: false, reason: "escapesRoot" },
  );
  assert.deepEqual(listed, []);
  // A lexically valid path whose directory the host cannot list is missing,
  // with the mount editor's own reason.
  assert.deepEqual(
    await templateProjectPathDecision({
      project: "missing",
      projectsRoot: "/projects",
      listDirectory: () => Promise.reject(new Error("not found")),
    }),
    { ok: false, reason: "missing" },
  );
  // A listed directory resolves, normalized to the project path under the root.
  assert.deepEqual(
    await templateProjectPathDecision({
      project: "app",
      projectsRoot: "/projects",
      listDirectory: list,
    }),
    { ok: true, project: "app" },
  );
  assert.deepEqual(listed, ["/projects/app"]);
  // A deployment without a picker keeps the mount editor's lexical-only answer.
  assert.deepEqual(
    await templateProjectPathDecision({
      project: "app",
      projectsRoot: "/projects",
    }),
    { ok: true, project: "app" },
  );
});

test("the details popup edits the draft with the editor's own components", (t) => {
  const modal = clientSource("container-card-templates.tsx");
  if (modal === undefined) {
    t.skip("not a source checkout");
    return;
  }
  const detailsStart = modal.indexOf("function TemplateDetailsModal");
  const wrapperStart = modal.indexOf("export function LoadTemplateModal");
  assert.ok(detailsStart >= 0 && wrapperStart > detailsStart);
  const details = modal.slice(detailsStart, wrapperStart);
  const wrapper = modal.slice(wrapperStart);
  // One editable group per field, in the container form's order and under its
  // titles. The editor components are the form's own, not a second copy.
  const editors = [
    "EnvEditor",
    "MountsEditor",
    "PathsEditor",
    "SecretEnvEditor",
    "PortsEditor",
  ];
  const editorPositions = editors.map((editor) =>
    details.indexOf(`<${editor}`)
  );
  assert.ok(
    editorPositions.every((position) => position >= 0),
    "every editor component is rendered",
  );
  for (let index = 1; index < editorPositions.length; index++) {
    assert.ok(
      editorPositions[index] > editorPositions[index - 1],
      `${editors[index]} follows ${editors[index - 1]}`,
    );
  }
  const titles = [
    "envTitle",
    "mountsTitle",
    "pathsTitle",
    "containerSecretsTitle",
    "portsTitle",
  ];
  const titlePositions = titles.map((title) =>
    details.indexOf(`<DialogGroup title={t("${title}")}>`)
  );
  assert.ok(titlePositions.every((position) => position >= 0));
  for (let index = 1; index < titlePositions.length; index++) {
    assert.ok(
      titlePositions[index] > titlePositions[index - 1],
      `${titles[index]} follows ${titles[index - 1]}`,
    );
  }
  // The old read-only preview is gone: no row is rendered in view mode and no
  // shared row component is used directly by the popup.
  assert.doesNotMatch(details, /mode="view"/);
  for (
    const row of ["EnvRow", "MountRow", "PathRow", "SecretEnvRow", "PortRow"]
  ) {
    assert.doesNotMatch(
      details,
      new RegExp(`<${row}\\b`),
      `${row} is not a second, read-only copy`,
    );
  }
  assert.doesNotMatch(details, /<NoEntries/);
  // Every group is bound to the draft through the editor's own change handler.
  assert.match(details, /env=\{draft\.env\}/);
  assert.match(details, /mounts=\{draft\.mounts\}/);
  assert.match(details, /paths=\{draft\.paths\}/);
  assert.match(details, /secretEnv=\{draft\.secretEnv\}/);
  assert.match(details, /ports=\{draft\.ports\}/);
  assert.match(details, /onChange=\{\(env\) => changeDraft\(\{ env \}\)\}/);
  assert.match(
    details,
    /onChange=\{\(secretEnv\) => changeDraft\(\{ secretEnv \}\)\}/,
  );
  assert.match(
    details,
    /onChange=\{\(ports\) => changeDraft\(\{ ports \}\)\}/,
  );
  // The mounts group is the editor's own: its Add-mount popup, per-row editing
  // and storage creators, with the project path unlocked here and every row's
  // validation message supplied by the popup.
  assert.match(
    details,
    /<MountsEditor[\s\S]*?onCreateVolume=\{createVolume\}/,
  );
  assert.match(details, /onCreateSecret=\{onCreateSecret\}/);
  assert.match(details, /mainProject=\{workspace\.projectName\}/);
  assert.match(details, /projectPathEditable/);
  assert.match(details, /rowError=\{mountRowError\}/);
  assert.match(details, /onProjectBlur=\{/);
  // Read-only or busy sessions gate the fields exactly as the container
  // editor's form does.
  assert.match(details, /busy=\{busy\}/);
  assert.match(details, /enabled=\{enabled\}/);
  assert.match(details, /writable=\{writable\}/);
  // The draft is seeded from the fresh inspection when no resume supplied one,
  // and Reset on an open or a selection change — from the resume payload when
  // there is one; a later re-read never overwrites it.
  assert.match(
    details,
    /templateConfigForEditor\(\s*inspected\.template,\s*inspected\.imageId,\s*\{\s*defaultEnv: defaultEnvRef\.current,\s*\}/,
  );
  assert.match(details, /setDraft\(\(previous\) =>\s*previous \?\?/);
  assert.match(details, /setDraft\(initialDraft \?\? null\)/);
  assert.equal((details.match(/setDraft\(null\)/g) ?? []).length, 0);
  // The image picker edits the draft; the card follows the draft's image and
  // its one action follows the image the draft selects. Its candidates are the
  // workspace's images with the template's own one always kept.
  assert.match(details, /<ImageRow/);
  assert.match(details, /onChange=\{\(image\) => changeDraft\(\{ image \}\)\}/);
  assert.match(
    details,
    /templateDraftImageFacts\(inspection\.image, draft\.image, images\)/,
  );
  assert.match(details, /templateImageAction\(\{/);
  assert.match(details, /imageAction\.action === "none"/);
  assert.match(details, /templateImageCandidates\(/);
  // Reference validation is computed from the draft, checked through the host
  // picker, and counts what remains for the footer. The known set lists only
  // accepted project paths: a pending check is left out, so its row still
  // counts as outstanding while the number stays put.
  assert.match(details, /templateDraftReferences\(draft\)/);
  const missingCall = details.indexOf(
    "templateDraftMissingReferences(references, {",
  );
  assert.ok(missingCall >= 0);
  const missingCallEnd = details.indexOf("});", missingCall);
  assert.ok(missingCallEnd > missingCall);
  const known = details.slice(missingCall, missingCallEnd);
  assert.match(known, /projects: validProjects/);
  assert.doesNotMatch(known, /pendingProjects/);
  assert.match(details, /pendingReferences: pendingProjects\.length/);
  assert.match(details, /missingReferences: missingCount/);
  assert.match(details, /templateProjectPathDecision\(\{/);
  assert.match(details, /picker\.list\(path\)/);
  assert.match(details, /templateProjectPathError/);
  assert.match(details, /templateSecretMissing/);
  assert.match(details, /templateVolumeMissing/);
  assert.match(details, /templateChooseVolume/);
  assert.match(details, /templateChooseSecret/);
  assert.match(modal, /templateCheckingReferences/);
  assert.match(modal, /templateReferenceMissingOne/);
  assert.match(modal, /templateReferenceMissingMany/);
  assert.match(details, /missingCount/);
  // Continue requires the plan, the draft, no pending check and no missing
  // reference — the block reason is the one gate.
  assert.match(
    details,
    /const canContinue = !busy && block === undefined && inspection !== null/,
  );
  // The draft is reset when the popup reopens or the selection changes, from
  // the provided resume draft when there is one.
  assert.match(details, /\},\s*\[\s*open,\s*selection,/);
  // Continue hands the edited draft, unchanged in shape, to the editor
  // prefill; a replace still carries its template source for the ports.
  assert.match(
    details,
    /onContinue\(\s*"create",\s*containers\.length === 0 \? "default" : "",\s*currentDraft,/,
  );
  assert.match(
    details,
    /onContinue\(\s*"replace",\s*replaceTarget,\s*currentDraft,\s*source,/,
  );
  // Nothing of the removed "Needs attention" machinery survives anywhere.
  assert.equal(details.includes("templateNeedsAttention"), false);
  assert.equal(details.includes("templateWarnings"), false);
  assert.equal(details.includes("templateFromOriginal"), false);
  assert.equal(modal.includes("templateFromOriginal"), false);
  assert.doesNotMatch(details, /secretMap|projectMap|volumeMap/);
  assert.doesNotMatch(details, /MissingProjectRow|MissingSourceRow/);
  assert.doesNotMatch(
    details,
    /templateUnresolvedReferences|templateReferences/,
  );
  // The workspace hands the popup its images and the gateway state the ports
  // group needs.
  assert.match(wrapper, /images: readonly ImageView\[\]/);
  assert.match(wrapper, /gatewayUnavailable: boolean/);
});

test("the editor lists the secrets a configuration still needs", () => {
  assert.deepEqual(
    missingSecretNames(
      { A: "known", B: "missing", C: "missing", D: "" },
      [{ name: "known" }],
    ),
    ["missing"],
  );
});

test("the template reference wording names every offending value", () => {
  // A stub translate reads the English dictionary and interpolates the caller's
  // parameters, so the test asserts the wording the popup actually produces.
  const translate: Translate = (key, params) => {
    let text = en[key];
    for (const [name, value] of Object.entries(params ?? {})) {
      text = text.replaceAll(`{${name}}`, value);
    }
    return text;
  };
  assert.equal(
    templateProjectPathError(translate, "app", "missing"),
    "Project “app” does not exist under the projects root.",
  );
  assert.equal(
    templateProjectPathError(translate, "../outside", "escapesRoot"),
    "Project “../outside” is not a valid project path.",
  );
  assert.equal(
    templateProjectPathError(translate, "/absolute", "absolute"),
    "Project “/absolute” is not a valid project path.",
  );
  // An empty field is a choice still to make, not a failure naming nothing.
  assert.equal(
    templateProjectPathError(translate, "", "empty"),
    "Choose a project.",
  );
  // Volume and secret messages carry their value too, in both languages.
  for (const dictionary of [en, zh]) {
    assert.ok(dictionary.templateVolumeMissing.includes("{volume}"));
    assert.ok(dictionary.templateSecretMissing.includes("{secret}"));
    assert.ok(dictionary.templateVolumeMissing.includes("“"));
    assert.ok(dictionary.templateSecretMissing.includes("“"));
  }
});

test("an unchanged project check is not written back", () => {
  const ok: TemplateProjectCheck = { state: "ok", project: "app" };
  const missing: TemplateProjectCheck = {
    state: "error",
    project: "app",
    error: "Project “app” does not exist under the projects root.",
  };
  assert.equal(templateProjectChecksEqual({ 0: ok }, { 0: { ...ok } }), true);
  assert.equal(
    templateProjectChecksEqual({ 0: missing }, { 0: { ...missing } }),
    true,
  );
  // A different value, state, error or set of keys is a change.
  assert.equal(
    templateProjectChecksEqual({ 0: ok }, { 0: { ...ok, project: "other" } }),
    false,
  );
  assert.equal(
    templateProjectChecksEqual({ 0: ok }, {
      0: { state: "pending", project: "app" },
    }),
    false,
  );
  assert.equal(
    templateProjectChecksEqual({ 0: missing }, {
      0: { ...missing, error: "another message" },
    }),
    false,
  );
  assert.equal(templateProjectChecksEqual({ 0: ok }, {}), false);
});

test("a row's error renders after the entry, not in the source slot", (t) => {
  const shared = clientSource("container-card-shared.tsx");
  if (shared === undefined) {
    t.skip("not a source checkout");
    return;
  }
  // Both shared rows render the same message paragraph after the whole row,
  // full width and announced as an alert.
  assert.match(shared, /function RowValidationError/);
  assert.match(shared, /width: "100%", textAlign: "left"/);
  assert.equal(
    (shared.match(/<RowValidationError message=\{error\} \/>/g) ?? []).length,
    2,
  );
  // The source slot's `below` carries only the browse error now: the reference
  // error moved out of the narrow column.
  const sourceStart = shared.indexOf("label: mountSourceLabel(t, mount.kind)");
  const sourceEnd = shared.indexOf("const modeLabel", sourceStart);
  assert.ok(sourceStart >= 0 && sourceEnd > sourceStart);
  const sourceField = shared.slice(sourceStart, sourceEnd);
  assert.match(sourceField, /below=\{browseError !== undefined/);
  assert.doesNotMatch(sourceField, /error === undefined/);
  // Both rows are memoized so an edit to one does not re-render the list.
  assert.match(shared, /export const MountRow = memo\(function MountRow/);
  assert.match(
    shared,
    /export const SecretEnvRow = memo\(function SecretEnvRow/,
  );
  // The editor dialogs pass no project reference validation and no row-action
  // browser; the container form supplies destination row errors of its own.
  const form = clientSource("container-card-form.tsx");
  if (form === undefined) {
    t.skip("not a source checkout");
    return;
  }
  assert.match(form, /rowError=\{reportMountError\}/);
  assert.doesNotMatch(form, /onProjectBrowse=/);
  assert.doesNotMatch(form, /projectBrowseLabel=/);
});

test("the secret environment row names its second slot the secret name", (t) => {
  const shared = clientSource("container-card-shared.tsx");
  if (shared === undefined) {
    t.skip("not a source checkout");
    return;
  }
  // The row pairs the variable with the secret it points at, so its second
  // slot is headed Secret name — the wording a secret mount already uses —
  // rather than Value. The label is static, so the block and every editor that
  // renders the row in either mode carry it.
  const rowStart = shared.indexOf(
    "export const SecretEnvRow = memo(function SecretEnvRow",
  );
  const rowEnd = shared.indexOf("// One published port", rowStart);
  assert.ok(rowStart >= 0 && rowEnd > rowStart);
  const row = shared.slice(rowStart, rowEnd);
  assert.match(row, /label: t\("envKey"\)/);
  assert.match(row, /label: t\("secretName"\)/);
  assert.doesNotMatch(row, /label: t\("envValue"\)/);
  // Only the heading changes: the slot stays the environment value's as far as
  // its copy control and its read-only/edit pairing are concerned.
  assert.match(row, /copyLabel=\{t\("copyEnvValue", \{ key: name \}\)\}/);
  assert.equal((row.match(/mode=\{mode\}/g) ?? []).length, 2);
  // The ordinary environment row is untouched: its value stays headed Value.
  const envStart = shared.indexOf("export function EnvRow");
  const envEnd = shared.indexOf("// The short mode", envStart);
  assert.ok(envStart >= 0 && envEnd > envStart);
  const envRow = shared.slice(envStart, envEnd);
  assert.match(envRow, /label: t\("envKey"\)/);
  assert.match(envRow, /label: t\("envValue"\)/);
  // Both languages already carry the heading this row now uses.
  assert.ok(en.secretName.length > 0);
  assert.ok(zh.secretName.length > 0);
});

test("the popup checks projects only on open, blur and Continue", (t) => {
  const modal = clientSource("container-card-templates.tsx");
  if (modal === undefined) {
    t.skip("not a source checkout");
    return;
  }
  const detailsStart = modal.indexOf("function TemplateDetailsModal");
  const wrapperStart = modal.indexOf("export function LoadTemplateModal");
  assert.ok(detailsStart >= 0 && wrapperStart > detailsStart);
  const details = modal.slice(detailsStart, wrapperStart);
  // The keystroke-keyed effect is gone: no projectKey and no check that follows
  // every edit to the draft.
  assert.doesNotMatch(details, /projectKey/);
  assert.match(
    details,
    /\}, \[open, draftSeeded, initialDraft, checkProjects\]\);/,
  );
  // A blur still re-runs the host check, and Continue awaits one more run.
  assert.match(details, /onProjectBlur=\{\(\) => void checkProjects\(\)\}/);
  assert.match(details, /const projectsOk = await checkProjects\(\);/);
  // Every write compares its answer with the stored one, so an unchanged answer
  // causes no render.
  assert.match(details, /templateProjectChecksEqual\(previous, updated\)/);
  assert.match(details, /templateProjectChecksEqual\(previous, next\)/);
  // Typing keeps a host failure on screen until a blur re-checks the value. The
  // pending row is still counted as outstanding, so the footer keeps its number
  // while the re-check runs rather than switching to the checking text.
  assert.match(
    details,
    /if \(stored !== undefined && stored\.state === "error"\) return stored;/,
  );
  assert.match(details, /pendingReferences: pendingProjects\.length/);
  assert.match(details, /missingReferences: missingCount/);
});

test("the footer reason line stays mounted and only updates its text", (t) => {
  const modal = clientSource("container-card-templates.tsx");
  if (modal === undefined) {
    t.skip("not a source checkout");
    return;
  }
  const detailsStart = modal.indexOf("function TemplateDetailsModal");
  const wrapperStart = modal.indexOf("export function LoadTemplateModal");
  assert.ok(detailsStart >= 0 && wrapperStart > detailsStart);
  const details = modal.slice(detailsStart, wrapperStart);
  const footerStart = details.indexOf("const footer = (");
  const footerEnd = details.indexOf("  return (", footerStart);
  assert.ok(footerStart >= 0 && footerEnd > footerStart);
  const footer = details.slice(footerStart, footerEnd);
  // The reason span is rendered unconditionally and carries no key, so a change
  // between the checking text and the count updates this one mounted node
  // instead of replacing it.
  const reasonStart = footer.indexOf("<span");
  const reasonEnd = footer.indexOf("</span>", reasonStart);
  assert.ok(reasonStart >= 0 && reasonEnd > reasonStart);
  const reason = footer.slice(reasonStart, reasonEnd);
  assert.doesNotMatch(reason, /\bkey=/);
  assert.match(reason, /\{blockText \?\? ""\}/);
  assert.match(
    reason,
    /role=\{blockText === undefined \? "status" : "alert"\}/,
  );
});

test("the popup offers storage creation only for a matching mount", (t) => {
  const modal = clientSource("container-card-templates.tsx");
  if (modal === undefined) {
    t.skip("not a source checkout");
    return;
  }
  const detailsStart = modal.indexOf("function TemplateDetailsModal");
  const wrapperStart = modal.indexOf("export function LoadTemplateModal");
  assert.ok(detailsStart >= 0 && wrapperStart > detailsStart);
  const details = modal.slice(detailsStart, wrapperStart);
  // Each action exists only while the draft carries such a mount, and the
  // MountsEditor slot places it beside Add mount.
  assert.match(
    details,
    /const hasVolumeMount = draftMounts\.some\(\(mount\) => mount\.kind === "volume"\)/,
  );
  assert.match(
    details,
    /const hasSecretMount = draftMounts\.some\(\(mount\) => mount\.kind === "secret"\)/,
  );
  assert.match(details, /actions=\{mountActions\}/);
  assert.match(details, /<CreateVolumeModal/);
  assert.match(details, /<SecretModal/);
  // Both dialogs are openable only through the existing creators, and both
  // actions are disabled while the session cannot write or is busy.
  assert.match(details, /void createVolume\(name\)/);
  assert.match(details, /void onCreateSecret\(name, length, charset\)/);
  assert.match(details, /disabled=\{!writable \|\| busy\}/);
  // The "does not exist" message follows the live list, so a refreshed
  // snapshot that holds the created name clears it and makes it selectable.
  assert.match(
    details,
    /!volumes\.some\(\(volume\) => volume\.name === mount\.volume\)/,
  );
  assert.match(
    details,
    /!secrets\.some\(\(secret\) => secret\.name === mount\.secret\)/,
  );
});

test("the popup browses a project row from the row's actions", (t) => {
  const modal = clientSource("container-card-templates.tsx");
  const editors = clientSource("container-card-editors.tsx");
  const shared = clientSource("container-card-shared.tsx");
  if (modal === undefined || editors === undefined || shared === undefined) {
    t.skip("not a source checkout");
    return;
  }
  const detailsStart = modal.indexOf("function TemplateDetailsModal");
  const wrapperStart = modal.indexOf("export function LoadTemplateModal");
  assert.ok(detailsStart >= 0 && wrapperStart > detailsStart);
  const details = modal.slice(detailsStart, wrapperStart);
  // The callback is threaded from the popup through MountsEditor and MountRow.
  assert.match(details, /onProjectBrowse=\{directoryPicker === undefined/);
  assert.match(details, /projectBrowseLabel=\{t\("templateBrowse"\)\}/);
  assert.match(details, /<DirectoryPickerModal/);
  assert.match(
    details,
    /projectNameFromHostPath\(projectsRoot, path\) \?\? path/,
  );
  // Picking fills the field and re-runs the same host check a blur runs.
  assert.match(details, /void checkProjects\(\);/);
  assert.match(editors, /onProjectBrowse\?: \(index: number\) => void/);
  assert.match(
    editors,
    /onProjectBrowse=\{onProjectBrowse === undefined[\s\S]{0,80}callbacks\.browse\}/,
  );
  assert.match(shared, /onProjectBrowse\?: \(\) => void/);
  // The shared row no longer builds a label-line action; the offered Browse is
  // composed into the row's actions beside Remove.
  assert.doesNotMatch(shared, /mountProjectBrowseAction|labelAction|labelLine/);
  // The editor dialogs never pass it.
  const form = clientSource("container-card-form.tsx");
  if (form === undefined) {
    t.skip("not a source checkout");
    return;
  }
  assert.doesNotMatch(form, /onProjectBrowse/);
});

test("a project row keeps its stored error until the check resolves", (t) => {
  const modal = clientSource("container-card-templates.tsx");
  if (modal === undefined) {
    t.skip("not a source checkout");
    return;
  }
  const detailsStart = modal.indexOf("function TemplateDetailsModal");
  const wrapperStart = modal.indexOf("export function LoadTemplateModal");
  assert.ok(detailsStart >= 0 && wrapperStart > detailsStart);
  const details = modal.slice(detailsStart, wrapperStart);
  // The row's message is the current check's error, or the answer already
  // stored for the row while a changed value is pending. It is never a
  // placeholder that hides a failure during the host call.
  const rowStart = details.indexOf("const mountRowError = (");
  const rowEnd = details.indexOf(
    "// The same message for a secret environment value.",
    rowStart,
  );
  assert.ok(rowStart >= 0 && rowEnd > rowStart);
  const rowError = details.slice(rowStart, rowEnd);
  assert.match(
    rowError,
    /if \(check\.state === "error"\) return check\.error;/,
  );
  assert.match(rowError, /if \(check\.state === "pending"\) \{/);
  assert.match(rowError, /const stored = projectChecks\[index\];/);
  assert.match(
    rowError,
    /stored !== undefined && stored\.state === "error"/,
  );
  assert.match(rowError, /return stored\.error;/);
  // The stored answer survives the re-check: the value being listed is tracked
  // beside the settled checks, so the row reports pending while
  // `projectChecks[index]` still holds the failure it reports.
  assert.match(details, /projectChecksInFlight\[index\] === project/);
  assert.match(
    details,
    /\(stored === undefined \|\| stored\.project !== project\)/,
  );
  assert.match(details, /setProjectChecksInFlight\(inFlight\)/);
  assert.match(
    details,
    /if \(settled !== undefined && settled\.state !== "pending"\) \{\s*next\[index\] = settled;/,
  );
  // A resolving check stores its own answer and leaves the pending set, so the
  // row reports the new error — or no error at all when the value cleared.
  assert.match(details, /\[index\]: answer/);
  assert.match(details, /delete updated\[index\];/);
  // Lexical checks stay synchronous and precede the stored-error fallback, so
  // an invalid value updates its message immediately rather than staying
  // pending.
  const checkStart = details.indexOf("const projectCheck = (");
  const checkEnd = details.indexOf("// The draft's references", checkStart);
  assert.ok(checkStart >= 0 && checkEnd > checkStart);
  const check = details.slice(checkStart, checkEnd);
  const lexical = check.indexOf("if (!lexical.ok) {");
  const fallback = check.indexOf('stored.state === "error"');
  assert.ok(lexical >= 0, "the row's check makes the lexical decision");
  assert.ok(fallback > lexical, "a lexical error wins over a stored answer");
  assert.match(
    check,
    /templateProjectPathError\(t, project, lexical\.reason\)/,
  );
  // Only a blur (or Continue) asks the host again.
  assert.match(details, /onProjectBlur=\{\(\) => void checkProjects\(\)\}/);
});

test("a row's error paragraph changes text without remounting", (t) => {
  const shared = clientSource("container-card-shared.tsx");
  if (shared === undefined) {
    t.skip("not a source checkout");
    return;
  }
  const start = shared.indexOf("function RowValidationError");
  const end = shared.indexOf(
    "// The compact controls a PATH row carries",
    start,
  );
  assert.ok(start >= 0 && end > start);
  const paragraph = shared.slice(start, end);
  // The paragraph is keyless and rendered whenever a message exists, so two
  // invalid values change the text of one mounted node instead of unmounting
  // it and mounting another.
  assert.match(paragraph, /<p\s/);
  assert.doesNotMatch(paragraph, /\bkey=/);
  assert.match(
    paragraph,
    /if \(props\.message === undefined \|\| props\.message === ""\) return null;/,
  );
  // The mount row always hands it the current message.
  assert.match(shared, /<RowValidationError message=\{error\} \/>/);
});

test("the project Browse is an outlined small action before Remove", (t) => {
  const modal = clientSource("container-card-templates.tsx");
  const shared = clientSource("container-card-shared.tsx");
  const locales = clientSource("locales.ts");
  const form = clientSource("container-card-form.tsx");
  if (
    modal === undefined || shared === undefined || locales === undefined ||
    form === undefined
  ) {
    t.skip("not a source checkout");
    return;
  }
  const start = shared.indexOf("const browseAction =");
  const end = shared.indexOf("const actions =", start);
  assert.ok(start >= 0 && end > start);
  const browse = shared.slice(start, end);
  // The harness's outlined small control, not plain text or a ghost action.
  assert.match(browse, /<Button\s+variant="outline"\s+size="sm"/);
  assert.doesNotMatch(browse, /variant="ghost"/);
  // A read-only workspace, a busy session and the row's own disabled state all
  // disable it, the same gates the row's other write actions carry.
  assert.match(
    browse,
    /disabled=\{mountRowBrowseDisabled\(disabledField, writable, busy\)\}/,
  );
  // Only an editor project row whose caller supplied a browser gets it.
  assert.match(
    browse,
    /mountRowBrowseOffered\(mode, mount\.kind, onProjectBrowse\)/,
  );
  assert.match(browse, /onProjectBrowse !== undefined/);
  assert.match(browse, /projectBrowseLabel \?\? t\("templateBrowse"\)/);
  // The row's actions keep Browse immediately before Remove, in one fragment.
  const composedStart = shared.indexOf("const actions =", start);
  const composedEnd = shared.indexOf("return (", composedStart);
  assert.ok(composedStart >= 0 && composedEnd > composedStart);
  const composed = shared.slice(composedStart, composedEnd);
  assert.match(composed, /<>\s*\{browseAction\}\s*\{removeAction\}\s*<\/>/);
  // No label-line action remains: the slot prop is gone and the popup's source
  // field passes none.
  assert.doesNotMatch(shared, /labelAction|labelLine|mountProjectBrowseAction/);
  assert.doesNotMatch(modal, /labelAction/);
  assert.doesNotMatch(browse, /…/);
  // The popup supplies the no-ellipsis label, and both locales spell it plainly.
  assert.match(modal, /projectBrowseLabel=\{t\("templateBrowse"\)\}/);
  assert.match(locales, /templateBrowse: "Browse",/);
  assert.match(locales, /templateBrowse: "浏览",/);
  // The editor passes none of it and keeps rendering its plain label.
  assert.doesNotMatch(form, /onProjectBrowse|projectBrowseLabel/);
});

test("replacing prefills the edit editor from the template and keeps omitted fields", () => {
  const template = parseContainerTemplate(`version: 1
kind: dsh-podman/container-template
spec:
  image: ubuntu
  env: {NODE_ENV: development}
  paths: [/usr/local/bin]
  ports:
    - {container: 8080, host: 8080, protocol: tcp}
`);
  const current: TemplateCurrentConfig = {
    env: { KEEP: "1", NODE_ENV: "current" },
    mounts: [{
      kind: "project",
      project: "app",
      destination: "",
      mode: "read_only",
      volume: "",
      secret: "",
    }, {
      kind: "volume",
      volume: "cache",
      destination: "/cache",
      mode: "read_write",
      project: "",
      secret: "",
    }],
    paths: ["/bin"],
    secretEnv: { TOKEN: "token" },
    ports: [{
      port: 3000,
      protocol: "tcp",
      endpoint: "127.0.0.1:3000",
      suggestedHostPort: 0,
      hostPort: 3000,
    }],
  };
  const config = templateConfigForEditor(template, "template-web", {
    defaultEnv: {
      FROM: "default",
      KEEP: "default",
      NODE_ENV: "default",
    },
    current,
  });
  assert.equal(config.image, "template-web");
  // The environment layers defaults, then the container's current values, then
  // the template's: a default fills what neither names, an existing value
  // wins over the default, and the template wins over both.
  assert.deepEqual(config.env, {
    FROM: "default",
    KEEP: "1",
    NODE_ENV: "development",
  });
  assert.deepEqual(Object.keys(config.env), ["FROM", "KEEP", "NODE_ENV"]);
  // The fields the template defines replace the current ones.
  assert.deepEqual(config.paths, ["/usr/local/bin"]);
  // The fields it omits are shown as they currently are: a template that
  // declares no mounts leaves the container's own mounts untouched, including
  // the mode its project mount already has.
  assert.deepEqual(config.mounts, current.mounts);
  assert.deepEqual(config.secretEnv, { TOKEN: "token" });
  // The template's own ports stay out: the host publishes them after Apply, and
  // the editor keeps the ports the container already publishes.
  assert.deepEqual(config.ports, current.ports);
});

test("a default container round-trips through an exported template", () => {
  const gitIdentity = {
    GIT_AUTHOR_NAME: "Example",
    GIT_AUTHOR_EMAIL: "example@example.org",
    GIT_COMMITTER_NAME: "Example",
    GIT_COMMITTER_EMAIL: "example@example.org",
  };
  const defaults = { ...gitIdentity, LANG: "C.UTF-8", TERM: "xterm-256color" };
  // The container an export starts from: the defaults plus its own entries.
  const env = { ...defaults, CUSTOM: "1", EXTRA_PATH: "/opt/bin" };
  const exported = exportContainerTemplate(
    {
      containerName: "default",
      imageId: "ubuntu",
      env,
      mounts: [],
      paths: [],
      publishedPorts: [],
    },
    [],
    "app",
  );
  // The export deliberately drops the Git identity variables...
  for (const key of GIT_IDENTITY_KEYS) {
    assert.equal(exported.template.spec.env[key], undefined);
  }
  // ...so editing the same container from the template must put them back
  // through the default environment, with the rest of the environment intact.
  const config = templateConfigForEditor(
    parseContainerTemplate(exported.yaml),
    "ubuntu",
    {
      defaultEnv: defaults,
      current: {
        env,
        mounts: [],
        paths: [],
        secretEnv: {},
        ports: [],
      },
    },
  );
  assert.deepEqual(config.env, env);
});

// The test translator renders the English dictionary the way the host does, so
// the picker's copy is asserted as the user reads it.
const translate: Translate = (key, params) => {
  const template = en[key];
  if (params === undefined) return template;
  return template.replace(
    /\{(\w+)\}/g,
    (_, name: string) => params[name] ?? "",
  );
};

test("a picker summary exposes every fact the row describes", () => {
  const summary = templateSpecSummary(`version: 1
kind: dsh-podman/container-template
spec:
  image: ubuntu
  env: {NODE_ENV: production}
  secretEnv: {GITHUB_TOKEN: npm-token}
  mounts:
    - {kind: project, project: app}
    - {kind: project, project: docs}
    - {kind: volume, volume: cache, destination: /cache}
    - {kind: secret, secret: token, destination: /root/.npmrc}
    - {kind: tmpfs, destination: /tmp}
  paths: [/usr/local/bin, /opt/bin]
  ports:
    - {container: 8080, host: 8080, protocol: tcp}
    - {container: 3000, host: 8080, protocol: tcp}
`);
  assert.equal(summary.valid, true);
  if (!summary.valid) return;
  assert.deepEqual(summary.image, { kind: "base", base: "ubuntu" });
  assert.equal(summary.packages, 0);
  // The row states the plain variables; the secret variable's own secret is
  // what the secrets fact names.
  assert.deepEqual(summary.envNames, ["NODE_ENV"]);
  // Mounts are named by their source: projects, volumes and secrets by name,
  // tmpfs by the destination that is its only identity.
  assert.deepEqual(summary.mounts, ["app", "docs", "cache", "token", "/tmp"]);
  assert.deepEqual(summary.paths, ["/usr/local/bin", "/opt/bin"]);
  assert.deepEqual(summary.ports, ["8080", "3000→8080"]);
  // TOKEN's secret is required by the mount, npm-token by GITHUB_TOKEN.
  assert.deepEqual(summary.secrets, ["npm-token", "token"]);

  const segments = templateSummarySegments(translate, summary);
  assert.deepEqual(segments, [
    { label: "", values: ["ubuntu"] },
    { label: "env", values: ["NODE_ENV"] },
    { label: "mounts", values: [], count: 5 },
    { label: "secrets", values: ["npm-token", "token"] },
    { label: "PATH", values: ["/usr/local/bin", "/opt/bin"] },
    { label: "ports", values: [], count: 2 },
  ]);
  assert.equal(
    templateSummaryLineText(segments),
    "ubuntu · env: NODE_ENV · mounts: 5 · secrets: npm-token, token · PATH: /usr/local/bin, /opt/bin · ports: 2",
  );
});

test("a rich template renders every category in the row's order", () => {
  const summary = templateSpecSummary(`version: 1
kind: dsh-podman/container-template
spec:
  imageTemplate: {base: ubuntu, packages: [neovim, tmux, htop]}
  env: {NODE_ENV: production, GITHUB_TOKEN: token}
  secretEnv: {NPM_TOKEN: npm-token}
  mounts:
    - {kind: project, project: app}
    - {kind: volume, volume: cache, destination: /cache}
  ports:
    - {container: 8080, host: 8080, protocol: tcp}
`);
  assert.equal(summary.valid, true);
  if (!summary.valid) return;
  assert.equal(summary.packages, 3);
  assert.equal(
    templateSummaryLineText(templateSummarySegments(translate, summary)),
    "ubuntu +3 packages · env: NODE_ENV, GITHUB_TOKEN · mounts: app, cache · secrets: npm-token · ports: 8080",
  );
});

test("a sparse template renders only its image", () => {
  const summary = templateSpecSummary(`version: 1
kind: dsh-podman/container-template
spec:
  image: alpine
`);
  assert.equal(summary.valid, true);
  if (!summary.valid) return;
  assert.deepEqual(templateSummarySegments(translate, summary), [
    { label: "", values: ["alpine"] },
  ]);
  assert.equal(
    templateSummaryLineText(templateSummarySegments(translate, summary)),
    "alpine",
  );
});

test("three values collapse to a bare count, two stay named", () => {
  const summary = templateSpecSummary(`version: 1
kind: dsh-podman/container-template
spec:
  imageTemplate: {base: archlinux, packages: [p1, p2, p3, p4, p5]}
  env: {A: "1", B: "2", C: "3", D: "4", E: "5", F: "6", G: "7"}
  mounts:
    - {kind: project, project: m1}
    - {kind: project, project: m2}
    - {kind: project, project: m3}
    - {kind: project, project: m4}
    - {kind: project, project: m5}
    - {kind: project, project: m6}
    - {kind: project, project: m7}
    - {kind: project, project: m8}
    - {kind: project, project: m9}
  secretEnv: {S1: s1, S2: s2, S3: s3, S4: s4}
  paths: [/bin/one, /bin/two, /bin/three]
  ports:
    - {container: 8080, protocol: tcp}
    - {container: 8081, protocol: tcp}
`);
  assert.equal(summary.valid, true);
  if (!summary.valid) return;
  assert.deepEqual(templateSummarySegments(translate, summary), [
    { label: "", values: ["archlinux +5 packages"] },
    { label: "env", values: [], count: 7 },
    { label: "mounts", values: [], count: 9 },
    { label: "secrets", values: [], count: 4 },
    { label: "PATH", values: [], count: 3 },
    { label: "ports", values: [], count: 2 },
  ]);
  assert.equal(
    templateSummaryLineText(templateSummarySegments(translate, summary)),
    "archlinux +5 packages · env: 7 · mounts: 9 · secrets: 4 · PATH: 3 · ports: 2",
  );
});

test("a differing host port shows its mapping, a matching one stays bare", () => {
  // The row's own mapping rule is exact, including a privileged host port the
  // parser would reject for a real template.
  assert.equal(
    templatePortRowValue({ container: 8080, host: 80, protocol: "tcp" }),
    "8080→80",
  );
  const summary = templateSpecSummary(`version: 1
kind: dsh-podman/container-template
spec:
  image: ubuntu
  ports:
    - {container: 3000, host: 8080, protocol: tcp}
`);
  assert.equal(summary.valid, true);
  if (!summary.valid) return;
  assert.deepEqual(summary.ports, ["3000→8080"]);
  assert.equal(
    templateSummaryLineText(templateSummarySegments(translate, summary)),
    "ubuntu · ports: 3000→8080",
  );
});

test("long identities render in full", () => {
  const summary = templateSpecSummary(`version: 1
kind: dsh-podman/container-template
spec:
  imageTemplate: {base: ubuntu, packages: [neovim, tmux, htop, fd, nano, bat]}
  env: {A_VERY_LONG_ENVIRONMENT_VARIABLE_NAME: value, NODE_ENV: production}
  mounts:
    - {kind: volume, volume: dsh-subagent-sidebar, destination: /sidebar}
    - {kind: volume, volume: go-download-licenses, destination: /licenses}
`);
  assert.equal(summary.valid, true);
  if (!summary.valid) return;
  const line = templateSummaryLineText(
    templateSummarySegments(translate, summary),
  );
  assert.equal(
    line,
    "ubuntu +6 packages · env: A_VERY_LONG_ENVIRONMENT_VARIABLE_NAME, NODE_ENV · mounts: dsh-subagent-sidebar, go-download-licenses",
  );
  assert.ok(line.includes("dsh-subagent-sidebar"));
  assert.ok(line.includes("go-download-licenses"));
  assert.ok(line.includes("A_VERY_LONG_ENVIRONMENT_VARIABLE_NAME"));
  assert.ok(!line.includes("…"));
});

test("the accessible label carries the same complete summary text", () => {
  const summary = templateSpecSummary(`version: 1
kind: dsh-podman/container-template
spec:
  imageTemplate: {base: ubuntu, packages: [neovim, tmux, htop]}
  env: {NODE_ENV: production, GITHUB_TOKEN: token}
  secretEnv: {NPM_TOKEN: npm-token}
  mounts:
    - {kind: project, project: app}
    - {kind: volume, volume: cache, destination: /cache}
  ports:
    - {container: 8080, host: 8080, protocol: tcp}
`);
  assert.equal(summary.valid, true);
  if (!summary.valid) return;
  const segments = templateSummarySegments(translate, summary);
  const label = templateSummaryAccessibleLabel(translate, "Web Dev", summary);
  assert.equal(label, `Web Dev · ${templateSummaryLineText(segments)}`);
  for (const segment of segments) {
    assert.ok(label.includes(templateSummarySegmentText(segment)));
  }
  assert.ok(label.includes("ubuntu +3 packages"));
  assert.ok(label.includes("mounts: app, cache"));
});

test("an invalid template shows a reason, not facts, in its accessible label", () => {
  const invalid = templateSpecSummary(`version: 1
kind: dsh-podman/container-template
spec:
  image: debian
`);
  assert.equal(invalid.valid, false);
  if (invalid.valid) return;
  assert.match(invalid.reason, /unsupported base image/);
  assert.ok(invalid.reason.length > 0);
  assert.deepEqual(templateSummarySegments(translate, invalid), []);
  assert.equal(
    templateSummaryAccessibleLabel(translate, "Broken", invalid),
    `Broken · ${invalid.reason}`,
  );
  assert.equal(templateDisplayName("Web Dev.yml"), "Web Dev");
  assert.equal(templateDisplayName("notes.yaml"), "notes");
  assert.equal(templateDisplayName("no-suffix"), "no-suffix");
});

test("an invalid template's reason is kept whole, across lines", () => {
  // A message longer than the old 56-character cap comes back in full.
  const long = `unsupported base image ${JSON.stringify("x".repeat(80))}`;
  assert.ok(long.length > 56);
  assert.equal(invalidTemplateReason(new Error(long)), long);
  // Every line survives, not just the first, and only the message's edges are
  // trimmed.
  const multiLine = "invalid YAML: bad indentation\n" +
    "  line 4, column 3:\n" +
    "    nope\n";
  assert.equal(
    invalidTemplateReason(new Error(multiLine)),
    "invalid YAML: bad indentation\n  line 4, column 3:\n    nope",
  );
  // The same whole reason reaches the picker through the parsed summary.
  const longKey = "X".repeat(80);
  const summary = templateSpecSummary(`version: 1
kind: dsh-podman/container-template
spec:
  image: ubuntu
  ${longKey}: 1
`);
  assert.equal(summary.valid, false);
  if (summary.valid) return;
  assert.ok(summary.reason.length > 56);
  assert.ok(summary.reason.includes(longKey));
});

test("the picker's Next is actionable only for a parsed, valid choice", () => {
  const valid = templateSpecSummary(`version: 1
kind: dsh-podman/container-template
spec:
  image: alpine
`);
  const invalid = templateSpecSummary(`version: 1
kind: dsh-podman/container-template
spec:
  image: debian
`);
  assert.equal(valid.valid, true);
  assert.equal(invalid.valid, false);
  // A project entry and an upload both reach Next as the same summary shape.
  assert.equal(templateChoiceActionable(valid, false), true);
  assert.equal(templateChoiceActionable(invalid, false), false);
  // A missing summary is defensively disabled, and a busy command disables even
  // a valid choice.
  assert.equal(templateChoiceActionable(undefined, false), false);
  assert.equal(templateChoiceActionable(valid, true), false);
});

test("a template's required secrets are its environment and mount names, once", () => {
  const template = parseContainerTemplate(`version: 1
kind: dsh-podman/container-template
spec:
  image: ubuntu
  secretEnv: {TOKEN: token, API: api-token}
  mounts:
    - {kind: secret, secret: token, destination: /run/token}
    - {kind: secret, secret: npm-token, destination: /root/.npmrc}
`);
  assert.deepEqual(templateSecretNames(template), [
    "token",
    "api-token",
    "npm-token",
  ]);
});

test("the picker only selects, and nothing builds or creates on its own", (t) => {
  const modal = clientSource("container-card-templates.tsx");
  if (modal === undefined) {
    t.skip("not a source checkout");
    return;
  }
  const pickerStart = modal.indexOf("function TemplatePickerModal");
  const detailsStart = modal.indexOf("function TemplateDetailsModal");
  const wrapperStart = modal.indexOf("export function LoadTemplateModal");
  assert.ok(
    pickerStart >= 0 && detailsStart > pickerStart &&
      wrapperStart > detailsStart,
    "the picker and the details popup are separate components",
  );
  const picker = modal.slice(pickerStart, detailsStart);
  const details = modal.slice(detailsStart, wrapperStart);
  // The picker lists the project's templates and offers an upload; it never
  // preselects an entry and triggers no inspect, build, creation or hand-off.
  assert.match(picker, /listTemplates/);
  assert.match(picker, /t\("templateNext"\)/);
  assert.doesNotMatch(picker, /setSelected\(listed/);
  assert.doesNotMatch(
    picker,
    /inspectTemplate|buildTemplate|applyTemplate|onContinue/,
  );
  // It is one list: a pressed selection state, the template's name, a
  // description parsed from the spec, and Next disabled until a parsed, valid
  // choice exists.
  assert.match(picker, /aria-pressed=\{isSelected\}/);
  assert.match(picker, /templateDisplayName/);
  assert.match(picker, /templateSpecSummary/);
  assert.match(picker, /PickerDescription/);
  assert.match(picker, /title=\{entry\.name\}/);
  // Next reads the current choice's summary — the upload's or the selected
  // entry's — so an invalid one and a missing one both leave it disabled.
  assert.match(
    picker,
    /const choiceSummary: TemplateSpecSummary \| undefined = upload !== null/,
  );
  assert.match(picker, /uploadSummary/);
  assert.match(picker, /summaries\.get\(selectedEntry\.name\)/);
  assert.match(picker, /templateChoiceActionable\(choiceSummary, busy\)/);
  assert.match(picker, /disabled=\{!nextEnabled\}/);
  assert.match(
    picker,
    /onClick=\{\(\) => \{\s*if \(!templateChoiceActionable\(choiceSummary, busy\)\) return;/,
  );
  assert.doesNotMatch(picker, /disabled=\{choice === undefined \|\| busy\}/);
  // An invalid file gets the reason in a wrapping error block; a valid one never
  // falls back to the old "Unreadable template" wording. That block prints the
  // parser's whole reason, so it is the single explanation of the disabled Next.
  assert.match(modal, /choiceInvalid/);
  assert.match(
    modal,
    /if \(!summary\.valid\) \{\s*return <span style=\{choiceInvalid\}>\{summary\.reason\}<\/span>;/,
  );
  assert.doesNotMatch(modal, /t\("templateInvalid"\)/);
  // The picker footer keeps only Cancel and Next: the reason is never copied
  // into a footer slot, so no footer text and no footer alert remains.
  const footerStart = picker.indexOf("const footer = (");
  const footerEnd = picker.indexOf("return (", footerStart);
  assert.ok(
    footerStart >= 0 && footerEnd > footerStart,
    "the picker footer is its own literal",
  );
  const pickerFooter = picker.slice(footerStart, footerEnd);
  assert.doesNotMatch(pickerFooter, /role=|footerReason|invalidHint/);
  assert.doesNotMatch(picker, /invalidHint|footerReason|footerReasonError/);
  assert.equal((pickerFooter.match(/<Button\b/g) ?? []).length, 2);
  assert.match(pickerFooter, /t\("cancel"\)/);
  assert.match(pickerFooter, /t\("templateNext"\)/);
  // A valid row renders the same structured summary the accessible label uses,
  // aligned from the top with the check and free to wrap to its own height.
  assert.match(modal, /templateSummarySegments/);
  assert.match(modal, /templateSummaryLineText/);
  assert.match(picker, /aria-label=\{templateSummaryAccessibleLabel\(/);
  assert.match(modal, /alignItems: "flex-start"/);
  // The facts are visible, never repeated in a tooltip.
  assert.doesNotMatch(picker, /title=\{[^}]*summary/i);
  // The facts line is not a one-line truncation: it wraps and shows values whole.
  const factsStyle = /const choiceFacts: CSSProperties = \{([\s\S]*?)\};/
    .exec(modal);
  assert.ok(factsStyle !== null, "the facts line has its own style");
  assert.match(factsStyle[1], /whiteSpace: "normal"/);
  assert.doesNotMatch(factsStyle[1], /textOverflow|nowrap|overflow: "hidden"/);
  // The invalid block is not a one-line pill either: it wraps, preserves the
  // parser's lines and has no truncation left to explain in a tooltip.
  const invalidStyle = /const choiceInvalid: CSSProperties = \{([\s\S]*?)\};/
    .exec(modal);
  assert.ok(invalidStyle !== null, "the invalid block has its own style");
  assert.match(invalidStyle[1], /whiteSpace: "pre-wrap"/);
  assert.match(invalidStyle[1], /overflowWrap: "anywhere"/);
  assert.doesNotMatch(
    invalidStyle[1],
    /textOverflow|nowrap|overflow: "hidden"|999px/,
  );
  assert.doesNotMatch(picker, /title=\{summary\.reason\}/);
  // The upload row is the one row marked with a chip: it says the file came
  // from the browser rather than from the project.
  assert.match(
    picker,
    /<Chip t=\{t\} label=\{t\("templateUploadChip"\)\} \/>/,
  );
  assert.equal((picker.match(/<Chip\b/g) ?? []).length, 1);
  // The details popup inspects (a read) and records the plan. Rendering it
  // never starts a build: only the image card's own action calls the build.
  assert.match(details, /inspectTemplate/);
  assert.doesNotMatch(details, /if \(inspected\.image\.needsBuild\)/);
  assert.doesNotMatch(details, /void build\(inspected\)/);
  assert.equal((details.match(/buildTemplate\(/g) ?? []).length, 1);
  // The one button dispatches the command its action names: the template's own
  // image keeps the template route, forcing it only for Rebuild.
  assert.equal((details.match(/void build\(/g) ?? []).length, 2);
  assert.match(details, /case "template-build":\s*void build\(false\)/);
  assert.match(details, /case "template-rebuild":\s*void build\(true\)/);
  assert.match(details, /onClick=\{\(\) => runImageAction\(imageAction\)\}/);
  // One label set serves both routes: the action decides Build, Rebuild and
  // Pull, and a running build or rebuild uses the shared short progress words.
  assert.match(details, /t\("build"\)/);
  assert.match(details, /t\("rebuildImage"\)/);
  assert.match(details, /t\("pullImage"\)/);
  assert.equal((modal.match(/t\("building"\)/g) ?? []).length, 1);
  assert.equal((modal.match(/t\("rebuilding"\)/g) ?? []).length, 1);
  assert.doesNotMatch(
    details,
    /imageAction\.command|t\("templateBuild|t\("templateRebuild/,
  );
  assert.match(details, /imageAction\.action === "building"/);
  assert.match(details, /aria-busy=\{imageActionRunning\}/);
  assert.match(details, /disabled=\{imageActionDisabled\}/);
  assert.doesNotMatch(details, /templateRetryBuild|templateBuildDone/);
  // Any other listed image dispatches the Images tab's own command, and each
  // such command asks the snapshot for a refresh afterwards.
  assert.match(details, /case "custom-build": \{/);
  assert.match(
    details,
    /onBuildImage\(image\.imageId, image\.parent, \[\.\.\.image\.packages\]\)/,
  );
  assert.match(details, /case "custom-rebuild":\s*onRebuildImage\(imageId\)/);
  assert.match(
    details,
    /case "base-build":\s*case "base-rebuild":\s*onRebuildBaseImage\(imageId\)/,
  );
  assert.match(details, /case "base-pull":\s*onPullBaseImage\(imageId\)/);
  // The shared image facts are the image's one representation, titled by the
  // same DialogGroup the container editor uses for its own groups: its action
  // sits beside the name and a failed build stays under the card in that group.
  assert.match(details, /<ImageFacts/);
  assert.match(
    details,
    /templateDraftImageFacts\(inspection\.image, draft\.image, images\)/,
  );
  assert.match(details, /imageId=\{imageFacts\.imageId\}/);
  assert.match(details, /status=\{imageFacts\.status\}/);
  assert.match(details, /builtAt=\{imageFacts\.builtAt\}/);
  assert.match(details, /source=\{imageFacts\.source\}/);
  assert.match(details, /packages=\{imageFacts\.packages\}/);
  assert.match(
    details,
    /actions=\{imageAction\.action === "none"\s*\? undefined/,
  );
  assert.equal(
    (details.match(/imageId=\{imageFacts\.imageId\}/g) ?? []).length,
    1,
  );
  assert.equal((details.match(/<ImageFacts\b/g) ?? []).length, 1);
  assert.match(details, /<ImageRow/);
  // The image group and the five preview groups are the container editor's own
  // dialog groups, with its titles in its order and no counts or guidance.
  const dialogTitles = [
    "image",
    "envTitle",
    "mountsTitle",
    "pathsTitle",
    "containerSecretsTitle",
    "portsTitle",
  ];
  const dialogPositions = dialogTitles.map((title) =>
    details.indexOf(`<DialogGroup title={t("${title}")}>`)
  );
  assert.ok(
    dialogPositions.every((position) => position >= 0),
    "every group is a DialogGroup with the editor's title",
  );
  for (let index = 1; index < dialogPositions.length; index++) {
    assert.ok(
      dialogPositions[index] > dialogPositions[index - 1],
      `${dialogTitles[index]} follows ${dialogTitles[index - 1]}`,
    );
  }
  assert.equal((details.match(/<DialogGroup\b/g) ?? []).length, 6);
  assert.equal(
    (details.match(/<DialogGroup title=\{t\("image"\)\}>/g) ?? []).length,
    1,
  );
  // The container view's FieldGroup label is gone from the popup.
  assert.doesNotMatch(details, /<FieldGroup\b/);
  const imageGroupStart = dialogPositions[0];
  assert.ok(imageGroupStart >= 0, "the image card is a titled group");
  const imageGroupEnd = details.indexOf("</DialogGroup>", imageGroupStart);
  assert.ok(
    imageGroupEnd > imageGroupStart,
    "the image group closes after its card",
  );
  const imageGroup = details.slice(
    imageGroupStart,
    imageGroupEnd + "</DialogGroup>".length,
  );
  assert.equal((imageGroup.match(/<ImageFacts\b/g) ?? []).length, 1);
  // The card keeps the row-list marker the rows and its narrow layout need.
  assert.match(imageGroup, /className=\{ROW_LIST_CLASS\}/);
  // A failed build's message is shown under the image card, inside that group.
  assert.match(
    imageGroup,
    /\{buildFailed === ""[\s\S]*?role="alert"[\s\S]*?\{buildFailed\}/,
  );
  // The details popup has no "Needs attention" block and no warnings list:
  // every group is the container editor's own, bound to the draft.
  assert.doesNotMatch(details, /templateNeedsAttention|templateWarnings/);
  assert.doesNotMatch(details, /<DetailsSection|tone="warning"/);
  assert.match(details, /title=\{t\("containerSecretsTitle"\)\}/);
  assert.doesNotMatch(details, /<Subsection/);
  // The destination is a segmented control in the header, above the image
  // group and the editable groups.
  assert.match(details, /SegmentedControl/);
  assert.match(details, /label=\{t\("templateDestination"\)\}/);
  const destination = details.indexOf("<SegmentedControl");
  const imageFacts = details.indexOf("<ImageFacts");
  const previewStart = details.indexOf("<div style={blockFields}>");
  assert.ok(
    destination >= 0 && imageGroupStart > destination &&
      imageFacts > imageGroupStart && previewStart > imageFacts,
    "the destination control sits above the image group and the groups",
  );
  // The old resolution machinery and "from …" hints are gone.
  assert.doesNotMatch(details, /templateUnresolvedReferences|secretMap/);
  assert.doesNotMatch(details, /projectMap|volumeMap/);
  assert.doesNotMatch(details, /MissingProjectRow|MissingSourceRow/);
  assert.doesNotMatch(details, /setCreateSecretFor|setCreateVolumeFor/);
  assert.doesNotMatch(details, /templateFromOriginal/);
  // The blocking reason is the footer's left slot, before the right-aligned
  // actions; it is announced as an alert in the harness's error colour, the
  // same one a mount error uses.
  assert.match(details, /<div style=\{footerRow\}>/);
  assert.match(
    details,
    /style=\{blockText === undefined \? footerReason : footerReasonError\}/,
  );
  assert.match(
    details,
    /role=\{blockText === undefined \? "status" : "alert"\}/,
  );
  const footerRow = details.indexOf("<div style={footerRow}>");
  const footerActions = details.indexOf("<div style={footerActions}>");
  const backAction = details.indexOf('t("templateBack")');
  const continueAction = details.indexOf('t("templateContinue")');
  assert.ok(
    footerRow >= 0 && footerActions > footerRow &&
      backAction > footerActions && continueAction > backAction,
    "the reason slot sits left of the right-aligned actions",
  );
  const neutralReason = /const footerReason: CSSProperties = \{([\s\S]*?)\};/
    .exec(modal);
  assert.ok(neutralReason !== null, "the footer has a neutral reason style");
  assert.match(neutralReason[1], /textAlign: "left"/);
  assert.doesNotMatch(neutralReason[1], /state-error/);
  assert.match(
    modal,
    /const footerReasonError[\s\S]*?--dsw-alias-state-error-primary/,
  );
  // Create states where the name comes from and evaluates none of it here.
  assert.match(details, /t\("templateCreateHint"\)/);
  assert.match(details, /t\("templateCreateDefaultHint"\)/);
  assert.doesNotMatch(
    details,
    /templateCreateTarget|templateNameTaken|templateNameReserved/,
  );
  assert.match(details, /containers\.length === 0 \? "default" : ""/);
  // Replace is an accessible single-select group of the picker's outlined rows:
  // one row per container with its name over its image id, no native radio or
  // fieldset, the first preselected, in a bounded scrolling area, and a filter
  // only once the list is longer than five.
  assert.match(details, /role="radiogroup"/);
  assert.match(details, /aria-label=\{t\("templateDestination"\)\}/);
  assert.match(details, /role="radio"/);
  assert.equal((details.match(/role="radio"/g) ?? []).length, 1);
  assert.match(details, /aria-checked=\{isSelected\}/);
  assert.match(details, /const isSelected = replaceTarget ===/);
  assert.match(
    details,
    /onClick=\{\(\) =>\s*setReplaceTarget\(container\.containerName\)\}/,
  );
  // The control is the picker's row, not a native radio inside a fieldset.
  assert.doesNotMatch(details, /<fieldset/);
  assert.doesNotMatch(details, /type="radio"/);
  assert.doesNotMatch(details, /replaceGroupName/);
  assert.doesNotMatch(details, /style=\{replaceOption\}/);
  // The row paints itself with the picker's metrics and, when chosen, the
  // business blue the Recreate action uses — never the template violet.
  assert.match(details, /style=\{replaceChoiceStyle\(isSelected\)\}/);
  const replaceStyle =
    /function replaceChoiceStyle\(selected: boolean\): CSSProperties \{([\s\S]*?)\n\}/
      .exec(modal);
  assert.ok(replaceStyle !== null, "the replace row has its own style");
  assert.match(replaceStyle[1], /choiceMetrics/);
  assert.match(replaceStyle[1], /businessAction/);
  assert.doesNotMatch(replaceStyle[1], /templateAction/);
  // The picker's check marks the selected row at its right end, and only it.
  assert.match(
    details,
    /\{isSelected\s*\? <IconCheckOutlineRegular size=\{16\} \/>\s*: null\}/,
  );
  assert.equal(
    (details.match(/IconCheckOutlineRegular/g) ?? []).length,
    1,
  );
  // The workspace's first container is preselected when the popup opens.
  assert.match(details, /containers\[0\]\?\.containerName \?\? ""/);
  assert.match(details, /container\.imageId/);
  assert.match(details, /containers\.length > 5\s*\?/);
  assert.match(details, /t\("templateFilterTargets"\)/);
  assert.match(details, /setReplaceFilter/);
  assert.match(details, /disabled=\{containers\.length === 0\}/);
  assert.match(details, /style=\{replaceList\}/);
  assert.match(modal, /maxHeight: "180px"/);
  assert.match(modal, /overflowY: "auto"/);
  // The replace target remains an outlined radio row, never a second select.
  // The popups create no container themselves: Continue hands a prefilled draft
  // to the create or edit editor, whose own Apply is what saves.
  assert.doesNotMatch(modal, /applyTemplate\(/);
  assert.doesNotMatch(
    details,
    /createWorkspace|startContainer|removeContainer|writeTemplate/,
  );
  assert.match(details, /onContinue\(\s*"replace",/);
});

test("the picker parses each listed template once", (t) => {
  const modal = clientSource("container-card-templates.tsx");
  if (modal === undefined) {
    t.skip("not a source checkout");
    return;
  }
  const pickerStart = modal.indexOf("function TemplatePickerModal");
  const detailsStart = modal.indexOf("function TemplateDetailsModal");
  assert.ok(pickerStart >= 0 && detailsStart > pickerStart);
  const picker = modal.slice(pickerStart, detailsStart);
  // One parse per listed entry, in the memo that maps names to summaries, and
  // one for the uploaded file; rendering reads the map instead of re-parsing.
  assert.equal((picker.match(/templateSpecSummary\(/g) ?? []).length, 2);
  assert.match(
    picker,
    /useMemo\(\(\) => \{[\s\S]*?templateSpecSummary\(entry\.yaml\)[\s\S]*?\}, \[entries\]\)/,
  );
  assert.match(picker, /summaries\.get\(entry\.name\)/);
});

test("a template's image facts come from its plan", () => {
  const effective = {
    kind: "template" as const,
    base: "ubuntu" as const,
    packages: ["jq"],
  };
  const imageId = templateImageIdFromDigest("web.yml", "0123456789abcdef");
  const builtAt = "2026-10-20T14:16:39Z";
  const ready = templateImagePlan(effective, imageId, [{
    imageId,
    parent: "ubuntu",
    packages: ["jq"],
    status: "built",
    builtAt,
  }]);
  // A present image is named by its template id, dated by its record, built on
  // its base and carries the effective packages as its facts. A custom
  // template's facts never read the image list.
  assert.deepEqual(templateImageFacts(ready, []), {
    imageId,
    status: "built",
    builtAt,
    source: "ubuntu",
    packages: ["jq"],
  });
  // An image that must be built reads as missing and has no build moment.
  assert.deepEqual(
    templateImageFacts(templateImagePlan(effective, imageId, []), []),
    {
      imageId,
      status: "missing",
      builtAt: "",
      source: "ubuntu",
      packages: ["jq"],
    },
  );
  // A built template that installs nothing keeps its empty array, so the popup
  // still states "No packages.".
  assert.deepEqual(
    templateImageFacts(
      templateImagePlan(
        { kind: "template", base: "alpine", packages: [] },
        imageId,
        [],
      ),
      [],
    ),
    {
      imageId,
      status: "missing",
      builtAt: "",
      source: "alpine",
      packages: [],
    },
  );
});

test("a base-only template's image facts come from the listed base", () => {
  const imageId = templateImageIdFromDigest("web.yml", "0123456789abcdef");
  const builtAt = "2026-10-20T14:16:39Z";
  const primitive = "docker.io/library/alpine:3.20";
  const baseRow = {
    imageId: "alpine",
    parent: "",
    primitive,
    packages: ["curl"],
    builtAt,
    status: "built",
    isBase: true,
    basePublic: false,
  };
  const basePlan = (status: string, date: string) =>
    templateImagePlan({ kind: "base", base: "alpine" }, imageId, [{
      imageId: "alpine",
      parent: "",
      packages: ["curl"],
      status,
      builtAt: date,
    }]);
  // A built or pulled base reads the same facts — its upstream reference and its
  // package list — from the listed base image; only the build time differs.
  for (const status of ["built", "pulled"]) {
    assert.deepEqual(
      templateImageFacts(basePlan(status, builtAt), [{
        ...baseRow,
        status,
      }]),
      {
        imageId: "alpine",
        status: "built",
        builtAt,
        source: primitive,
        packages: ["curl"],
      },
    );
  }
  // A missing base keeps the same parent and packages lines, and differs only
  // in its chip and absent build time.
  assert.deepEqual(
    templateImageFacts(basePlan("missing", ""), [{
      ...baseRow,
      status: "missing",
      builtAt: "",
    }]),
    {
      imageId: "alpine",
      status: "missing",
      builtAt: "",
      source: primitive,
      packages: ["curl"],
    },
  );
  // With no base row in the list both lines stay hidden, as before.
  assert.deepEqual(
    templateImageFacts(basePlan("missing", ""), []),
    {
      imageId: "alpine",
      status: "missing",
      builtAt: "",
      source: "",
      packages: undefined,
    },
  );
});

test("Create and Replace open a prefilled editor and save nothing themselves", (t) => {
  const modal = clientSource("container-card-templates.tsx");
  const workspace = clientSource("container-card-workspace.tsx");
  if (modal === undefined || workspace === undefined) {
    t.skip("not a source checkout");
    return;
  }
  // Continue opens the create editor for a new container and the chosen
  // container's edit editor for a replace; there is no direct apply here.
  assert.match(modal, /onContinue\(\s*"create",/);
  assert.match(modal, /onContinue\(\s*"replace",/);
  assert.doesNotMatch(modal, /applyTemplate\(/);
  // The workspace opens the prefilled editor, and only publishes a replace's
  // template ports after its Apply succeeded.
  assert.match(workspace, /setCreatePrefill\(\{/);
  assert.match(workspace, /setEditPrefill\(\{/);
  assert.match(
    workspace,
    /const applied = await onApplyContainerConfig[\s\S]*templateActions\.publishTemplate/,
  );
});

test("the workspace hands forcedProject only to the default container", (t) => {
  const modal = clientSource("container-card-create-modal.tsx");
  const workspace = clientSource("container-card-workspace.tsx");
  if (modal === undefined || workspace === undefined) {
    t.skip("not a source checkout");
    return;
  }
  // The create draft applies the forcing helper only for the default container;
  // a named draft keeps the mounts it was given.
  assert.match(
    modal,
    /createDialogConfig\(base, named, workspace\.projectName\)/,
  );
  // The default create still locks its workspace project row, and a named one
  // locks nothing unless the caller says so.
  assert.match(
    modal,
    /primaryProject=\{named \? \(forcedProject \?\? ""\) : workspace\.projectName\}/,
  );
  // A template prefill opens the default editor when the workspace is empty and
  // the named editor otherwise, so forcedProject follows the target, not the
  // prefill: only the unnamed create passes it.
  assert.match(
    workspace,
    /forcedProject=\{createOpen === "default"[\s\S]*?workspace\.projectName/,
  );
  // A replace locks only when its target is the default container; a named
  // replace from a template makes the workspace mount editable and removable
  // (and the template declares it only if it should exist at all).
  assert.match(
    workspace,
    /editPrefill\.container === container\.containerName &&\s*container\.containerName === "default"/,
  );
});

test("a template image missing from the list read now needs a build", () => {
  const template = parseContainerTemplate(`version: 1
kind: dsh-podman/container-template
spec:
  imageTemplate: {base: alpine, packages: [neovim]}
`);
  const effective = effectiveImage(template);
  const imageId = templateImageIdFromDigest("web.yml", "0123456789abcdef");
  // The snapshot the card loaded while the image existed still lists it.
  const staleSnapshot = [{
    imageId,
    parent: "alpine",
    packages: ["neovim"],
  }];
  assert.equal(
    templateImagePlan(effective, imageId, staleSnapshot).needsBuild,
    false,
  );
  // The list read when the popup opens no longer has it, so the same plan is
  // "needs building" rather than "ready".
  const fresh = templateImagePlan(effective, imageId, []);
  assert.equal(fresh.needsBuild, true);
  assert.equal(fresh.reason, "missing");
});

test("the image card switches facts with the draft's image", () => {
  const effective = {
    kind: "template" as const,
    base: "ubuntu" as const,
    packages: ["jq"],
  };
  const imageId = templateImageIdFromDigest("web.yml", "0123456789abcdef");
  const builtAt = "2026-10-20T14:16:39Z";
  const plan = templateImagePlan(effective, imageId, [{
    imageId,
    parent: "ubuntu",
    packages: ["jq"],
    status: "built",
    builtAt,
  }]);
  const images = [{
    imageId: "ubuntu",
    parent: "",
    primitive: "docker.io/library/ubuntu:24.04",
    packages: [],
    builtAt: "",
    status: "pulled",
    isBase: true,
    basePublic: true,
  }];
  // The template's derived id describes the plan the popup inspected.
  assert.deepEqual(
    templateDraftImageFacts(plan, imageId, images),
    templateImageFacts(plan, images),
  );
  // Another listed image is described by the workspace's own list entry, using
  // its primitive when it names no parent.
  assert.deepEqual(templateDraftImageFacts(plan, "ubuntu", images), {
    imageId: "ubuntu",
    status: "pulled",
    builtAt: "",
    source: "docker.io/library/ubuntu:24.04",
    packages: [],
  });
  // An id the list no longer holds is missing, and the card states no
  // packages it does not know.
  assert.deepEqual(templateDraftImageFacts(plan, "gone", images), {
    imageId: "gone",
    status: "missing",
    builtAt: "",
    source: "",
    packages: undefined,
  });
});

test("the details popup plans from a fresh inspection, never the snapshot", (t) => {
  const modal = clientSource("container-card-templates.tsx");
  const workspace = clientSource("container-card-workspace.tsx");
  if (modal === undefined || workspace === undefined) {
    t.skip("not a source checkout");
    return;
  }
  const detailsStart = modal.indexOf("function TemplateDetailsModal");
  const wrapperStart = modal.indexOf("export function LoadTemplateModal");
  assert.ok(
    detailsStart >= 0 && wrapperStart > detailsStart,
    "the details popup and the picker are separate components",
  );
  const details = modal.slice(detailsStart, wrapperStart);
  const wrapper = modal.slice(wrapperStart);
  // The template's own plan still comes from the host route, which reads the
  // image list when it runs; the workspace's image list only feeds the picker
  // and the facts of another image the draft chooses.
  assert.match(details, /inspectTemplate/);
  assert.equal((details.match(/inspectTemplate\(/g) ?? []).length, 2);
  assert.match(
    details,
    /templateDraftImageFacts\(inspection\.image, draft\.image, images\)/,
  );
  // The wrapper takes the workspace's images, and the workspace hands them in.
  assert.match(wrapper, /images: readonly ImageView\[\]/);
  const open = workspace.indexOf("<LoadTemplateModal");
  assert.ok(open >= 0, "the workspace renders the load-template popup");
  const close = workspace.indexOf("/>", open);
  assert.match(workspace.slice(open, close), /images=\{images\}/);
  // A build is followed by a re-read of the plan, so a failed build or an image
  // removed during it cannot leave a cached "ready" state on screen.
  assert.match(details, /recheckAfterBuild/);
});

test("the image card dispatches each action's own command", (t) => {
  const modal = clientSource("container-card-templates.tsx");
  if (modal === undefined) {
    t.skip("not a source checkout");
    return;
  }
  const detailsStart = modal.indexOf("function TemplateDetailsModal");
  const wrapperStart = modal.indexOf("export function LoadTemplateModal");
  assert.ok(detailsStart >= 0 && wrapperStart > detailsStart);
  const details = modal.slice(detailsStart, wrapperStart);
  const dispatchStart = details.indexOf("const runImageAction");
  const dispatchEnd = details.indexOf("const checkProjects");
  assert.ok(
    dispatchStart >= 0 && dispatchEnd > dispatchStart,
    "the card has one dispatch function",
  );
  const dispatch = details.slice(dispatchStart, dispatchEnd);
  // The card has one button and it runs the decision the helper returned.
  assert.match(details, /onClick=\{\(\) => runImageAction\(imageAction\)\}/);
  assert.equal(
    (details.match(/onClick=\{\(\) => runImageAction\(/g) ?? []).length,
    1,
  );
  // The template's own Build and Rebuild keep the template route, and only
  // Rebuild forces it: the build call carries `force` only when asked.
  assert.match(dispatch, /case "template-build":\s*void build\(false\);/);
  assert.match(dispatch, /case "template-rebuild":\s*void build\(true\);/);
  assert.match(details, /\.\.\.\(force \? \{ force: true \} : \{\}\)/);
  // Every other action runs the exact command the Images tab's row runs,
  // including the custom build from the record's own parent and packages.
  assert.match(dispatch, /case "custom-build": \{/);
  assert.match(
    dispatch,
    /onBuildImage\(image\.imageId, image\.parent, \[\.\.\.image\.packages\]\);/,
  );
  assert.match(dispatch, /case "custom-rebuild":\s*onRebuildImage\(imageId\);/);
  assert.match(
    dispatch,
    /case "base-build":\s*case "base-rebuild":\s*onRebuildBaseImage\(imageId\);/,
  );
  assert.match(dispatch, /case "base-pull":\s*onPullBaseImage\(imageId\);/);
  // The template cases return to the template route's own re-inspect; every
  // other command falls through to the popup's onReload so the card follows the
  // snapshot the command leaves behind.
  assert.match(
    dispatch,
    /case "template-build":\s*void build\(false\);\s*return;/,
  );
  assert.match(
    dispatch,
    /case "template-rebuild":\s*void build\(true\);\s*return;/,
  );
  assert.match(dispatch, /case "none":\s*return;/);
  const reload = dispatch.indexOf("onReload();");
  assert.ok(reload >= 0, "a non-template command reloads the card");
  for (
    const callback of [
      "onBuildImage(",
      "onRebuildImage(",
      "onRebuildBaseImage(",
      "onPullBaseImage(",
    ]
  ) {
    const call = dispatch.indexOf(callback);
    assert.ok(call >= 0 && call < reload, `${callback} precedes onReload`);
  }
  // The button is disabled while busy and in a read-only session.
  assert.match(details, /const imageActionRunning = busy \|\|/);
  assert.match(details, /const imageActionDisabled = !writable \|\|/);
  assert.match(details, /aria-busy=\{imageActionRunning\}/);
  assert.match(details, /disabled=\{imageActionDisabled\}/);
  // The action's label follows it, not the command that dispatches it: Build,
  // Rebuild and Pull come from the Images tab's own labels for every selected
  // image, and a running build or rebuild uses the shared short progress words.
  assert.match(details, /t\("build"\)/);
  assert.match(details, /t\("rebuildImage"\)/);
  assert.match(details, /t\("pullImage"\)/);
  assert.match(details, /t\("building"\)/);
  assert.match(details, /t\("rebuilding"\)/);
  assert.doesNotMatch(details, /imageAction\.command/);
  assert.match(details, /t\("busy"\)/);
});

test("the image card labels every route the same", (t) => {
  const modal = clientSource("container-card-templates.tsx");
  if (modal === undefined) {
    t.skip("not a source checkout");
    return;
  }
  const detailsStart = modal.indexOf("function TemplateDetailsModal");
  const wrapperStart = modal.indexOf("export function LoadTemplateModal");
  assert.ok(
    detailsStart >= 0 && wrapperStart > detailsStart,
    "the details popup is its own component",
  );
  const details = modal.slice(detailsStart, wrapperStart);
  const labelStart = details.indexOf("const imageActionRunningLabel");
  const labelEnd = details.indexOf("// Everything the editors'", labelStart);
  assert.ok(
    labelStart >= 0 && labelEnd > labelStart,
    "the image label block is its own literal",
  );
  const label = details.slice(labelStart, labelEnd);
  // The template's own image and another selected image dispatch different
  // commands but read the same labels: the action alone decides the wording.
  assert.match(label, /t\("build"\)/);
  assert.match(label, /t\("rebuildImage"\)/);
  assert.match(label, /t\("pullImage"\)/);
  assert.match(label, /t\("building"\)/);
  assert.match(label, /t\("rebuilding"\)/);
  assert.doesNotMatch(label, /command|template/i);
  // A running Build and a running Rebuild use the shared short words in both
  // languages, and the template-only wording is gone.
  assert.equal(en.building, "Building");
  assert.equal(en.rebuilding, "Rebuilding");
  assert.equal(zh.building, "构建中");
  assert.equal(zh.rebuilding, "重建中");
  for (
    const key of [
      "templateBuild",
      "templateRebuild",
      "templateBuilding",
      "templateRebuilding",
    ]
  ) {
    assert.ok(!(key in en), `en has no ${key}`);
    assert.ok(!(key in zh), `zh has no ${key}`);
  }
});

test("both template popups pin a scrolling body inside a capped dialog", (t) => {
  const modal = clientSource("container-card-templates.tsx");
  if (modal === undefined) {
    t.skip("not a source checkout");
    return;
  }
  const pickerStart = modal.indexOf("function TemplatePickerModal");
  const detailsStart = modal.indexOf("function TemplateDetailsModal");
  const wrapperStart = modal.indexOf("export function LoadTemplateModal");
  assert.ok(
    pickerStart >= 0 && detailsStart > pickerStart &&
      wrapperStart > detailsStart,
    "the picker and the details popup are separate components",
  );
  for (
    const popup of [
      modal.slice(pickerStart, detailsStart),
      modal.slice(detailsStart, wrapperStart),
    ]
  ) {
    // Both popups carry the template dialog pair, not the width-only compact
    // class: the pair is what caps the height and keeps the header and the
    // footer out of the scrolling region.
    assert.match(popup, /className=\{TEMPLATE_DIALOG_CLASS\}/);
    assert.match(popup, /contentClassName=\{TEMPLATE_DIALOG_CONTENT_CLASS\}/);
    assert.doesNotMatch(popup, /COMPACT_DIALOG_CLASS/);
  }
  assert.equal(TEMPLATE_DIALOG_CLASS, "dsh-podman-template-dialog");
  assert.equal(
    TEMPLATE_DIALOG_CONTENT_CLASS,
    "dsh-podman-template-dialog-content",
  );
  // The definitions: the dialog is capped to the viewport, a little narrower
  // than the editor, and the content's body — its last element, between the
  // pinned header and the footer — is the one region that scrolls.
  const rule = (selector: string): string => {
    const match = new RegExp(
      `${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`,
    ).exec(CONTAINER_DIALOG_STYLES);
    if (match === null) assert.fail(`the stylesheet defines ${selector}`);
    return match[1];
  };
  const dialog = rule(`.${TEMPLATE_DIALOG_CLASS}.${TEMPLATE_DIALOG_CLASS}`);
  assert.match(dialog, /max-height:\s*min\(85vh, 100%\)/);
  assert.match(dialog, /width:\s*min\(900px, 92vw\)/);
  const content = rule(
    `.${TEMPLATE_DIALOG_CONTENT_CLASS}.${TEMPLATE_DIALOG_CONTENT_CLASS}`,
  );
  assert.match(content, /flex-direction:\s*column/);
  assert.match(content, /min-height:\s*0/);
  const body = rule(
    `.${TEMPLATE_DIALOG_CONTENT_CLASS} > div:last-child`,
  );
  assert.match(body, /min-height:\s*0/);
  assert.match(body, /overflow-y:\s*auto/);
});
