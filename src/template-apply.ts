// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// Applying a container template: one create-or-replace request carrying the
// template's image, environment, secrets, mounts and PATH additions, then the
// template's ports published after the container exists. The workspace's own
// project mount is always added, so a loaded template can never lock the
// session out of its own project; the template chooses its mode when it declares
// the mount, and it is read-write only when the template omits it.
//
// A workspace with no container gets its default container created. An existing
// container is replaced through StartContainer: the mounts it is given replace
// the current ones, the environment, secret environment and PATH additions the
// template declares replace those groups, groups it leaves undeclared keep their
// values, and published ports are kept.

import {
  type ContainerTemplate,
  templateMountInputs,
} from "./container-template.js";
import { grpc } from "./grpc/runtime-client.js";
import { mountInputToProto } from "./mount-input.js";
import { portProtocolToProto } from "./publish-port.js";
import type { WorkspaceResolver } from "./workspace-binding.js";

export interface TemplateApplyOptions {
  workspaceSlug: string;
  projectName: string;
  template: ContainerTemplate;
  // The image ensured for the template: a base image, or its template image.
  imageId: string;
  // The target logical container name. Omitted means the default container.
  container?: string;
}

export interface TemplateApplyResult {
  // The orchestrator's container row, unprojected; callers rebuild the public
  // shape with publicContainerResult.
  row: any;
  // The container the template was applied to.
  container: string;
  // Ports that could not be published. Publishing happens after creation, so a
  // gateway failure never turns a created container into a failed load.
  warnings: string[];
}

export interface TemplatePortsOptions {
  workspaceSlug: string;
  container: string;
  template: ContainerTemplate;
}

// applyContainerTemplate runs the one create path the load popup and the
// template load tool share.
export async function applyContainerTemplate(
  resolver: WorkspaceResolver,
  options: TemplateApplyOptions,
): Promise<TemplateApplyResult> {
  const { template } = options;
  const projectsRoot = resolver.getConfig().projectsRoot;
  const mounts = templateMountInputs(template, options.projectName).map(
    (mount) => mountInputToProto(mount, projectsRoot),
  );
  const payload: Record<string, unknown> = {
    workspaceSlug: options.workspaceSlug,
    imageId: options.imageId,
  };
  if (mounts.length > 0) payload.mounts = mounts;
  if (Object.keys(template.spec.env).length > 0) {
    payload.env = template.spec.env;
  }
  if (Object.keys(template.spec.secretEnv).length > 0) {
    payload.secretEnv = template.spec.secretEnv;
  }
  if (template.spec.paths.length > 0) payload.paths = template.spec.paths;

  const target = options.container ?? "default";
  const exists = await workspaceExists(resolver, options.workspaceSlug);
  let row: any;
  if (!exists) {
    if (target !== "default") {
      throw new Error(
        `workspace ${
          JSON.stringify(options.workspaceSlug)
        } has no container yet: load the template without a container name to create its default container`,
      );
    }
    row = await resolver.control("createWorkspace", {
      ...payload,
      projectName: options.projectName,
    });
  } else {
    // StartContainer replaces an existing container in place: the payload's
    // mounts and declared groups replace the current ones and published ports
    // are kept.
    row = await resolver.control("startContainer", {
      ...payload,
      container: target,
    });
  }

  const warnings = await publishTemplatePorts(resolver, {
    workspaceSlug: options.workspaceSlug,
    container: target,
    template,
  });
  return { row, container: target, warnings };
}

// publishTemplatePorts publishes every port a template declares on an existing
// container. It is what a template-sourced replace does after the edit editor's
// Apply succeeded; a port the gateway refuses is a warning, never a failure.
export async function publishTemplatePorts(
  resolver: WorkspaceResolver,
  options: TemplatePortsOptions,
): Promise<string[]> {
  const warnings: string[] = [];
  for (const port of options.template.spec.ports) {
    const request: Record<string, unknown> = {
      workspaceSlug: options.workspaceSlug,
      container: options.container,
      port: port.container,
      protocol: portProtocolToProto("tcp"),
    };
    if (port.host !== undefined) request.suggestedHostPort = port.host;
    try {
      await resolver.control("publishPort", request);
    } catch (error) {
      warnings.push(
        `port ${port.container}/tcp: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return warnings;
}

async function workspaceExists(
  resolver: WorkspaceResolver,
  slug: string,
): Promise<boolean> {
  try {
    await resolver.control("describeWorkspace", { workspaceSlug: slug });
    return true;
  } catch (error) {
    if ((error as { code?: unknown })?.code === grpc.status.NOT_FOUND) {
      return false;
    }
    throw error;
  }
}
