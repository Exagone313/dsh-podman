// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// The load-template popup's wire shapes. The route is served on the same
// authenticated connection as the settings card, but the template operations
// return structured results (a parsed template, its image plan, apply warnings)
// rather than the card's one-notice command response.

import type { ContainerView } from "./card-protocol.js";
import type {
  ContainerTemplate,
  TemplateImagePlan,
  TemplateWarning,
} from "../container-template.js";

export const TEMPLATES_PATH = "/api/podman/templates";

export interface TemplateEntryView {
  // The file name, including its .yml/.yaml suffix.
  name: string;
  // The file's absolute host path, which the template image id hashes.
  path: string;
  yaml: string;
}

export interface TemplateInspectionView {
  name: string;
  path: string;
  // The canonical rendering, so an upload previews exactly what it means.
  yaml: string;
  template: ContainerTemplate;
  imageId: string;
  image: TemplateImagePlan;
  warnings: TemplateWarning[];
}

export interface TemplateBuildView extends TemplateInspectionView {
  built: boolean;
  removed: boolean;
}

export interface TemplateApplyView {
  container: ContainerView;
  imageId: string;
  warnings: string[];
}

export interface TemplateInspectRequest {
  op: "inspect";
  workspace: string;
  name: string;
  // The uploaded document; omitted to read the project's own file.
  yaml?: string;
}

export interface TemplateBuildRequest {
  op: "build";
  workspace: string;
  name: string;
  yaml?: string;
  // Rebuild a template image the plan already considers current; absent or
  // false reuses a matching image.
  force?: boolean;
}

export interface TemplateApplyRequest {
  op: "apply";
  workspace: string;
  name: string;
  yaml?: string;
  // The named container to create; omitted means the default container.
  container?: string;
}

export interface TemplatePublishRequest {
  op: "publish";
  workspace: string;
  name: string;
  yaml?: string;
  // The existing container whose template-sourced replace just succeeded.
  container: string;
}

export interface TemplatePublishView {
  // Ports that could not be published. A gateway failure is a warning: the
  // container itself was already updated by the edit-apply path.
  warnings: string[];
}

export type TemplateRequest =
  | TemplateInspectRequest
  | TemplateBuildRequest
  | TemplateApplyRequest
  | TemplatePublishRequest;

export interface TemplatesListing {
  templates: TemplateEntryView[];
}
