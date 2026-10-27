// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// The container-template format: a strict, versioned YAML document that
// describes one container's image, environment, secrets, mounts, PATH
// additions and published ports. This module is the single implementation of
// the format: the host parses and renders templates, the browser bundles the
// same code for the load popup and the export dialog, so an accepted template
// means the same thing everywhere.
//
// Everything here is pure and browser-safe: no node imports, and the one
// asynchronous helper (the image id) uses the Web Crypto API, which Node also
// exposes.

import { parseAllDocuments } from "yaml";
import { GIT_IDENTITY_KEYS } from "./container-env.js";
import {
  defaultMountMode,
  mountKindRank,
  normalizeMountKind,
  normalizeMountMode,
} from "./mount-enums.js";
import { isPrimaryProjectMount } from "./mount-order.js";
import { portProtocolFromProto } from "./publish-port.js";

export const TEMPLATE_VERSION = 1;
export const TEMPLATE_KIND = "dsh-podman/container-template";
export const TEMPLATE_DIRECTORY = ".dsh-podman";
export const TEMPLATE_EXTENSION = ".yml";

// The only base images a template may name. They are the orchestrator's fixed
// base registry (see docs/usage.md); a template never names a custom image other
// than the one it builds itself.
export const BASE_IMAGES = ["archlinux", "ubuntu", "alpine"] as const;
export type BaseImageName = (typeof BASE_IMAGES)[number];

// The built-in packages each base image ships. A template package list is
// canonical: a package already in this list is dropped, so a template that only
// names built-ins refers to the base image and never triggers a build. Keep in
// sync with internal/orchestrator/images/images.go and docs/usage.md.
export const BASE_IMAGE_PACKAGES: Record<BaseImageName, readonly string[]> = {
  archlinux: [
    "base-devel",
    "ca-certificates",
    "curl",
    "diffutils",
    "fd",
    "git",
    "inetutils",
    "jq",
    "less",
    "openbsd-netcat",
    "openssh",
    "patch",
    "procps-ng",
    "python",
    "ripgrep",
    "tree",
    "unzip",
    "wget",
    "zstd",
  ],
  ubuntu: [
    "build-essential",
    "ca-certificates",
    "curl",
    "diffutils",
    "fd-find",
    "git",
    "jq",
    "less",
    "netcat-openbsd",
    "openssh-client",
    "patch",
    "procps",
    "python3",
    "ripgrep",
    "tree",
    "unzip",
    "wget",
    "zstd",
  ],
  alpine: [
    "bash",
    "build-base",
    "ca-certificates",
    "curl",
    "diffutils",
    "fd",
    "git",
    "jq",
    "less",
    "openssh-client",
    "patch",
    "procps",
    "python3",
    "ripgrep",
    "tree",
    "unzip",
    "wget",
    "zstd",
  ],
};

export function isBaseImage(value: unknown): value is BaseImageName {
  return typeof value === "string" &&
    (BASE_IMAGES as readonly string[]).includes(value);
}

// A template mount. Project mounts carry no destination (the project path is
// mirrored under the projects root) and, like volume mounts, an optional mode
// defaulting to read-only. Secret mounts are fixed read-only and tmpfs mounts
// carry only a destination; neither takes a mode at all.
export type TemplateMount =
  | { kind: "project"; project: string; mode: MountMode }
  | { kind: "volume"; volume: string; destination: string; mode: MountMode }
  | { kind: "secret"; secret: string; destination: string }
  | { kind: "tmpfs"; destination: string };

export type MountMode = "read_only" | "read_write";

export interface TemplatePort {
  container: number;
  host?: number;
  protocol: "tcp";
}

export interface TemplateImage {
  base: BaseImageName;
  packages: string[];
}

export interface ContainerTemplateSpec {
  // Exactly one of image and imageTemplate is present in a canonical template:
  // a template that needs no extra packages is normalized to `image`.
  image?: BaseImageName;
  imageTemplate?: TemplateImage;
  env: Record<string, string>;
  secretEnv: Record<string, string>;
  mounts: TemplateMount[];
  paths: string[];
  ports: TemplatePort[];
}

export interface ContainerTemplate {
  version: typeof TEMPLATE_VERSION;
  kind: typeof TEMPLATE_KIND;
  spec: ContainerTemplateSpec;
}

// A template failure: the YAML could not be parsed, or the document broke one of
// the format's rules. The message names the offending field so the user can fix
// it in place.
export class TemplateError extends Error {
  readonly path: string;
  constructor(message: string, path = "") {
    super(path === "" ? message : `${path}: ${message}`);
    this.name = "TemplateError";
    this.path = path;
  }
}

// The template's effective image: either the base image alone, or a base plus
// the extra packages it installs. `packages` is canonical (sorted, unique, and
// without the base's built-ins) and never empty here.
export type EffectiveImage =
  | { kind: "base"; base: BaseImageName }
  | {
    kind: "template";
    base: BaseImageName;
    packages: string[];
  };

export interface TemplateImagePlan {
  effective: EffectiveImage;
  // The short image id a container names: the base image for a base-only
  // template, otherwise the deterministic template image id.
  imageId: string;
  // The instant the listed image was built, or "" when the list holds no
  // usable record for it. Carried here so the popup shows the build time
  // without a second image-list lookup.
  builtAt: string;
  // Whether the image list holds a usable image with this id and the same
  // parent and packages. A record marked "missing" is not present.
  present: boolean;
  // The package list (or parent) differs from the listed image, so a build is
  // needed rather than a plain reuse.
  rebuild: boolean;
  // A build is needed: the image is missing, or its recipe changed.
  needsBuild: boolean;
  // The reason a build is needed, or "ready".
  reason: "ready" | "missing" | "packages" | "parent";
}

