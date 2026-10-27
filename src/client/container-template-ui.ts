// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// The load-template popup's decisions, kept out of the React component so they
// can be tested: the editor draft a template prefills, which image action the
// card offers, and whether the Create action is currently allowed.

import {
  type ContainerTemplate,
  type EffectiveImage,
  effectiveImage,
  parseContainerTemplate,
  type TemplateImagePlan,
  type TemplateMount,
  type TemplateMountInput,
  templateMountInputs,
  type TemplatePort,
} from "../container-template.js";
import type { TemplateInspectionView } from "./template-protocol.js";
import type { Translate } from "./locales.js";
import { buildParentImages, isPtcImage } from "./container-card-ptc.js";
import { mergeDefaultEnv } from "../container-env.js";
import { orderedEnvRecord } from "../env-rows.js";
import {
  decideProjectPath,
  hostPathForProjectName,
  type ProjectPathDecision,
  type ProjectPathRejection,
} from "../project-path.js";

// The draft shape the editor's ContainerConfig accepts. It is declared here
// rather than imported from the editor module so this file stays free of React
// imports and can be tested from the host build.
export interface TemplateEditorPort {
  port: number;
  protocol: string;
  endpoint: string;
  suggestedHostPort: number;
  hostPort: number;
}

export interface TemplateEditorConfig {
  image: string;
  env: Record<string, string>;
  mounts: TemplateMountInput[];
  paths: string[];
  secretEnv: Record<string, string>;
  ports: TemplateEditorPort[];
}

// The current container a replace starts from. It mirrors the editor draft's
// field groups without importing the client module that owns their type.
export interface TemplateCurrentConfig {
  env: Record<string, string>;
  mounts: readonly TemplateMountInput[];
  paths: readonly string[];
  secretEnv: Record<string, string>;
  ports: readonly TemplateEditorPort[];
}

// The template document a replace handed to the edit editor, so the host can
// publish the template's ports once the editor's Apply succeeded.
export interface TemplateSource {
  name: string;
  yaml: string;
}

// The facts the details popup hands ImageFacts for a template's image. The
// name is the effective image id a container will run; the status uses the
// image tab's own wording, where an image that must be built is missing; the
// build time comes from the plan's listed record, so the popup needs no second
// image-list lookup; the parent is the base a built image is layered on, while
// a base-only template names its base's upstream reference; the packages are
// the effective extras, or the base's own list for a base-only template.
export interface TemplateImageFacts {
  imageId: string;
  status: string;
  builtAt: string;
  source: string;
  // A base-only template takes its package list from the listed base image, so
  // a base with no row in the list leaves the field out entirely; a built image
  // keeps its list, empty or not.
  packages: readonly string[] | undefined;
}

// templateImageFacts describes the template's own image. A base-only template
// runs the base itself, so its card states the base's upstream reference and
// packages, read from the listed base image: built, pulled and missing bases
// then differ only in their status chip and build time. A custom template names
// its base as the parent and carries its effective extras. A base row the list
// does not hold leaves both lines hidden, since the plan alone does not know
// them.
export function templateImageFacts(
  plan: TemplateImagePlan,
  images: readonly TemplateImageCandidate[],
): TemplateImageFacts {
  const effective = plan.effective;
  const status = plan.needsBuild ? "missing" : "built";
  if (effective.kind === "template") {
    return {
      imageId: plan.imageId,
      status,
      builtAt: plan.builtAt,
      source: effective.base,
      packages: effective.packages,
    };
  }
  const base = images.find((image) => image.imageId === effective.base);
  return {
    imageId: plan.imageId,
    status,
    builtAt: plan.builtAt,
    source: base?.primitive ?? "",
    packages: base?.packages,
  };
}

// The facts one image in the workspace's list carries, for the popup's card
// while the draft runs an image other than the template's own. The list names
// the image, its status, its build moment, the image it descends from (a custom
// image's parent, or a base image's primitive) and the packages it holds. It
// also says whether the image is a base image and whether a base is pulled from
// a public registry, which is what decides the action the card offers for it.
export interface TemplateImageCandidate {
  imageId: string;
  parent: string;
  primitive: string;
  packages: readonly string[];
  builtAt: string;
  status: string;
  isBase: boolean;
  basePublic: boolean;
}

// One image the details popup's picker may offer: the id a container names and
// whether the snapshot lists it as a base image, which decides its place in the
// candidate order.
export interface TemplateImageChoice {
  imageId: string;
  isBase: boolean;
}

