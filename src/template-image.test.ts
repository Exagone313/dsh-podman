// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import {
  parseContainerTemplate,
  templateImageId,
} from "./container-template.js";
import { ensureTemplateImage } from "./template-image.js";

function fakeResolver(
  images: readonly any[],
  options: { removeFails?: boolean; rebuildFails?: boolean } = {},
): { resolver: any; calls: Array<[string, unknown]> } {
  const calls: Array<[string, unknown]> = [];
  const resolver = {
    async control(method: string, request: unknown) {
      calls.push([method, request]);
      if (method === "listImages") return { images: [...images] };
      if (method === "removeImage" && options.removeFails) {
        throw Object.assign(new Error("image is in use"), {
          code: "FailedPrecondition",
        });
      }
      if (method === "rebuildBaseImage" && options.rebuildFails) {
        throw new Error("base rebuild failed");
      }
      return {};
    },
  };
  return { resolver: resolver as never, calls };
}

// The base record listImages returns for a provisioned ubuntu base.
const BASE_ROW = {
  imageId: "ubuntu",
  parent: "",
  packages: [],
  status: "built",
  builtAt: "2026-10-20T14:16:39Z",
  basePublic: false,
};

const BASE_TEMPLATE = parseContainerTemplate(`version: 1
kind: dsh-podman/container-template
spec:
  image: ubuntu
`);

const CUSTOM_TEMPLATE = parseContainerTemplate(`version: 1
kind: dsh-podman/container-template
spec:
  imageTemplate:
    base: ubuntu
    packages: [neovim, yq]
`);

test("a base-only template builds a base the plan finds missing", async () => {
  const { resolver, calls } = fakeResolver([]);
  const result = await ensureTemplateImage(resolver, {
    name: "web",
    path: "/projects/app/.dsh-podman/web.yml",
    template: BASE_TEMPLATE,
  });
  assert.equal(result.imageId, "ubuntu");
  assert.equal(result.built, true);
  assert.equal(result.removed, false);
  assert.deepEqual(calls, [
    ["listImages", {}],
    ["rebuildBaseImage", { name: "ubuntu" }],
  ]);
});

test("a base-only template removes the superseded template image once unreferenced", async () => {
  const id = await templateImageId(
    "web",
    "/projects/app/.dsh-podman/web.yml",
  );
  const { resolver, calls } = fakeResolver([
    BASE_ROW,
    { imageId: id, parent: "ubuntu", packages: ["neovim"] },
  ]);
  const result = await ensureTemplateImage(resolver, {
    name: "web",
    path: "/projects/app/.dsh-podman/web.yml",
    template: BASE_TEMPLATE,
  });
  assert.equal(result.imageId, "ubuntu");
  assert.equal(result.built, false);
  assert.equal(result.removed, true);
  assert.equal(result.supersededImageId, id);
  assert.deepEqual(calls.map(([method]) => method), [
    "listImages",
    "removeImage",
  ]);
  assert.deepEqual(calls[1][1], { imageId: id });
});

test("a superseded image still in use is kept, not reported as a failure", async () => {
  const id = await templateImageId(
    "web",
    "/projects/app/.dsh-podman/web.yml",
  );
  const { resolver } = fakeResolver(
    [
      BASE_ROW,
      { imageId: id, parent: "ubuntu", packages: ["neovim"] },
    ],
    { removeFails: true },
  );
  const result = await ensureTemplateImage(resolver, {
    name: "web",
    path: "/projects/app/.dsh-podman/web.yml",
    template: BASE_TEMPLATE,
  });
  assert.equal(result.removed, false);
  assert.equal(result.imageId, "ubuntu");
  assert.equal(result.built, false);
});

test("a missing template image is built with its canonical package list", async () => {
  const id = await templateImageId(
    "web",
    "/projects/app/.dsh-podman/web.yml",
  );
  const { resolver, calls } = fakeResolver([]);
  const result = await ensureTemplateImage(resolver, {
    name: "web",
    path: "/projects/app/.dsh-podman/web.yml",
    template: CUSTOM_TEMPLATE,
  });
  assert.equal(result.imageId, id);
  assert.equal(result.built, true);
  assert.deepEqual(calls, [
    ["listImages", {}],
    ["buildImage", {
      imageId: id,
      parent: "ubuntu",
      packages: ["neovim", "yq"],
    }],
  ]);
});