export type TemplateWarning =
  | { kind: "project_missing"; project: string; path: string }
  | { kind: "secret_missing"; secret: string }
  | { kind: "secret_env_missing"; env: string; secret: string }
  | { kind: "volume_missing"; volume: string };

const PACKAGE_PATTERN = /^[A-Za-z0-9@+._:][A-Za-z0-9@+._:-]*$/;
const SECRET_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const IMAGE_ID_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}$/;

const SPEC_KEYS = new Set([
  "image",
  "imageTemplate",
  "env",
  "secretEnv",
  "mounts",
  "paths",
  "ports",
]);
const IMAGE_KEYS = new Set(["base", "packages"]);
const MOUNT_KEYS: Record<string, ReadonlySet<string>> = {
  project: new Set(["kind", "project", "mode"]),
  volume: new Set(["kind", "volume", "destination", "mode"]),
  secret: new Set(["kind", "secret", "destination"]),
  tmpfs: new Set(["kind", "destination"]),
};
const PORT_KEYS = new Set(["container", "host", "protocol"]);

// canonicalPackages normalizes an imageTemplate package list: invalid names are
// refused, duplicates collapse, the base's built-in packages are dropped, and
// the result is sorted so two spellings of the same package set compare equal.
export function canonicalPackages(
  base: BaseImageName,
  packages: readonly unknown[],
): string[] {
  const builtins = new Set(BASE_IMAGE_PACKAGES[base]);
  const result = new Set<string>();
  for (const value of packages) {
    if (typeof value !== "string" || !validPackageName(value)) {
      throw new TemplateError(
        `invalid package name ${JSON.stringify(value)}`,
        "spec.imageTemplate.packages",
      );
    }
    if (!builtins.has(value)) result.add(value);
  }
  return [...result].sort();
}

function validPackageName(value: string): boolean {
  return value !== "." && value !== ".." && PACKAGE_PATTERN.test(value);
}

// cleanAbsolutePath normalizes an absolute POSIX path lexically, or returns
// undefined when the value is not an absolute, already-clean path. Templates
// never name "/" itself or a path carrying "..", "." or a trailing slash.
export function cleanAbsolutePath(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.startsWith("/")) return undefined;
  if (/[\0\n\r]/.test(value)) return undefined;
  const segments: string[] = [];
  for (const segment of value.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") return undefined;
    segments.push(segment);
  }
  if (segments.length === 0) return undefined;
  const cleaned = `/${segments.join("/")}`;
  return cleaned === value ? cleaned : undefined;
}

// normalizeProjectPath normalizes a project path (a path under the projects
// root): relative, no empty or "." segments, and no ".." that climbs above the
// root. Returns undefined when the value names no directory inside the root.
export function normalizeProjectPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (/[\0\n\r]/.test(value) || value.startsWith("/")) return undefined;
  const segments: string[] = [];
  for (const segment of value.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return undefined;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.length === 0 ? undefined : segments.join("/");
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ownEntries(value: Record<string, unknown>): [string, unknown][] {
  return Object.entries(value).filter(([key]) => key !== "__proto__");
}

function rejectUnknown(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  for (const [key] of ownEntries(value)) {
    if (!allowed.has(key)) {
      throw new TemplateError(
        `unknown key ${JSON.stringify(key)}`,
        path === "" ? key : `${path}.${key}`,
      );
    }
  }
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new TemplateError("expected a string", path);
  }
  return value;
}

function nonEmptyString(value: unknown, path: string): string {
  const text = stringValue(value, path);
  if (text === "") throw new TemplateError("expected a non-empty string", path);
  return text;
}

function envKey(value: string, path: string): string {
  if (value === "") throw new TemplateError("env key is empty", path);
  if (value.includes("=")) {
    throw new TemplateError(`env key ${JSON.stringify(value)} contains "="`);
  }
  if (value.includes("\0")) {
    throw new TemplateError(
      `env key ${JSON.stringify(value)} contains a NUL byte`,
      path,
    );
  }
  if (value.startsWith("DSH_PODMAN")) {
    throw new TemplateError(
      `env key ${JSON.stringify(value)} is reserved (DSH_PODMAN prefix)`,
      path,
    );
  }
  return value;
}

function secretName(value: unknown, path: string): string {
  const name = nonEmptyString(value, path);
  if (!SECRET_PATTERN.test(name)) {
    throw new TemplateError(
      `invalid secret name ${JSON.stringify(name)}`,
      path,
    );
  }
  return name;
}

function stringMap(
  value: unknown,
  path: string,
  keyCheck: (key: string, at: string) => string,
  valueCheck: (value: unknown, at: string) => string,
): Record<string, string> {
  if (value === undefined) return {};
  if (!isMapping(value)) {
    throw new TemplateError("expected a mapping", path);
  }
  const result: Record<string, string> = Object.create(null);
  for (const [key, item] of ownEntries(value)) {
    const checkedKey = keyCheck(key, `${path}.${key}`);
    result[checkedKey] = valueCheck(item, `${path}.${key}`);
  }
  return result;
}

