// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// Reading what a `container_template_load` call will apply before the user
// approves it: the template's image, mounts, secret environment and ports, plus
// how many of the existing container's items the replace drops. The approval
// policy calls this async provider so the reason itself can stay synchronous.
//
// Every failure (no workspace for the session cwd, an unreadable or invalid
// template, a control error) returns undefined: the prompt then keeps its base
// sentence rather than blocking the call.

import {
  type ContainerTemplate,
  effectiveImage,
  parseContainerTemplate,
  type TemplateMountInput,
  templateMountInputs,
  withForcedProjectMount,
} from "./container-template.js";
import type {
  MountFact,
  TemplateLoadRemovals,
  TemplateLoadSummary,
} from "./approval-reasons.js";
import { normalizeMountKind } from "./mount-enums.js";
import { readProjectTemplate, workspaceForCwd } from "./template-files.js";
import type { WorkspaceResolver } from "./workspace-binding.js";

// The apply the prompt describes. `container` is the resolved logical target
// ("default" when the call omitted it); `cwd` is the session working directory
// the workspace is resolved from.
export interface TemplateLoadSummaryRequest {
  template: string;
  container: string;
  cwd?: string;
}

// The fields of the existing container the removal counts read. It is the
// control plane's Container row, or the workspace-shaped fallback below.
interface CurrentContainer {
  mounts?: readonly unknown[];
  env?: unknown;
  secretEnv?: unknown;
  paths?: readonly unknown[];
}

// readTemplateLoadSummary builds the approval summary for one template apply,
// or undefined when any part of it cannot be read.
export async function readTemplateLoadSummary(
  resolver: WorkspaceResolver,
  projectsRoot: string,
  request: TemplateLoadSummaryRequest,
): Promise<TemplateLoadSummary | undefined> {
  try {
    const workspace = await workspaceForCwd(
      (resolver as any).registry,
      projectsRoot,
      request.cwd,
    );
    const file = await readProjectTemplate(
      workspace.projectPath,
      request.template,
    );
    const template = parseContainerTemplate(file.yaml);
    // The staged mounts are exactly what applyContainerTemplate sends: the
    // template's own list plus the forced workspace project mount first.
    const staged = withForcedProjectMount(
      templateMountInputs(template),
      workspace.projectName,
    );
    const current = await readCurrentContainer(
      resolver,
      workspace.workspaceSlug,
      request.container,
    );
    const image = effectiveImage(template);
    return {
      image: {
        base: image.base,
        ...(image.kind === "template" ? { packages: image.packages } : {}),
      },
      mounts: staged.map(templateMountFact),
      secretEnv: Object.entries(template.spec.secretEnv).map((
        [env, secret],
      ) => ({ env, secret })),
      ports: template.spec.ports.map((port) =>
        port.host === undefined
          ? { container: port.container }
          : { container: port.container, host: port.host }
      ),
      envCount: Object.keys(template.spec.env).length,
      pathCount: template.spec.paths.length,
      removals: removalCounts(staged, template, current),
    };
  } catch {
    return undefined;
  }
}

// readCurrentContainer returns the container StartContainer will replace, or
// undefined when the workspace has none (the apply creates one, so nothing is
// removed). listContainers carries every container field; listWorkspaces only
// describes the default container, and its PATH additions are not projected
// there, so it is a fallback for a default container listContainers hides.
async function readCurrentContainer(
  resolver: WorkspaceResolver,
  workspaceSlug: string,
  container: string,
): Promise<CurrentContainer | undefined> {
  const listed = await resolver.control<{ containers?: unknown[] }>(
    "listContainers",
    {},
  );
  const row = (listed.containers ?? []).find((candidate: any) =>
    candidate?.workspaceSlug === workspaceSlug &&
    stringField(candidate?.containerName, "default") === container
  );
  if (row !== undefined) return row as CurrentContainer;
  if (container !== "default") return undefined;
  const workspaces = await resolver.control<{ workspaces?: unknown[] }>(
    "listWorkspaces",
    {},
  );
  const workspace = (workspaces.workspaces ?? []).find((candidate: any) =>
    candidate?.workspaceSlug === workspaceSlug
  ) as any;
  if (workspace === undefined) return undefined;
  return {
    mounts: Array.isArray(workspace.mounts) ? workspace.mounts : [],
    env: workspace.env,
    secretEnv: workspace.secretEnv,
  } as CurrentContainer;
}