// templateOwnImageId is the id the template's own image is offered and matched
// under: a custom template's derived id, or the effective base of a base-only
// one.
function templateOwnImageId(
  plan: TemplateImagePlan | null,
): string | undefined {
  if (plan === null) return undefined;
  return plan.effective?.kind === "base" ? plan.effective.base : plan.imageId;
}

// isTemplateImage reports whether a draft image is the template's own: the
// plan's image id, or a base-only plan's effective base. Both normally name the
// same image, but an inspection can carry one while the plan carries the other.
function isTemplateImage(
  plan: TemplateImagePlan,
  draftImage: string,
): boolean {
  return draftImage === plan.imageId ||
    (plan.effective?.kind === "base" && draftImage === plan.effective.base);
}

// compareImageIds orders two image ids case-insensitively. It returns 0 for ids
// that differ only by case, and the stable sort keeps the workspace's order for
// them.
function compareImageIds(left: string, right: string): number {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

// templateImageCandidates lists the image ids the details popup's picker
// offers: the template's own image first, then the other base images, then the
// other custom images, each group sorted by image id, without duplicates or
// empty ids. The template's own image is the plan's derived id, or a base-only
// plan's effective base, whether or not the workspace list holds it: a custom
// template's derived image only joins the list once it is built, so it is added
// here rather than lost: after the draft switches to another image, the picker
// must still be able to return to it. A listed own image is not repeated in its
// group. The reserved PTC image is never offered, as in the container editor.
export function templateImageCandidates(
  plan: TemplateImagePlan | null,
  images: readonly TemplateImageChoice[],
): string[] {
  const offered = buildParentImages(images);
  const own = templateOwnImageId(plan);
  const others = offered.filter((image) =>
    image.imageId !== "" && image.imageId !== own
  );
  const bases = others.filter((image) => image.isBase)
    .map((image) => image.imageId)
    .sort(compareImageIds);
  const custom = others.filter((image) => !image.isBase)
    .map((image) => image.imageId)
    .sort(compareImageIds);
  const first = own === undefined || own === "" ? [] : [own];
  return [...new Set([...first, ...bases, ...custom])];
}

// templateDraftImageFacts is the image card's answer for the draft's image. The
// template's own image describes the plan (including a build the card can run
// here); any other listed image is described from the workspace's image list;
// an id the list no longer holds is missing, and the card offers no build for
// it because this popup only builds the template's image.
export function templateDraftImageFacts(
  plan: TemplateImagePlan,
  draftImage: string,
  images: readonly TemplateImageCandidate[],
): TemplateImageFacts {
  if (isTemplateImage(plan, draftImage)) {
    return templateImageFacts(plan, images);
  }
  const image = images.find((candidate) => candidate.imageId === draftImage);
  if (image === undefined) {
    return {
      imageId: draftImage,
      status: "missing",
      builtAt: "",
      source: "",
      packages: undefined,
    };
  }
  return {
    imageId: image.imageId,
    status: image.status,
    builtAt: image.builtAt,
    source: image.parent !== "" ? image.parent : image.primitive,
    packages: image.packages,
  };
}

// templateDisplayName is the name a template is listed under: its file name
// without the YAML suffix. The full file name stays available as muted secondary
// text (the details header) or the picker row's file-name tooltip, so the row is
// led by the template rather than by the file it happens to live in; the tooltip
// never carries facts, which the row shows in full.
export function templateDisplayName(fileName: string): string {
  const name = fileName.replace(/\.(?:ya?ml)$/i, "").trim();
  return name === "" ? fileName : name;
}

// The facts a picker row states after what the template runs on. Each is the
// list of identities the row may name: environment variables, mount sources,
// PATH additions, published ports and required secrets. They describe the same
// facts the details popup's sections lay out, so a row never claims a mount or
// port the popup would not show. A secret environment variable's name is not
// repeated here: its secret is what the row's secrets fact names.
export interface TemplateSpecFacts {
  envNames: string[];
  // A project, volume or secret mount is named by its source; tmpfs has no
  // source, so it is named by the destination it is the only identity of.
  mounts: string[];
  paths: string[];
  // The value the row shows per port: "8080", or "8080→80" when a host port
  // differs.
  ports: string[];
  secrets: string[];
}

// The parsed description of one template file: a valid document names its
// effective image, the packages it installs and the facts above; an invalid one
// carries the parser's reason the picker shows in full instead of a guessed
// summary.
export type TemplateSpecSummary =
  | ({
    valid: true;
    image: EffectiveImage;
    packages: number;
  } & TemplateSpecFacts)
  | { valid: false; reason: string };

// invalidTemplateReason is the parser's message, trimmed. The parser's message
// is the one thing the user can act on, so every line is kept and nothing is
// shortened: the picker's error block wraps to the lines the reason needs.
export function invalidTemplateReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim();
}