function parseMount(value: unknown, path: string): TemplateMount {
  if (!isMapping(value)) {
    throw new TemplateError("expected a mount mapping", path);
  }
  const kind = nonEmptyString(value.kind, `${path}.kind`);
  const allowed = MOUNT_KEYS[kind];
  if (allowed === undefined) {
    throw new TemplateError(
      `unknown mount kind ${JSON.stringify(kind)}`,
      `${path}.kind`,
    );
  }
  // A key that belongs to another kind is named as such instead of reading as
  // a generic unknown key, so the user knows which mount shape was expected.
  const forbidden: readonly string[] = kind === "project"
    ? ["destination", "volume", "secret"]
    : kind === "tmpfs"
    ? ["project", "volume", "secret", "size", "mode"]
    : kind === "secret"
    ? ["mode"]
    : [];
  for (const key of forbidden) {
    if (key in value) {
      throw new TemplateError(
        `a ${kind} mount does not take ${JSON.stringify(key)}`,
        `${path}.${key}`,
      );
    }
  }
  rejectUnknown(value, allowed, path);
  if (kind === "project") {
    const project = normalizeProjectPath(value.project);
    if (project === undefined) {
      throw new TemplateError(
        "expected a project path under the projects root",
        `${path}.project`,
      );
    }
    return {
      kind,
      project,
      mode: parseMountMode(value.mode, `${path}.mode`, kind),
    };
  }
  if (kind === "tmpfs") {
    const destination = cleanAbsolutePath(value.destination);
    if (destination === undefined) {
      throw new TemplateError(
        "expected an absolute, clean destination",
        `${path}.destination`,
      );
    }
    return { kind, destination };
  }
  const destination = cleanAbsolutePath(value.destination);
  if (destination === undefined) {
    throw new TemplateError(
      "expected an absolute, clean destination",
      `${path}.destination`,
    );
  }
  if (kind === "secret") {
    return {
      kind,
      secret: secretName(value.secret, `${path}.secret`),
      destination,
    };
  }
  const volume = nonEmptyString(value.volume, `${path}.volume`);
  if (!SECRET_PATTERN.test(volume)) {
    throw new TemplateError(
      `invalid volume name ${JSON.stringify(volume)}`,
      `${path}.volume`,
    );
  }
  return {
    kind: "volume",
    volume,
    destination,
    mode: parseMountMode(value.mode, `${path}.mode`, "volume"),
  };
}

// parseMountMode reads the mode of a project or volume mount. It accepts only
// the two logical spellings and defaults, like the editor's new-mount draft, to
// read-only when the document omits it.
function parseMountMode(
  value: unknown,
  path: string,
  kind: "project" | "volume",
): MountMode {
  if (value === undefined) return defaultMountMode(kind) as MountMode;
  if (value !== "read_only" && value !== "read_write") {
    throw new TemplateError(
      `invalid mount mode ${JSON.stringify(value)}`,
      path,
    );
  }
  return value;
}

function parsePort(value: unknown, path: string): TemplatePort {
  if (!isMapping(value)) {
    throw new TemplateError("expected a port mapping", path);
  }
  rejectUnknown(value, PORT_KEYS, path);
  const container = value.container;
  if (
    typeof container !== "number" || !Number.isInteger(container) ||
    container < 1 || container > 65535
  ) {
    throw new TemplateError(
      "container port must be an integer between 1 and 65535",
      `${path}.container`,
    );
  }
  if (value.protocol === undefined) {
    throw new TemplateError(
      "protocol is required (only tcp is implemented)",
      `${path}.protocol`,
    );
  }
  if (value.protocol !== "tcp") {
    throw new TemplateError(
      `unsupported protocol ${
        JSON.stringify(value.protocol)
      }: only tcp is implemented`,
      `${path}.protocol`,
    );
  }
  let host: number | undefined;
  if (value.host !== undefined) {
    host = value.host as number;
    if (
      typeof host !== "number" || !Number.isInteger(host) ||
      host < 1024 || host > 65535
    ) {
      throw new TemplateError(
        "host port must be an integer between 1024 and 65535",
        `${path}.host`,
      );
    }
  }
  return {
    container,
    ...(host === undefined ? {} : { host }),
    protocol: "tcp",
  };
}