test("a matching image is reused, and a changed package list is rebuilt", async () => {
  const id = await templateImageId(
    "web",
    "/projects/app/.dsh-podman/web.yml",
  );
  const matching = fakeResolver([
    { imageId: id, parent: "ubuntu", packages: ["yq", "neovim"] },
  ]);
  const reused = await ensureTemplateImage(matching.resolver, {
    name: "web",
    path: "/projects/app/.dsh-podman/web.yml",
    template: CUSTOM_TEMPLATE,
    images: [{ imageId: id, parent: "ubuntu", packages: ["neovim", "yq"] }],
  });
  assert.equal(reused.built, false);
  assert.deepEqual(matching.calls, []);

  const changed = fakeResolver([
    { imageId: id, parent: "ubuntu", packages: ["neovim"] },
  ]);
  const rebuilt = await ensureTemplateImage(changed.resolver, {
    name: "web",
    path: "/projects/app/.dsh-podman/web.yml",
    template: CUSTOM_TEMPLATE,
    images: [{ imageId: id, parent: "ubuntu", packages: ["neovim"] }],
  });
  assert.equal(rebuilt.built, true);
  assert.deepEqual(changed.calls.map(([method]) => method), ["buildImage"]);
});

test("a forced build rebuilds a current custom image", async () => {
  const id = await templateImageId(
    "web",
    "/projects/app/.dsh-podman/web.yml",
  );
  // The image matches its recipe, so an unforced call would reuse it.
  const current = fakeResolver([
    { imageId: id, parent: "ubuntu", packages: ["neovim", "yq"] },
  ]);
  const forced = await ensureTemplateImage(current.resolver, {
    name: "web",
    path: "/projects/app/.dsh-podman/web.yml",
    template: CUSTOM_TEMPLATE,
    force: true,
    images: [{ imageId: id, parent: "ubuntu", packages: ["neovim", "yq"] }],
  });
  assert.equal(forced.built, true);
  assert.deepEqual(current.calls, [
    ["buildImage", {
      imageId: id,
      parent: "ubuntu",
      packages: ["neovim", "yq"],
    }],
  ]);
});

test("a present base is reused unless the caller forces a rebuild", async () => {
  // The base record is present, so an unforced call leaves it alone.
  const reused = fakeResolver([BASE_ROW]);
  const reusedResult = await ensureTemplateImage(reused.resolver, {
    name: "web",
    path: "/projects/app/.dsh-podman/web.yml",
    template: BASE_TEMPLATE,
    images: [BASE_ROW],
  });
  assert.equal(reusedResult.imageId, "ubuntu");
  assert.equal(reusedResult.built, false);
  assert.deepEqual(reused.calls, []);

  // The popup's Rebuild action forces the same present base to be rebuilt,
  // through the settings row's own control.
  const forced = fakeResolver([BASE_ROW]);
  const forcedResult = await ensureTemplateImage(forced.resolver, {
    name: "web",
    path: "/projects/app/.dsh-podman/web.yml",
    template: BASE_TEMPLATE,
    force: true,
    images: [BASE_ROW],
  });
  assert.equal(forcedResult.imageId, "ubuntu");
  assert.equal(forcedResult.built, true);
  assert.deepEqual(forced.calls, [
    ["rebuildBaseImage", { name: "ubuntu" }],
  ]);
});

test("a base a public deployment pulls is pulled instead of built", async () => {
  // A base record that says the deployment publishes bases: the missing base is
  // pulled, exactly as BaseImageRow's Pull action would.
  const missing = {
    ...BASE_ROW,
    status: "missing",
    builtAt: "",
    basePublic: true,
  };
  const pulled = fakeResolver([missing]);
  const pulledResult = await ensureTemplateImage(pulled.resolver, {
    name: "web",
    path: "/projects/app/.dsh-podman/web.yml",
    template: BASE_TEMPLATE,
    images: [missing],
  });
  assert.equal(pulledResult.built, true);
  assert.deepEqual(pulled.calls, [
    ["pullBaseImage", { name: "ubuntu" }],
  ]);

  // A pulled base counts as present, and forcing it pulls again.
  const present = { ...BASE_ROW, status: "pulled", basePublic: true };
  const refreshed = fakeResolver([present]);
  const refreshedResult = await ensureTemplateImage(refreshed.resolver, {
    name: "web",
    path: "/projects/app/.dsh-podman/web.yml",
    template: BASE_TEMPLATE,
    force: true,
    images: [present],
  });
  assert.equal(refreshedResult.built, true);
  assert.deepEqual(refreshed.calls, [
    ["pullBaseImage", { name: "ubuntu" }],
  ]);
});

test("a base control failure propagates as a build failure", async () => {
  const { resolver } = fakeResolver([], { rebuildFails: true });
  await assert.rejects(
    () =>
      ensureTemplateImage(resolver, {
        name: "web",
        path: "/projects/app/.dsh-podman/web.yml",
        template: BASE_TEMPLATE,
      }),
    /base rebuild failed/,
  );
});
