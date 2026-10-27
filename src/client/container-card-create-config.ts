// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// The draft a Create/Add dialog opens on, kept out of the React component so the
// named/default distinction can be tested. Only the workspace's default
// container forces the workspace's own project mount: that mount is what every
// tool operates on. A named draft opens with exactly the mounts it was given —
// a template's own, or the plain Add default — all of them removable.

import { withForcedProjectMount } from "../container-template.js";
import { mergeDefaultEnv } from "../container-env.js";
import type { MountInput } from "./card-protocol.js";
import { orderedEnvRecord } from "../env-rows.js";

// The port shape the create draft carries. It mirrors PortConfig, declared here
// so this module pulls in no React component.
export interface CreateDraftPort {
  port: number;
  protocol: string;
  endpoint: string;
  suggestedHostPort: number;
  hostPort: number;
}

// The part of a workspace the seeded draft reads.
export interface CreateWorkspace {
  projectName: string;
  imageId: string;
}

// The fields a create draft carries, matching the editor's ContainerConfig
// without importing the React module that owns that type.
export interface CreateDraft {
  image: string;
  env: Record<string, string>;
  mounts: readonly MountInput[];
  paths: readonly string[];
  secretEnv: Record<string, string>;
  ports: readonly CreateDraftPort[];
}

// The project mount every new container starts with; it is the pristine mount
// the draft is compared against for its dirty state.
export function initialMounts(workspace: CreateWorkspace): MountInput[] {
  return [{
    kind: "project",
    project: workspace.projectName,
    destination: "",
    mode: "read_write",
    volume: "",
    secret: "",
  }];
}

// The workspace's image (or the configured default), its own project mount, and
// the workspace's default environment. The defaults are seeded so the values a
// new container inherits are visible: a value left alone keeps the default, and
// an edited one is sent as that container's own.
export function initialConfig(
  workspace: CreateWorkspace,
  defaultImage: string,
  defaultEnv: Record<string, string>,
): CreateDraft {
  return {
    image: workspace.imageId || defaultImage,
    env: orderedEnvRecord(mergeDefaultEnv(defaultEnv, undefined)),
    mounts: initialMounts(workspace),
    paths: [],
    secretEnv: {},
    ports: [],
  };
}

// createDialogConfig is the draft the dialog actually opens on. The default
// container forces the workspace's own project mount first, keeping the mode a
// template declared for it and adding it read-write only when the template
// omitted it. A named container keeps exactly the mounts it was given, so a
// template that omits the workspace project mount opens without it.
export function createDialogConfig(
  base: CreateDraft,
  named: boolean,
  workspaceProject: string,
): CreateDraft {
  return named ? base : {
    ...base,
    mounts: withForcedProjectMount(base.mounts, workspaceProject),
  };
}