// parseContainerTemplate parses and validates a template document, returning the
// canonical form: a template whose package list only names base built-ins is
// normalized to `image: <base>` so loading it never builds anything.
export function parseContainerTemplate(text: string): ContainerTemplate {
  let docs;
  try {
    docs = parseAllDocuments(text, { uniqueKeys: true });
  } catch (error) {
    throw new TemplateError(
      `invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const failures = docs.flatMap((doc) => doc.errors);
  if (failures.length > 0) {
    const first = failures[0];
    throw new TemplateError(`invalid YAML: ${first.message}`);
  }
  if (docs.length === 0) {
    throw new TemplateError("the document is empty");
  }
  if (docs.length > 1) {
    throw new TemplateError("only one YAML document is allowed");
  }
  let raw: unknown;
  try {
    raw = docs[0].toJS({ maxAliasCount: 100 });
  } catch (error) {
    throw new TemplateError(
      `invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return validateTemplate(raw);
}

// The Git identity variables the default environment injects. A template must
// never carry them: exporting one would freeze the machine's identity, and a
// hand-edited file could pin it, so both directions drop them silently.
const GIT_IDENTITY_KEY_SET: ReadonlySet<string> = new Set<string>(
  GIT_IDENTITY_KEYS,
);

function withoutGitIdentity(
  value: Record<string, string>,
): Record<string, string> {
  // Keep the map's existing shape (and its null prototype for a parsed map)
  // when there is nothing to drop, so a template without identity variables is
  // returned exactly as it was read.
  let found = false;
  for (const key of Object.keys(value)) {
    if (GIT_IDENTITY_KEY_SET.has(key)) {
      found = true;
      break;
    }
  }
  if (!found) return value;
  const result: Record<string, string> = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    if (GIT_IDENTITY_KEY_SET.has(key)) continue;
    result[key] = item;
  }
  return result;
}

// validateTemplate checks an already-parsed value against the format, so the
// same rules apply to a YAML document and to a structured request.
export function validateTemplate(raw: unknown): ContainerTemplate {
  if (!isMapping(raw)) {
    throw new TemplateError("the document must be a mapping");
  }
  rejectUnknown(raw, new Set(["version", "kind", "spec"]), "");
  if (raw.version !== TEMPLATE_VERSION) {
    throw new TemplateError(
      `unsupported version ${
        JSON.stringify(raw.version)
      } (expected ${TEMPLATE_VERSION})`,
      "version",
    );
  }
  if (raw.kind !== TEMPLATE_KIND) {
    throw new TemplateError(
      `unsupported kind ${JSON.stringify(raw.kind)} (expected ${
        JSON.stringify(TEMPLATE_KIND)
      })`,
      "kind",
    );
  }
  if (!isMapping(raw.spec)) {
    throw new TemplateError("expected a mapping", "spec");
  }
  const spec = raw.spec;
  rejectUnknown(spec, SPEC_KEYS, "spec");

  const hasImage = spec.image !== undefined && spec.image !== null;
  const hasTemplate = spec.imageTemplate !== undefined &&
    spec.imageTemplate !== null;
  if (hasImage && hasTemplate) {
    throw new TemplateError(
      "exactly one of image and imageTemplate is allowed, not both",
      "spec",
    );
  }
  if (!hasImage && !hasTemplate) {
    throw new TemplateError(
      "exactly one of image and imageTemplate is required",
      "spec",
    );
  }

  let image: BaseImageName | undefined;
  let imageTemplate: TemplateImage | undefined;
  if (hasImage) {
    if (!isBaseImage(spec.image)) {
      throw new TemplateError(
        `unsupported base image ${
          JSON.stringify(spec.image)
        } (expected one of ${BASE_IMAGES.join(", ")})`,
        "spec.image",
      );
    }
    image = spec.image;
  } else {
    const value = spec.imageTemplate;
    if (!isMapping(value)) {
      throw new TemplateError("expected a mapping", "spec.imageTemplate");
    }
    rejectUnknown(value, IMAGE_KEYS, "spec.imageTemplate");
    if (!isBaseImage(value.base)) {
      throw new TemplateError(
        `unsupported base image ${
          JSON.stringify(value.base)
        } (expected one of ${BASE_IMAGES.join(", ")})`,
        "spec.imageTemplate.base",
      );
    }
    if (!Array.isArray(value.packages)) {
      throw new TemplateError(
        "expected a list of package names",
        "spec.imageTemplate.packages",
      );
    }
    const packages = canonicalPackages(value.base, value.packages);
    if (packages.length === 0) {
      // A list that only repeats the base's built-ins refers to the base image.
      image = value.base;
    } else {
      imageTemplate = { base: value.base, packages };
    }
  }

  const env = withoutGitIdentity(stringMap(
    spec.env,
    "spec.env",
    (key, at) => envKey(key, at),
    (value, at) => {
      const text = stringValue(value, at);
      if (text.includes("\0")) {
        throw new TemplateError(
          `env value for key contains a NUL byte`,
          at,
        );
      }
      return text;
    },
  ));
  const secretEnv = withoutGitIdentity(stringMap(
    spec.secretEnv,
    "spec.secretEnv",
    (key, at) => envKey(key, at),
    (value, at) => secretName(value, at),
  ));
  for (const key of Object.keys(secretEnv)) {
    if (key in env) {
      throw new TemplateError(
        `variable ${
          JSON.stringify(key)
        } is used as both an env and a secret env variable`,
        "spec",
      );
    }
  }

  const mounts = parseList(spec.mounts, "spec.mounts", parseMount);
  const paths = parseList(spec.paths, "spec.paths", parsePath);
  const ports = parseList(spec.ports, "spec.ports", parsePort);

  return {
    version: TEMPLATE_VERSION,
    kind: TEMPLATE_KIND,
    spec: {
      ...(image === undefined ? {} : { image }),
      ...(imageTemplate === undefined ? {} : { imageTemplate }),
      env,
      secretEnv,
      mounts,
      paths,
      ports,
    },
  };
}

function parseList<T>(
  value: unknown,
  path: string,
  parseItem: (item: unknown, at: string) => T,
): T[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new TemplateError("expected a list", path);
  }
  return value.map((item, index) => parseItem(item, `${path}[${index}]`));
}

function parsePath(value: unknown, path: string): string {
  const text = stringValue(value, path);
  if (text.includes(":") || /[\0\n\r]/.test(text)) {
    throw new TemplateError(
      "a path must not contain ':', NUL, or a newline",
      path,
    );
  }
  const cleaned = cleanAbsolutePath(text);
  if (cleaned === undefined) {
    throw new TemplateError("expected an absolute, clean directory", path);
  }
  return cleaned;
}

