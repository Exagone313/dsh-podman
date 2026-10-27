// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// Template images: a loaded template either refers to one of the fixed base
// images or to a deterministic custom image built from it. This module is the
// one place that turns that plan into orchestrator calls, so the load popup, the
// agent tool and the export path agree on when a build runs and which image a
// container names.

import {
  type ContainerTemplate,
  effectiveImage,
  templateImageId,
  type TemplateImagePlan,
  templateImagePlan,
} from "./container-template.js";
import type { WorkspaceResolver } from "./workspace-binding.js";

export interface TemplateImageResult {
  // The short image id a container names: a base image, or this template's
  // deterministic custom image.
  imageId: string;
  // The plan the decision was taken from, carried so a caller can report why a
  // build ran without recomputing it.
  plan: TemplateImagePlan;
  // Whether this call built the image (false when it was already current).
  built: boolean;
  // Whether a stale template image that is no longer needed was removed.
  removed: boolean;
  // The stale image id the template no longer uses, when it had one.
  supersededImageId?: string;
}

// ensureTemplateImage makes the image a template needs available:
//
// - a base-only template names the base and provisions it when the plan says
//   it is missing, through the same control the settings image row uses;
// - a template image whose packages or parent differ from the listed image is
//   rebuilt with the template's package list;
// - a matching image is reused, unless the caller forces a rebuild.
//
// A template that no longer needs its custom image (all of its packages turned
// out to be base built-ins) has that image removed once it is unreferenced. An
// image a container still uses is left alone: removeImage refuses it, and that
// refusal is the "still referenced" signal rather than a load failure.
export async function ensureTemplateImage(
  resolver: WorkspaceResolver,
  options: {
    name: string;
    path: string;
    template: ContainerTemplate;
    // Rebuild a template image that the plan already considers current. The
    // popup's Rebuild action sets this; a base-only template rebuilds (or pulls)
    // its base instead, even though the plan says that base is present.
    force?: boolean;
    images?: readonly {
      imageId: string;
      parent: string;
      packages: readonly string[];
      status?: string;
      // Whether the base tag comes from a public registry: the deployment then
      // pulls a base instead of building it locally, as the settings row does.
      basePublic?: boolean;
    }[];
  },
): Promise<TemplateImageResult> {
  const effective = effectiveImage(options.template);
  const templateId = await templateImageId(options.name, options.path);
  const images = options.images ??
    (((await resolver.control("listImages", {})) as { images?: unknown[] })
      .images ?? []) as readonly {
        imageId: string;
        parent: string;
        packages: readonly string[];
        status?: string;
        basePublic?: boolean;
      }[];
  const plan = templateImagePlan(effective, templateId, images);
  if (effective.kind === "base") {
    const listed = images.some((image) => image.imageId === templateId);
    const removed = listed
      ? await removeImageIfUnreferenced(resolver, templateId)
      : false;
    // The base itself is the image: a plan that finds it missing gets it built,
    // and a Rebuild provisions it again. The control is the one the settings
    // row would run, chosen the same way: a deployment that publishes bases
    // pulls them, a local deployment rebuilds them. A refusal (for example a
    // base still used by a container) propagates as the build failure.
    const built = plan.needsBuild || options.force === true;
    if (built) {
      const baseRow = images.find((image) => image.imageId === effective.base);
      if (baseRow?.basePublic === true) {
        await resolver.control("pullBaseImage", { name: effective.base });
      } else {
        await resolver.control("rebuildBaseImage", { name: effective.base });
      }
    }
    return {
      imageId: effective.base,
      plan,
      built,
      removed,
      ...(listed ? { supersededImageId: templateId } : {}),
    };
  }
  // A current image is reused unless the caller asked for a forced rebuild;
  // an image the plan already says must be built is built either way.
  if (!plan.needsBuild && options.force !== true) {
    return { imageId: templateId, plan, built: false, removed: false };
  }
  await resolver.control("buildImage", {
    imageId: templateId,
    parent: effective.base,
    packages: effective.packages,
  });
  return { imageId: templateId, plan, built: true, removed: false };
}

// removeImageIfUnreferenced deletes an image whose template no longer needs it.
// A refusal means a container (or another image) still references it, which is
// not an error: the image is simply kept until the reference goes away.
async function removeImageIfUnreferenced(
  resolver: WorkspaceResolver,
  imageId: string,
): Promise<boolean> {
  try {
    await resolver.control("removeImage", { imageId });
    return true;
  } catch {
    return false;
  }
}