// templateSecretNames lists every secret a template requires, in first-use
// order: the secret an environment variable names, then the secrets its mounts
// name. The picker counts these and the details popup marks them, so both agree
// on what "one secret" means.
export function templateSecretNames(
  template: ContainerTemplate,
): string[] {
  const names: string[] = [];
  const add = (name: string): void => {
    if (name !== "" && !names.includes(name)) names.push(name);
  };
  for (const secret of Object.values(template.spec.secretEnv)) add(secret);
  for (const mount of template.spec.mounts) {
    if (mount.kind === "secret") add(mount.secret);
  }
  return names;
}

// templateEnvNames lists the plain environment variables a template sets, in
// the template's own order. Secret environment variables are described by the
// secret they name, which the row states in its secrets fact instead.
export function templateEnvNames(template: ContainerTemplate): string[] {
  return Object.keys(template.spec.env);
}

// templateMountSource is the identity a picker row names for one mount. A
// project, volume or secret mount is named by its source; tmpfs has no source,
// so its destination is the only identity it carries. The kind itself is never
// shown.
export function templateMountSource(mount: TemplateMount): string {
  switch (mount.kind) {
    case "project":
      return mount.project;
    case "volume":
      return mount.volume;
    case "secret":
      return mount.secret;
    case "tmpfs":
      return mount.destination;
  }
}

// templatePortRowValue is what a picker row shows for one port: the container
// port alone, or "container→host" when a host port differs from it.
export function templatePortRowValue(port: TemplatePort): string {
  return port.host !== undefined && port.host !== port.container
    ? `${port.container}→${port.host}`
    : String(port.container);
}

// templateSpecSummary parses one template file locally and describes what it
// does. The picker reads its row from this parsed spec, never from the file name
// or a second parse guess; a document that does not parse is reported as invalid
// with the parser's reason.
export function templateSpecSummary(yaml: string): TemplateSpecSummary {
  try {
    const template = parseContainerTemplate(yaml);
    const image = effectiveImage(template);
    return {
      valid: true,
      image,
      packages: image.kind === "template" ? image.packages.length : 0,
      envNames: templateEnvNames(template),
      mounts: template.spec.mounts.map(templateMountSource),
      paths: [...template.spec.paths],
      ports: template.spec.ports.map(templatePortRowValue),
      secrets: templateSecretNames(template),
    };
  } catch (error) {
    return { valid: false, reason: invalidTemplateReason(error) };
  }
}

// templateChoiceActionable reports whether the picker's Next may open the
// details: the chosen file's summary must have parsed, and the command must be
// idle. A missing summary is not actionable either, so a selection the picker
// could not describe never continues.
export function templateChoiceActionable(
  summary: TemplateSpecSummary | undefined,
  busy: boolean,
): boolean {
  return !busy && summary !== undefined && summary.valid;
}

// One segment of a picker row's fact line. The image is the unprefixed subject;
// every other segment is a category, labelled and omitted when it holds
// nothing.
export interface TemplateSummarySegment {
  // The translated label, or "" for the image subject.
  label: string;
  // The values to list in full. Empty when the segment collapses to a count.
  values: string[];
  // The number of values when there are too many to name, which the row shows
  // as a bare count instead.
  count?: number;
}

// Two values are still readable beside their label; a third is what turns the
// segment into a count, which is why the break point is exactly here.
const NAMED_FACT_LIMIT = 2;

// Ports are the one category with a lower limit: a single mapping is a fact the
// row can state, but two full mappings read as noise beside the categories that
// name their subjects, so ports collapse from the second.
const NAMED_PORT_LIMIT = 1;

function summarySegment(
  label: string,
  values: readonly string[],
  limit = NAMED_FACT_LIMIT,
): TemplateSummarySegment | undefined {
  if (values.length === 0) return undefined;
  return values.length <= limit
    ? { label, values: [...values] }
    : { label, values: [], count: values.length };
}