// effectiveImage returns the image a template refers to after the canonical
// rules: base-only templates name the base, everything else a base plus the
// extra packages.
export function effectiveImage(template: ContainerTemplate): EffectiveImage {
  const { image, imageTemplate } = template.spec;
  if (imageTemplate !== undefined) {
    return {
      kind: "template",
      base: imageTemplate.base,
      packages: canonicalPackages(imageTemplate.base, imageTemplate.packages),
    };
  }
  if (image === undefined) {
    throw new TemplateError("a template must name an image");
  }
  return { kind: "base", base: image };
}

// templateExportImage resolves the base and extra packages an existing image
// would export as. A custom image is walked up to its root base and its package
// lists are unioned, then the base's built-ins are dropped. A broken parent
// chain is an error rather than a silently truncated export.
export function templateExportImage(
  imageId: string,
  images: readonly {
    imageId: string;
    parent: string;
    packages: readonly string[];
    isBase?: boolean;
  }[],
): EffectiveImage {
  if (isBaseImage(imageId)) return { kind: "base", base: imageId };
  const byId = new Map(images.map((image) => [image.imageId, image]));
  const seen = new Set<string>();
  let current = imageId;
  let base: BaseImageName | undefined;
  const packages: string[] = [];
  for (;;) {
    if (seen.has(current)) {
      throw new TemplateError(
        `image ${JSON.stringify(imageId)} has a cyclic parent chain`,
      );
    }
    seen.add(current);
    if (isBaseImage(current)) {
      base = current;
      break;
    }
    const row = byId.get(current);
    if (row === undefined) {
      throw new TemplateError(
        current === imageId
          ? `image ${JSON.stringify(imageId)} is not listed`
          : `image ${JSON.stringify(current)} is not listed`,
      );
    }
    packages.push(...row.packages);
    if (row.parent === "" || row.parent === undefined) {
      throw new TemplateError(
        `image ${
          JSON.stringify(current)
        } has no parent, so it has no base image`,
      );
    }
    current = row.parent;
  }
  const canonical = canonicalPackages(base, packages);
  return canonical.length === 0
    ? { kind: "base", base }
    : { kind: "template", base, packages: canonical };
}

// templateImagePlan compares a template's effective image with the images the
// orchestrator reports. The template image id is deterministic (see
// templateImageId), so a listed image with that id is this template's own and
// can be reused exactly when its parent and package list match. A custom record
// the orchestrator reports as "missing" is stale — podman no longer stores the
// image — so it is planned exactly like an absent image.
export function templateImagePlan(
  effective: EffectiveImage,
  imageId: string,
  images: readonly {
    imageId: string;
    parent: string;
    packages: readonly string[];
    // "built" or "pulled" for an image podman stores; "missing" for a record
    // whose image podman no longer has (a stale custom record, or a base that
    // was never provisioned).
    status?: string;
    // The instant podman reports the image was created; absent when unknown.
    builtAt?: string;
  }[],
): TemplateImagePlan {
  if (effective.kind === "base") {
    // A base-only template runs the base image itself, so the plan states
    // whether that base is actually provisioned: a record podman reports as
    // missing, or no record at all, is a build exactly like a custom image.
    const base = images.find((image) => image.imageId === effective.base);
    if (
      base === undefined ||
      (base.status !== "built" && base.status !== "pulled")
    ) {
      return {
        effective,
        imageId: effective.base,
        builtAt: "",
        present: false,
        rebuild: false,
        needsBuild: true,
        reason: "missing",
      };
    }
    return {
      effective,
      imageId: effective.base,
      builtAt: base.builtAt ?? "",
      present: true,
      rebuild: false,
      needsBuild: false,
      reason: "ready",
    };
  }
  const listed = images.find((image) => image.imageId === imageId);
  // A record can outlive the image podman stores: the orchestrator keeps the
  // custom entry and marks it "missing". Any such hit is a build, not a reuse.
  if (listed === undefined || listed.status === "missing") {
    return {
      effective,
      imageId,
      builtAt: "",
      present: false,
      rebuild: false,
      needsBuild: true,
      reason: "missing",
    };
  }
  const builtAt = listed.builtAt ?? "";
  const parentMatches = listed.parent === effective.base;
  const listedPackages = [...listed.packages].sort();
  if (!parentMatches) {
    return {
      effective,
      imageId,
      builtAt,
      present: true,
      rebuild: true,
      needsBuild: true,
      reason: "parent",
    };
  }
  if (
    listedPackages.length !== effective.packages.length ||
    listedPackages.some((pkg, index) => pkg !== effective.packages[index])
  ) {
    return {
      effective,
      imageId,
      builtAt,
      present: true,
      rebuild: true,
      needsBuild: true,
      reason: "packages",
    };
  }
  return {
    effective,
    imageId,
    builtAt,
    present: true,
    rebuild: false,
    needsBuild: false,
    reason: "ready",
  };
}

// sanitizedTemplateName turns a template file's basename into the readable part
// of its image id: letters, digits, "_", "." and "-" only, starting with an
// alphanumeric character or "_", short enough to leave room for the prefix and
// digest.
export function sanitizedTemplateName(name: string): string {
  const base = name.replace(/\.(ya?ml)$/i, "");
  let sanitized = base
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^[^A-Za-z0-9_]+/, "")
    .replace(/[.-]+$/g, "");
  if (sanitized === "") sanitized = "template";
  sanitized = sanitized.slice(0, 40);
  return sanitized;
}

