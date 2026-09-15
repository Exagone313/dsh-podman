// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { CARD_ROUTE } from "./client/card-protocol.js";
import { registerCardRoute } from "./card-route.js";
import { installContainerPreferences } from "./preferences.js";

function fakeResolver(): { resolver: any; calls: Array<[string, unknown]> } {
  const calls: Array<[string, unknown]> = [];
  const resolver: any = {
    getConfig: () => ({
      defaultImage: "archlinux",
      socketsRoot: "/run/dsh-podman",
      projectsRoot: "/projects",
    }),
    setConfig: () => {},
    async control(method: string, request: unknown) {
      calls.push([method, request]);
      if (method === "listContainers") return { containers: [{ containerName: "c1" }] };
      if (method === "listImages") return { images: [{ imageId: "img1" }] };
      if (method === "listWorkspaces") return { workspaces: [] };
      if (method === "listVolumes") return { volumes: [{ name: "data" }] };
      if (method === "listSecrets") return { secrets: [{ name: "s1" }] };
      if (method === "listCaches") return { caches: [{ manager: "pacman", files: 1, bytes: "1024" }] };
      if (method === "cleanCaches") return { removedFiles: 2 };
      if (method === "removeContainer") return {};
      return {};
    },
  };
  return { resolver, calls };
}

function fakeRouteContext(): { ctx: any; routes: any[] } {
  const routes: any[] = [];
  const ctx = {
    inject(deps: string[], callback: (c: any) => void): void {
      assert.deepEqual(deps, ["connection", "settings"]);
      callback({
        connection: {
          fetch: {
            register(route: any) {
              routes.push(route);
              return async () => {};
            },
          },
        },
        settings: {
          register: () => ({ watch: () => () => {} }),
          get: () => undefined,
        },
      });
    },
  };
  return { ctx, routes };
}

function cardRequest(init?: RequestInit): Request {
  return new Request(`http://dsh.test/api${CARD_ROUTE}`, init);
}

test("registerCardRoute registers the card's exact fetch route", () => {
  const { resolver } = fakeResolver();
  const { ctx, routes } = fakeRouteContext();
  registerCardRoute(ctx, resolver);
  assert.equal(routes.length, 1);
  assert.equal(routes[0].path, CARD_ROUTE);
  assert.deepEqual(routes[0].methods, ["GET", "POST"]);
  assert.equal(routes[0].requestBody, "buffered");
});

test("the card route serves the live snapshot on GET", async () => {
  const { resolver, calls } = fakeResolver();
  const { ctx, routes } = fakeRouteContext();
  registerCardRoute(ctx, resolver);
  const response = await routes[0].fetch(cardRequest());
  assert.equal(response.status, 200);
  const snapshot = (await response.json()) as any;
  assert.equal(snapshot.projectsRoot, "/projects");
  assert.equal(snapshot.containers.length, 1);
  assert.equal(snapshot.images.length, 1);
  assert.deepEqual(snapshot.volumes, [{ name: "data" }]);
  assert.deepEqual(snapshot.secrets, [{ name: "s1" }]);
  assert.equal(snapshot.caches[0].bytes, 1024);
  assert.deepEqual(
    calls.map(([method]) => method),
    ["listContainers", "listImages", "listWorkspaces", "listVolumes", "listSecrets", "listCaches"],
  );
});

test("the card route runs one command per POST and returns its notice", async () => {
  const { resolver, calls } = fakeResolver();
  const { ctx, routes } = fakeRouteContext();
  registerCardRoute(ctx, resolver);

  const remove = await routes[0].fetch(cardRequest({
    method: "POST",
    body: JSON.stringify({ command: { op: "remove", workspace: "w1" } }),
  }));
  assert.equal(remove.status, 200);
  assert.deepEqual(await remove.json(), {});
  assert.deepEqual(calls.find(([method]) => method === "removeContainer")?.[1], {
    workspaceSlug: "w1",
  });

  const clean = await routes[0].fetch(cardRequest({
    method: "POST",
    body: JSON.stringify({ command: { op: "cache_clean", cacheMode: "all" } }),
  }));
  assert.equal(clean.status, 200);
  assert.deepEqual(await clean.json(), { notice: "removed 2 cached files" });
});

test("the card route rejects a missing or unknown command", async () => {
  const { resolver } = fakeResolver();
  const { ctx, routes } = fakeRouteContext();
  registerCardRoute(ctx, resolver);

  const missing = await routes[0].fetch(cardRequest({ method: "POST", body: "{}" }));
  assert.equal(missing.status, 400);
  const unknown = await routes[0].fetch(cardRequest({
    method: "POST",
    body: JSON.stringify({ command: { op: "nope" } }),
  }));
  assert.equal(unknown.status, 400);
  const malformed = await routes[0].fetch(cardRequest({ method: "POST", body: "not json" }));
  assert.equal(malformed.status, 400);
  const wrongMethod = await routes[0].fetch(cardRequest({ method: "DELETE" }));
  assert.equal(wrongMethod.status, 405);
});

test("the card route reports a failed command as an error", async () => {
  const resolver: any = {
    getConfig: () => ({ projectsRoot: "/projects" }),
    setConfig: () => {},
    async control() {
      throw new Error("control plane unavailable");
    },
  };
  const { ctx, routes } = fakeRouteContext();
  registerCardRoute(ctx, resolver);
  const response = await routes[0].fetch(cardRequest({
    method: "POST",
    body: JSON.stringify({ command: { op: "remove", workspace: "w1" } }),
  }));
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "control plane unavailable" });
});

test("installContainerPreferences seeds the base and syncs the resolver config", () => {
  let base: any;
  let watcher: ((next: any) => void) | undefined;
  const ctx = {
    inject(deps: string[], callback: (c: any) => void): void {
      assert.deepEqual(deps, ["settings"]);
      callback({
        settings: {
          register(_ns: string, _schema: unknown, options: { base: any }) {
            base = options.base;
            return {
              watch(callback: (next: any) => void) {
                watcher = callback;
                return () => {};
              },
            };
          },
        },
      });
    },
  };
  const configs: Array<Record<string, unknown>> = [];
  const resolver: any = {
    getConfig: () => ({ defaultImage: "archlinux", socketsRoot: "/run/dsh-podman" }),
    setConfig: (patch: Record<string, unknown>) => configs.push(patch),
  };
  installContainerPreferences(ctx, resolver);
  assert.deepEqual(base, { defaultImage: "archlinux", socketsRoot: "/run/dsh-podman" });
  assert.ok(watcher !== undefined);
  watcher({ defaultImage: "ubuntu", socketsRoot: "/run/other" });
  assert.deepEqual(configs, [{ defaultImage: "ubuntu", socketsRoot: "/run/other" }]);
});