// templateSummarySegments renders one picker row's facts as labelled segments,
// in the row's fixed order: the image alone first, then environment, mounts,
// secrets, PATH additions and ports. A category with no entries is omitted, and
// a category past its naming limit keeps only its count (ports from the second,
// every other category from the third). The labels are the only copy the row
// needs: a collapsed category already names its unit, so its count is the bare
// number rather than a second cardinal phrase.
export function templateSummarySegments(
  t: Translate,
  summary: TemplateSpecSummary,
): TemplateSummarySegment[] {
  if (!summary.valid) return [];
  const image = summary.image.kind === "base"
    ? summary.image.base
    : `${summary.image.base} +${summary.packages} ${
      t(
        summary.packages === 1
          ? "templateFactPackageOne"
          : "templateFactPackageMany",
      )
    }`;
  const segments: TemplateSummarySegment[] = [{ label: "", values: [image] }];
  const append = (
    label: string,
    values: readonly string[],
    limit?: number,
  ): void => {
    const segment = summarySegment(label, values, limit);
    if (segment !== undefined) segments.push(segment);
  };
  append(t("templateFactEnv"), summary.envNames);
  append(t("templateFactMounts"), summary.mounts);
  append(t("templateFactSecrets"), summary.secrets);
  append(t("templateFactPath"), summary.paths);
  append(t("templateFactPorts"), summary.ports, NAMED_PORT_LIMIT);
  return segments;
}

// templateSummarySegmentValue is the value half of one segment: the listed
// values in full, or the bare count that replaced them.
export function templateSummarySegmentValue(
  segment: TemplateSummarySegment,
): string {
  return segment.count === undefined
    ? segment.values.join(", ")
    : String(segment.count);
}

// templateSummarySegmentText is one segment as the user reads it: the image
// unprefixed, every other segment as "label: value".
export function templateSummarySegmentText(
  segment: TemplateSummarySegment,
): string {
  const value = templateSummarySegmentValue(segment);
  return segment.label === "" ? value : `${segment.label}: ${value}`;
}

// templateSummaryLineText joins a row's segments with the separator the picker
// paints, so the visible line and the accessible label are the same text.
export function templateSummaryLineText(
  segments: readonly TemplateSummarySegment[],
): string {
  return segments.map(templateSummarySegmentText).join(" · ");
}

// templateSummaryAccessibleLabel is the row's accessible name: the display name
// the row is led by, then the same complete summary text the eye reads, or the
// invalid file's reason in place of facts. It never reduces the row to its name
// alone.
export function templateSummaryAccessibleLabel(
  t: Translate,
  name: string,
  summary: TemplateSpecSummary | undefined,
): string {
  if (summary === undefined) return name;
  if (!summary.valid) return `${name} · ${summary.reason}`;
  return [name, templateSummaryLineText(templateSummarySegments(t, summary))]
    .join(" · ");
}

// The kind and name one reference in the draft names. A secret is one
// reference whether it is attached to a variable or mounted, and the same name
// can be used by several rows, so the popup counts and reports each reference
// once.
export interface TemplateDraftReference {
  kind: "project" | "secret" | "volume";
  name: string;
  // The mount's index in the draft when the reference comes from a mount.
  mountIndex?: number;
  // The environment variable naming the secret when it comes from secretEnv.
  env?: string;
}

// templateDraftReferences lists every reference the draft carries, in the order
// the editors list it: secret environment values first, then each mount's own
// source. A row that names nothing is listed too — an emptied project path, a
// mount whose source was cleared, a secret variable left without a secret —
// because such a row still reaches the editor and would be refused there; it is
// simply missing from the workspace's names.
export function templateDraftReferences(
  draft: TemplateEditorConfig,
): TemplateDraftReference[] {
  const references: TemplateDraftReference[] = [];
  for (const [env, secret] of Object.entries(draft.secretEnv)) {
    references.push({ kind: "secret", name: secret, env });
  }
  draft.mounts.forEach((mount, index) => {
    switch (mount.kind) {
      case "project":
        references.push({
          kind: "project",
          name: mount.project,
          mountIndex: index,
        });
        break;
      case "volume":
        references.push({
          kind: "volume",
          name: mount.volume,
          mountIndex: index,
        });
        break;
      case "secret":
        references.push({
          kind: "secret",
          name: mount.secret,
          mountIndex: index,
        });
        break;
    }
  });
  return references;
}