// templateImageId derives the short image id of a template: the sanitized file
// basename plus the first 8 hex characters of sha256(absolute template path).
// The path, not the name, makes two same-named templates in different projects
// distinct, so one project's build never overwrites another's.
export async function templateImageId(
  name: string,
  absolutePath: string,
): Promise<string> {
  return templateImageIdFromDigest(name, await sha256Hex(absolutePath));
}

export function templateImageIdFromDigest(
  name: string,
  digestHex: string,
): string {
  const id = `template-${sanitizedTemplateName(name)}-${
    digestHex.slice(0, 8).toLowerCase()
  }`;
  if (!IMAGE_ID_PATTERN.test(id)) {
    throw new TemplateError(
      `cannot derive an image id from ${JSON.stringify(name)}`,
    );
  }
  return id;
}

// sha256Hex hashes a string with the Web Crypto API, which both Node and the
// browser expose.
export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

// templateRequirements reports what a template expects of its workspace: the
// project mount directories that do not exist, the mounted volumes that are
// absent, and the named secrets that are absent. A missing secret or volume is
// reported once per name, even when several variables or mounts use it.
export function templateRequirements(
  template: ContainerTemplate,
  options: {
    projectExists?: (project: string) => boolean;
    secrets?: readonly string[];
    volumes?: readonly string[];
  } = {},
): TemplateWarning[] {
  const warnings: TemplateWarning[] = [];
  if (options.projectExists !== undefined) {
    for (const mount of template.spec.mounts) {
      if (mount.kind !== "project") continue;
      if (options.projectExists(mount.project)) continue;
      warnings.push({
        kind: "project_missing",
        project: mount.project,
        path: mount.project,
      });
    }
  }
  if (options.secrets !== undefined) {
    const known = new Set(options.secrets);
    const reported = new Set<string>();
    for (const [env, secret] of Object.entries(template.spec.secretEnv)) {
      if (known.has(secret)) continue;
      warnings.push({ kind: "secret_env_missing", env, secret });
      reported.add(secret);
    }
    for (const mount of template.spec.mounts) {
      if (mount.kind !== "secret" || known.has(mount.secret)) continue;
      if (reported.has(mount.secret)) continue;
      warnings.push({ kind: "secret_missing", secret: mount.secret });
      reported.add(mount.secret);
    }
  }
  if (options.volumes !== undefined) {
    const known = new Set(options.volumes);
    const reported = new Set<string>();
    for (const mount of template.spec.mounts) {
      if (mount.kind !== "volume" || known.has(mount.volume)) continue;
      if (reported.has(mount.volume)) continue;
      warnings.push({ kind: "volume_missing", volume: mount.volume });
      reported.add(mount.volume);
    }
  }
  return warnings;
}

// exportMountDestination reads the destination a volume, secret or tmpfs mount
// must carry. Project mounts never reach it: their path is derived from the
// projects root, so demanding a destination on every mount would reject every
// container that has one.
function exportMountDestination(
  containerName: string,
  value: string | undefined,
): string {
  const destination = cleanAbsolutePath(value);
  if (destination === undefined) {
    throw new TemplateError(
      `container ${
        JSON.stringify(containerName)
      } has a mount without a valid destination`,
    );
  }
  return destination;
}