// templateMountFact renders one staged mount. Project and volume mounts carry
// the mode the template chose (defaulting read-only); secrets and tmpfs carry
// no mode.
function templateMountFact(mount: TemplateMountInput): MountFact {
  const readOnly = mount.mode !== "read_write";
  switch (mount.kind) {
    case "tmpfs":
      return { kind: "tmpfs", source: "", destination: mount.destination };
    case "volume":
      return {
        kind: "volume",
        source: mount.volume,
        destination: mount.destination,
        readOnly,
      };
    case "secret":
      return {
        kind: "secret",
        source: mount.secret,
        destination: mount.destination,
      };
    default:
      return { kind: "project", source: mount.project, readOnly };
  }
}

// The identity of one mount for replacement: project mounts compare by project,
// volumes and secrets by name and destination, tmpfs by destination only.
function stagedMountKey(mount: TemplateMountInput): string {
  switch (mount.kind) {
    case "tmpfs":
      return `tmpfs\0${mount.destination}`;
    case "volume":
      return `volume\0${mount.volume}\0${mount.destination}`;
    case "secret":
      return `secret\0${mount.secret}\0${mount.destination}`;
    default:
      return `project\0${mount.project}`;
  }
}

function currentMountKey(mount: any): string {
  const kind = normalizeMountKind(mount?.kind);
  switch (kind) {
    case "tmpfs":
      return `tmpfs\0${stringField(mount?.destination)}`;
    case "volume":
      return `volume\0${stringField(mount?.volume)}\0${
        stringField(mount?.destination)
      }`;
    case "secret":
      return `secret\0${stringField(mount?.secret)}\0${
        stringField(mount?.destination)
      }`;
    default:
      return `project\0${stringField(mount?.projectName)}`;
  }
}

// removalCounts counts the current items absent from the staged template. A
// group the template leaves undeclared is kept by StartContainer, so its
// current values are not removed and its count stays zero.
function removalCounts(
  staged: readonly TemplateMountInput[],
  template: ContainerTemplate,
  current: CurrentContainer | undefined,
): TemplateLoadRemovals {
  if (current === undefined) {
    return { mounts: 0, env: 0, secretEnv: 0, paths: 0 };
  }
  const stagedKeys = new Set(staged.map(stagedMountKey));
  const currentMounts = Array.isArray(current.mounts) ? current.mounts : [];
  const mounts =
    currentMounts.filter((mount) => !stagedKeys.has(currentMountKey(mount)))
      .length;
  const env = removedKeys(current.env, template.spec.env);
  const secretEnv = removedKeys(current.secretEnv, template.spec.secretEnv);
  const paths = removedPaths(current.paths, template.spec.paths);
  return { mounts, env, secretEnv, paths };
}

// removedKeys counts the current keys a declared map does not name. An empty
// declared map means the group was not declared, so nothing is removed.
function removedKeys(
  current: unknown,
  declared: Readonly<Record<string, unknown>>,
): number {
  const declaredKeys = Object.keys(declared);
  if (declaredKeys.length === 0) return 0;
  const declaredSet = new Set(declaredKeys);
  return objectKeys(current).filter((key) => !declaredSet.has(key)).length;
}

// removedPaths counts the current PATH additions a declared list does not
// name. An empty list means PATH is not replaced, so nothing is removed.
function removedPaths(
  current: readonly unknown[] | undefined,
  declared: readonly string[],
): number {
  if (declared.length === 0) return 0;
  const declaredSet = new Set(declared);
  const paths = Array.isArray(current) ? current.map(String) : [];
  return paths.filter((path) => !declaredSet.has(path)).length;
}

function objectKeys(value: unknown): string[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return [];
  }
  return Object.keys(value as Record<string, unknown>);
}

function stringField(value: unknown, fallback = ""): string {
  return typeof value === "string" && value !== "" ? value : fallback;
}
