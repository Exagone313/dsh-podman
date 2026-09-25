// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import { EXPECTED_TOOLS } from "./test-support.js";
import { imageRemoveParameters, toolHandlers, TOOLS } from "./index.js";

test("tool set covers the image and container surface", () => {
  assert.deepEqual(
    TOOLS.map((tool) => tool.name).sort(),
    [...EXPECTED_TOOLS].sort(),
  );
});

test("image_build requires imageId, parent and packages", () => {
  const tool = TOOLS.find((entry) => entry.name === "image_build");
  assert.ok(tool, "image_build registered");
  assert.equal(tool!.approval, true, "image_build must require approval");
  assert.deepEqual(tool!.parameters.required, ["imageId", "parent", "packages"]);
  assert.equal(tool!.parameters.properties.imageId.description, "Image short name.");
  assert.ok(
    tool!.parameters.properties.parent.description.includes(
      "Short name of the parent image",
    ),
    "parent must be documented as a short name",
  );
});

test("image_remove is registered, requires approval and requires imageId", () => {
  const tool = TOOLS.find((entry) => entry.name === "image_remove");
  assert.ok(tool, "image_remove registered");
  assert.equal(tool!.approval, true, "image_remove must require approval");
  assert.equal(tool!.parameters.type, "object", "image_remove type");
  assert.equal(typeof tool!.parameters.properties, "object");
  assert.deepEqual(tool!.parameters.required, ["imageId"]);
  assert.equal(tool!.parameters.properties.imageId.type, "string");
  assert.deepEqual(imageRemoveParameters, tool!.parameters);
});

test("image_list returns image objects", async () => {
  const resolver = {
    control: async () => ({
      images: [
        {
          imageId: "archlinux",
          isBase: true,
          status: "built",
          primitive: "docker.io/library/archlinux:latest",
          packageManager: "pacman",
          basePublic: false,
        },
        {
          imageId: "dev",
          parent: "ubuntu",
          status: "built",
          packages: ["git"],
          packageManager: "apt",
        },
      ],
    }),
  } as never;
  const out = await toolHandlers.image_list(resolver, {}, {});
  assert.deepEqual(out, [
    {
      imageId: "archlinux",
      isBase: true,
      status: "built",
      primitive: "docker.io/library/archlinux:latest",
      packageManager: "pacman",
      basePublic: false,
      packages: [],
    },
    {
      imageId: "dev",
      parent: "ubuntu",
      isBase: false,
      status: "built",
      packageManager: "apt",
      basePublic: false,
      packages: ["git"],
    },
  ]);
});

test("image_rebuild_all returns rebuilt and skipped arrays", async () => {
  const resolver = {
    control: async () => ({ rebuilt: ["archlinux", "dev"], skipped: ["broken"] }),
  } as never;
  const out = await toolHandlers.image_rebuild_all(resolver, {}, {});
  assert.deepEqual(out, { rebuilt: ["archlinux", "dev"], skipped: ["broken"] });
});