// exportContainerTemplate builds a template from a container and the image list
// it runs from. The image is exported as the root base plus the recursive union
// of packages minus the base's built-ins, so a custom image that only has base
// packages exports as `image: <base>`. `mainProject` is the workspace's own
// project name: the mount naming it is listed first, as the container editor
// lists it, whatever order the container's mounts arrived in.
export function exportContainerTemplate(
  container: {
    containerName: string;
    imageId: string;
    env?: Record<string, string>;
    secretEnv?: Record<string, string>;
    mounts?: readonly {
      kind: string;
      projectName?: string;
      destination?: string;
      mode?: string;
      volume?: string;
      secret?: string;
    }[];
    paths?: readonly string[];
    publishedPorts?: readonly {
      port: number;
      hostPort?: number;
      protocol?: string;
    }[];
  },
  images: readonly {
    imageId: string;
    parent: string;
    packages: readonly string[];
    isBase?: boolean;
  }[],
  mainProject = "",
): { filename: string; yaml: string; template: ContainerTemplate } {
  const effective = templateExportImage(container.imageId, images);
  const mounts: TemplateMount[] = [];
  for (const mount of container.mounts ?? []) {
    // A container row carries the control plane's proto spelling while a card
    // snapshot carries the short one; normalise either before applying the
    // per-kind rules, as the editor does.
    const kind = normalizeMountKind(mount.kind);
    if (kind === "project") {
      // A project mount carries no destination of its own: the project path is
      // mirrored under the projects root, so a destination a view derived is
      // never exported.
      const project = normalizeProjectPath(mount.projectName);
      if (project === undefined) {
        throw new TemplateError(
          `container ${
            JSON.stringify(container.containerName)
          } has an invalid project mount`,
        );
      }
      mounts.push({
        kind: "project",
        project,
        mode: exportMountMode(mount.mode),
      });
      continue;
    }
    if (kind === "volume") {
      const destination = exportMountDestination(
        container.containerName,
        mount.destination,
      );
      if (mount.volume === undefined || mount.volume === "") {
        throw new TemplateError(
          `container ${
            JSON.stringify(container.containerName)
          } has a volume mount without a volume`,
        );
      }
      mounts.push({
        kind: "volume",
        volume: mount.volume,
        destination,
        mode: exportMountMode(mount.mode),
      });
      continue;
    }
    if (kind === "secret") {
      const destination = exportMountDestination(
        container.containerName,
        mount.destination,
      );
      if (mount.secret === undefined || mount.secret === "") {
        throw new TemplateError(
          `container ${
            JSON.stringify(container.containerName)
          } has a secret mount without a secret`,
        );
      }
      mounts.push({ kind: "secret", secret: mount.secret, destination });
      continue;
    }
    if (kind === "tmpfs") {
      mounts.push({
        kind: "tmpfs",
        destination: exportMountDestination(
          container.containerName,
          mount.destination,
        ),
      });
      continue;
    }
    throw new TemplateError(
      `container ${
        JSON.stringify(container.containerName)
      } has an unsupported mount kind ${JSON.stringify(kind)}`,
    );
  }
  const ports: TemplatePort[] = [];
  for (const port of container.publishedPorts ?? []) {
    // A container view may carry the proto enum spelling or the card's logical
    // one; both mean TCP here, and anything else is refused rather than
    // mislabelled.
    const protocol = portProtocolFromProto(port.protocol) ??
      port.protocol ?? "tcp";
    if (protocol !== "tcp") {
      throw new TemplateError(
        `container ${
          JSON.stringify(container.containerName)
        } publishes an unsupported protocol ${JSON.stringify(port.protocol)}`,
      );
    }
    const host = Number(port.hostPort ?? 0);
    ports.push({
      container: Number(port.port),
      ...(host >= 1024 && host <= 65535 ? { host } : {}),
      protocol: "tcp",
    });
  }
  const template: ContainerTemplate = {
    version: TEMPLATE_VERSION,
    kind: TEMPLATE_KIND,
    spec: {
      ...(effective.kind === "base" ? { image: effective.base } : {
        imageTemplate: {
          base: effective.base,
          packages: [...effective.packages],
        },
      }),
      env: orderedStringMap(withoutGitIdentity(container.env ?? {})),
      secretEnv: orderedStringMap(
        withoutGitIdentity(container.secretEnv ?? {}),
      ),
      mounts: orderedTemplateMounts(mounts, mainProject),
      paths: [...(container.paths ?? [])],
      ports,
    },
  };
  const name = sanitizedTemplateName(container.containerName);
  return {
    filename: `${name}${TEMPLATE_EXTENSION}`,
    yaml: renderContainerTemplate(template, mainProject),
    template,
  };
}

function orderedStringMap(
  value: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  for (const key of Object.keys(value).sort()) result[key] = value[key];
  return result;
}

// renderContainerTemplate writes the canonical YAML form. Key order is fixed so
// exporting a container twice produces the same document, and the document is
// block style throughout: one key per line, every sequence as `- ` items, and
// two spaces per nesting level. Empty groups are omitted rather than written as
// `{}` or `[]`; the parser fills them back in with their defaults. Only the
// renderer is opinionated: parsing accepts flow style just as happily. When
// `mainProject` is given, the mount naming it renders first, matching the
// container editor.
export function renderContainerTemplate(
  template: ContainerTemplate,
  mainProject = "",
): string {
  const { spec } = template;
  const lines = [
    `version: ${TEMPLATE_VERSION}`,
    `kind: ${TEMPLATE_KIND}`,
    "spec:",
  ];
  if (spec.image !== undefined) {
    lines.push(`  image: ${yamlScalar(spec.image)}`);
  } else if (spec.imageTemplate !== undefined) {
    lines.push("  imageTemplate:");
    lines.push(`    base: ${yamlScalar(spec.imageTemplate.base)}`);
    lines.push("    packages:");
    lines.push(...blockList(spec.imageTemplate.packages, 6));
  }
  // Environment variable order carries no meaning, so it is sorted to keep the
  // rendering canonical whatever order the parsed document used.
  const env = Object.keys(spec.env).sort();
  if (env.length > 0) {
    lines.push("  env:");
    lines.push(...blockMap(env, spec.env, 4));
  }
  const secretEnv = Object.keys(spec.secretEnv).sort();
  if (secretEnv.length > 0) {
    lines.push("  secretEnv:");
    lines.push(...blockMap(secretEnv, spec.secretEnv, 4));
  }
  const mounts = orderedTemplateMounts(spec.mounts, mainProject);
  if (mounts.length > 0) {
    lines.push("  mounts:");
    lines.push(...blockListMap(mounts.map(mountFields), 4));
  }
  if (spec.paths.length > 0) {
    lines.push("  paths:");
    lines.push(...blockList(spec.paths, 4));
  }
  if (spec.ports.length > 0) {
    lines.push("  ports:");
    lines.push(...blockListMap(spec.ports.map(portFields), 4));
  }
  return `${lines.join("\n")}\n`;
}

// orderedTemplateMounts groups mounts the way the container editor lists them:
// the workspace's primary project mount first, then project mounts, volumes,
// secrets and tmpfs. The sort is stable, so mounts of one kind keep the order
// they already had.
function orderedTemplateMounts(
  mounts: readonly TemplateMount[],
  mainProject: string,
): TemplateMount[] {
  const rank = (mount: TemplateMount): number =>
    isPrimaryProjectMount(mount, mainProject)
      ? 0
      : 1 + mountKindRank(mount.kind);
  return mounts
    .map((mount, index) => ({ mount, index }))
    .sort((left, right) =>
      rank(left.mount) - rank(right.mount) || left.index - right.index
    )
    .map(({ mount }) => mount);
}