// The names a configuration's references may point at: the workspace's secrets,
// its volumes, and the project paths the host check accepted. A pending project
// check is not one of the accepted paths yet, so its reference counts as
// outstanding: the footer's number stays put while the check reruns and changes
// only when the check resolves.
export interface TemplateDraftKnown {
  secrets: readonly { name: string }[];
  volumes: readonly { name: string }[];
  projects: readonly string[];
}

// templateDraftMissingReferences is the references the draft names that the
// workspace no longer holds, once per kind and name. The popup marks their
// rows and counts them in the footer; the editor's own Apply is still the only
// write, so Continue waits until nothing is left unresolved.
export function templateDraftMissingReferences(
  references: readonly TemplateDraftReference[],
  known: TemplateDraftKnown,
): TemplateDraftReference[] {
  const secretNames = new Set(known.secrets.map((secret) => secret.name));
  const volumeNames = new Set(known.volumes.map((volume) => volume.name));
  const projectNames = new Set(known.projects);
  const missing: TemplateDraftReference[] = [];
  const seen = new Set<string>();
  for (const reference of references) {
    const knownHere = reference.kind === "secret"
      ? secretNames.has(reference.name)
      : reference.kind === "volume"
      ? volumeNames.has(reference.name)
      : projectNames.has(reference.name);
    if (knownHere) continue;
    const key = `${reference.kind}:${reference.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    missing.push(reference);
  }
  return missing;
}

// templateProjectPathDecision validates a typed project reference the way the
// mount editor does: lexical shape first, then the host's directory listing of
// the path under the projects root. The listing is injected so this decision is
// testable without a host; a deployment without a picker keeps the lexical
// answer, exactly as the mount editor does.
export async function templateProjectPathDecision(options: {
  project: string;
  projectsRoot: string;
  listDirectory?: (path: string) => Promise<unknown>;
}): Promise<ProjectPathDecision> {
  const lexical = decideProjectPath({
    origin: "typed",
    project: options.project,
    directoryExists: true,
  });
  if (!lexical.ok || options.listDirectory === undefined) return lexical;
  let directoryExists = true;
  try {
    await options.listDirectory(
      hostPathForProjectName(options.projectsRoot, lexical.project),
    );
  } catch {
    directoryExists = false;
  }
  return decideProjectPath({
    origin: "typed",
    project: options.project,
    directoryExists,
  });
}

// templateProjectPathError is the popup's wording for a refused project
// reference. Unlike the mount editor's keys it names the offending value in
// every message, and it distinguishes an empty field — a choice still to make —
// from a path the host refused. The lexical and host failures stay separate
// mistakes with separate wording.
export function templateProjectPathError(
  t: Translate,
  project: string,
  reason: ProjectPathRejection,
): string {
  if (reason === "empty") return t("templateChooseProject");
  return t(
    reason === "missing" ? "templateProjectMissing" : "templateProjectInvalid",
    { project },
  );
}

// The state one project path check is in while the popup edits a draft. It is
// keyed by the mount's index and remembers the value it checked, so a result
// that belongs to another value is never mistaken for the current row's.
export type TemplateProjectCheck =
  | { state: "pending"; project: string }
  | { state: "ok"; project: string }
  | { state: "error"; project: string; error: string };

// templateProjectChecksEqual reports whether two check maps say the same thing.
// The popup writes a check map only when this is false, so a re-check that
// reaches the same answer causes no render at all — in particular while typing,
// when no host call is made and the stored answer stands.
export function templateProjectChecksEqual(
  left: Readonly<Record<number, TemplateProjectCheck>>,
  right: Readonly<Record<number, TemplateProjectCheck>>,
): boolean {
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  for (const key of keys) {
    const a = left[Number(key)];
    const b = right[Number(key)];
    if (b === undefined) return false;
    if (a.state !== b.state || a.project !== b.project) return false;
    if (
      a.state === "error" && b.state === "error" && a.error !== b.error
    ) {
      return false;
    }
  }
  return true;
}

// templateConfigForEditor is the draft the details popup seeds and Continue
// hands to the create or edit editor. The mounts are exactly the ones the
// template writes, in its order; nothing is synthesised for a template that
// omits the workspace's project mount. The environment is the same one a
// hand-created container opens on: the workspace's default environment (the
// create dialog's own merge), then, for a replace, the container's current
// values, then the template's own — each later layer wins key by key, so a
// template never loses a default it does not mention and an export/edit round
// trip reproduces the container's environment. The draft is ordered the way the
// editor lists it, and it is exactly what Apply sends. A new container stages
// the template's ports for the create to publish; a replace keeps the
// container's current ports instead because the host publishes the template's
// after the editor's own Apply, and the template's image and every other field
// it defines replace the current ones while the fields it omits are shown as
// they currently are.
export function templateConfigForEditor(
  template: ContainerTemplate,
  imageId: string,
  options: {
    defaultEnv?: Record<string, string>;
    // The chosen container's configuration, for a replace.
    current?: TemplateCurrentConfig;
  } = {},
): TemplateEditorConfig {
  const current = options.current;
  // The layers are applied in precedence order: defaults first, then a
  // replace's current values, then the template's own entries.
  const env = orderedEnvRecord(
    mergeDefaultEnv(
      options.defaultEnv,
      current === undefined
        ? template.spec.env
        : { ...current.env, ...template.spec.env },
    ),
  );
  if (current === undefined) {
    return {
      image: imageId,
      env,
      mounts: templateMountInputs(template),
      paths: [...template.spec.paths],
      secretEnv: { ...template.spec.secretEnv },
      ports: template.spec.ports.map((port) => ({
        port: port.container,
        protocol: "tcp",
        endpoint: "",
        suggestedHostPort: port.host ?? 0,
        hostPort: 0,
      })),
    };
  }
  return {
    image: imageId,
    env,
    mounts: template.spec.mounts.length > 0
      ? templateMountInputs(template)
      : [...current.mounts],
    paths: template.spec.paths.length > 0
      ? [...template.spec.paths]
      : [...current.paths],
    secretEnv: Object.keys(template.spec.secretEnv).length > 0
      ? { ...template.spec.secretEnv }
      : { ...current.secretEnv },
    ports: current.ports.map((port) => ({ ...port })),
  };
}

export type TemplateBlockReason =
  | "loading"
  | "build"
  | "build-failed"
  | "image-missing"
  | "checking"
  | "missing-references"
  | "no-container";

// templateBlockReason reports why the Continue action must stay disabled, or
// undefined once it may run. The draft image is the gate that changed: only the
// template's own derived image is buildable here, so its plan blocks Continue
// while it needs a build, while the build runs and after a failure; another
// listed image needs no build, and an image the list no longer holds blocks
// because this popup cannot build it. Missing references block first — a
// pending project check counts as one, so its row's number stays put while the
// check reruns — and the checking state is reported only once nothing is
// missing. A replace with no chosen container blocks. Creating never blocks on a
// name here: the container name is chosen in the create editor the step opens.
export function templateBlockReason(options: {
  inspection: TemplateInspectionView | null;
  draftImage: string;
  images: readonly { imageId: string }[];
  buildInProgress: boolean;
  buildFailed: string;
  pendingReferences: number;
  missingReferences: number;
  mode: "create" | "replace";
  replaceTarget: string;
}): TemplateBlockReason | undefined {
  if (options.inspection === null) return "loading";
  const plan = options.inspection.image;
  if (options.draftImage === plan.imageId) {
    if (options.buildInProgress) return "build";
    if (options.buildFailed !== "") return "build-failed";
    if (plan.needsBuild) return "build";
  } else if (
    !options.images.some((image) => image.imageId === options.draftImage)
  ) {
    return "image-missing";
  }
  if (options.missingReferences > 0) return "missing-references";
  if (options.pendingReferences > 0) return "checking";
  if (options.mode === "replace") {
    return options.replaceTarget === "" ? "no-container" : undefined;
  }
  return undefined;
}

export type TemplateBuildAction =
  | "none"
  | "build"
  | "building"
  | "rebuild"
  | "rebuilding";

// templateBuildAction is what the details popup's image card offers for the
// template's own image. A plan whose image is missing (or whose recipe changed)
// gets Build, a ready image gets Rebuild, and while a build runs the button is
// disabled and labelled as progress. A base-only plan's image is its effective
// base, so a draft on either id that names it counts as the template's own; the
// callback's `force` flag then rebuilds or pulls that base. Choosing another
// listed image, or an image the list no longer holds, gets no action here — this
// popup only runs the template route for the template's image.
export function templateBuildAction(options: {
  plan: TemplateImagePlan | null;
  draftImage: string;
  building: boolean;
  buildFailed: string;
}): TemplateBuildAction {
  if (
    options.plan === null || !isTemplateImage(options.plan, options.draftImage)
  ) {
    return "none";
  }
  if (options.building) {
    return options.plan.needsBuild ? "building" : "rebuilding";
  }
  if (options.plan.needsBuild) return "build";
  return "rebuild";
}

// What the image card's one button says. "none" means the card offers no
// action; the busy values are the template build's own states, whose progress
// the popup words itself, while a custom or base command reports its progress
// through the session's busy state instead.
export type TemplateImageAction =
  | "none"
  | "build"
  | "building"
  | "rebuild"
  | "rebuilding"
  | "pull";

// The command an action dispatches. Each non-template command is exactly the one
// the Images tab runs from its own row; the template commands keep the template
// build route, where a rebuild is the same call with `force` set.
export type TemplateImageCommand =
  | "none"
  | "template-build"
  | "template-rebuild"
  | "custom-build"
  | "custom-rebuild"
  | "base-build"
  | "base-rebuild"
  | "base-pull";

// One decision of the image card: the action its button shows and the command
// that click runs.
export interface TemplateImageActionDecision {
  action: TemplateImageAction;
  command: TemplateImageCommand;
}

// templateImageAction is what the details popup's image card offers for the
// draft's image, and the command behind it. The template's own image keeps the
// template action (Build while the plan needs it, Rebuild once it is ready, and
// progress while that call runs). Any other listed image offers what the Images
// tab offers for it: a custom image is rebuilt when its record is built and
// built when it is missing; a base is rebuilt when it is present, built when it
// is missing, and pulled instead when its tag comes from a public registry,
// where a base is pulled whether it is missing or already pulled. An image the
// list does not hold, like the reserved PTC image, offers no action: only the
// template's own image is built from the plan rather than from the list.
export function templateImageAction(options: {
  plan: TemplateImagePlan | null;
  draftImage: string;
  images: readonly TemplateImageCandidate[];
  building: boolean;
  // Kept for the template-own decision, which passes it to
  // templateBuildAction; the other images have no build failure of this popup.
  buildFailed?: string;
}): TemplateImageActionDecision {
  const decision = (
    action: TemplateImageAction,
    command: TemplateImageCommand,
  ): TemplateImageActionDecision => ({ action, command });
  const metadata = options.plan === null ? "none" : templateBuildAction({
    plan: options.plan,
    draftImage: options.draftImage,
    building: options.building,
    buildFailed: options.buildFailed ?? "",
  });
  switch (metadata) {
    case "build":
      return decision("build", "template-build");
    case "building":
      return decision("building", "template-build");
    case "rebuild":
      return decision("rebuild", "template-rebuild");
    case "rebuilding":
      return decision("rebuilding", "template-rebuild");
    case "none":
      // No chosen template means no details and no action at all.
      if (options.plan === null) return decision("none", "none");
  }
  const image = options.images.find((candidate) =>
    candidate.imageId === options.draftImage
  );
  if (image === undefined || isPtcImage(image.imageId)) {
    return decision("none", "none");
  }
  if (image.isBase) {
    // The Images tab pulls a public base instead of building it, whether it is
    // missing or already pulled, and offers Pull only for that same state.
    if (image.basePublic) {
      return image.status === "missing" || image.status === "pulled"
        ? decision("pull", "base-pull")
        : decision("none", "none");
    }
    if (image.status === "missing") {
      return decision("build", "base-build");
    }
    // "pulled" belongs to the public prefix, so a local base is normally
    // "built"; accepting both means a present base always offers Rebuild.
    return image.status === "built" || image.status === "pulled"
      ? decision("rebuild", "base-rebuild")
      : decision("none", "none");
  }
  if (image.status === "missing") {
    return decision("build", "custom-build");
  }
  return image.status === "built"
    ? decision("rebuild", "custom-rebuild")
    : decision("none", "none");
}

// missingSecretNames lists the secrets a container configuration requires that
// the workspace no longer has, in first-use order. The editor offers creating
// each one in place.
export function missingSecretNames(
  secretEnv: Record<string, string>,
  secrets: readonly { name: string }[],
): string[] {
  const known = new Set(secrets.map((secret) => secret.name));
  const missing: string[] = [];
  for (const secret of Object.values(secretEnv)) {
    if (secret === "" || known.has(secret) || missing.includes(secret)) {
      continue;
    }
    missing.push(secret);
  }
  return missing;
}