function blockMap(
  keys: readonly string[],
  fields: Record<string, string | number>,
  indent: number,
): string[] {
  return keys.map((key) =>
    `${indentOf(indent)}${yamlScalar(key)}: ${yamlScalar(fields[key])}`
  );
}

function blockList(
  values: readonly (string | number)[],
  indent: number,
): string[] {
  return values.map((value) => `${indentOf(indent)}- ${yamlScalar(value)}`);
}

// blockListMap writes a sequence of mappings, one field per line: the first
// field shares the `- ` marker and the rest line up under it.
function blockListMap(
  items: readonly Record<string, string | number>[],
  indent: number,
): string[] {
  const lines: string[] = [];
  for (const fields of items) {
    let first = true;
    for (const [key, value] of Object.entries(fields)) {
      const marker = first ? "- " : "  ";
      lines.push(
        `${indentOf(indent)}${marker}${yamlScalar(key)}: ${yamlScalar(value)}`,
      );
      first = false;
    }
  }
  return lines;
}

function indentOf(width: number): string {
  return " ".repeat(width);
}

// exportMountMode reads a container mount's mode, which may arrive as the
// logical spelling or as a proto enum name, and falls back to read-only when
// the row carries none. Secret and tmpfs mounts never reach here.
function exportMountMode(mode: string | undefined): MountMode {
  if (mode === undefined || mode === "") return "read_only";
  return normalizeMountMode(mode) === "read_write" ? "read_write" : "read_only";
}

function mountFields(mount: TemplateMount): Record<string, string | number> {
  switch (mount.kind) {
    case "project":
      return { kind: "project", project: mount.project, mode: mount.mode };
    case "volume":
      return {
        kind: "volume",
        volume: mount.volume,
        destination: mount.destination,
        mode: mount.mode,
      };
    case "secret":
      return {
        kind: "secret",
        secret: mount.secret,
        destination: mount.destination,
      };
    case "tmpfs":
      return { kind: "tmpfs", destination: mount.destination };
  }
}

function portFields(port: TemplatePort): Record<string, string | number> {
  return {
    container: port.container,
    ...(port.host === undefined ? {} : { host: port.host }),
    protocol: port.protocol,
  };
}

const PLAIN_SCALAR = /^[A-Za-z0-9_./+][A-Za-z0-9_./+:-]*$/;
const RESERVED_SCALARS = new Set([
  "null",
  "~",
  "true",
  "false",
  "yes",
  "no",
  "on",
  "off",
  "y",
  "n",
]);

function yamlScalar(value: string | number): string {
  if (typeof value === "number") return String(value);
  if (
    PLAIN_SCALAR.test(value) &&
    !RESERVED_SCALARS.has(value.toLowerCase()) &&
    !/^[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?$/i.test(value)
  ) {
    return value;
  }
  return JSON.stringify(value);
}

// The mount shape the settings card and the tools already pass around. A
// template mount is converted through this shape so the load popup's editor and
// the orchestrator request take exactly the same path.
export interface TemplateMountInput {
  kind: string;
  project: string;
  destination: string;
  mode: string;
  volume: string;
  secret: string;
}

// templateMountInputs converts a template's mounts to that shared shape. Project
// and volume mounts keep their mode, secret mounts carry no mode, and tmpfs
// mounts are read-write. Passing the workspace project forces that one project
// mount first, keeping the mode the template declared for it and defaulting to
// read-write only when the template does not list it.
export function templateMountInputs(
  template: ContainerTemplate,
  workspaceProject?: string,
): TemplateMountInput[] {
  const mounts = template.spec.mounts.map((mount): TemplateMountInput => {
    switch (mount.kind) {
      case "project":
        return mountInput("project", mount.project, "", mount.mode);
      case "volume":
        return {
          ...mountInput("volume", "", mount.destination, mount.mode),
          volume: mount.volume,
        };
      case "secret":
        return {
          ...mountInput("secret", "", mount.destination, "read_only"),
          secret: mount.secret,
        };
      case "tmpfs":
        return mountInput("tmpfs", "", mount.destination, "read_write");
    }
  });
  if (workspaceProject === undefined) return mounts;
  return withForcedProjectMount(mounts, workspaceProject);
}

function mountInput(
  kind: string,
  project: string,
  destination: string,
  mode: string,
): TemplateMountInput {
  return {
    kind,
    project,
    destination,
    mode,
    volume: "",
    secret: "",
  };
}

// withForcedProjectMount makes the workspace's own project mount the first mount,
// silently replacing any same-project entry the template carried. It is the mount
// a loaded template cannot remove: the container's project directory is what
// every tool operates on. The template still chooses the mount's mode when it
// declares it; a template that omits the mount gets the read-write default.
export function withForcedProjectMount(
  mounts: readonly TemplateMountInput[],
  workspaceProject: string,
): TemplateMountInput[] {
  const project = normalizeProjectPath(workspaceProject);
  if (project === undefined) {
    throw new TemplateError(
      `invalid workspace project ${JSON.stringify(workspaceProject)}`,
    );
  }
  const declared = mounts.find((mount) =>
    mount.kind === "project" && mount.project === project
  );
  const mode = declared === undefined
    ? "read_write"
    : normalizeMountMode(declared.mode);
  const rest = mounts.filter((mount) =>
    !(mount.kind === "project" && mount.project === project)
  );
  return [mountInput("project", project, "", mode), ...rest];
}
