// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { CARD_PATH } from "./client/card-protocol.js";
import { registerCardRoute } from "./card-route.js";

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
      if (method === "getVersion") return { version: "9.9.9", commit: "abc" };
      if (method === "listContainers") return { containers: [{ containerName: "c1" }] };
      if (method === "listImages") return { images: [{ imageId: "img1" }] };
      if (method === "listWorkspaces") return { workspaces: [] };
      if (method === "listVolumes") return { volumes: [{ name: "data" }] };
      if (method === "listSecrets") return { secrets: [{ name: "s1" }] };
      if (method === "listCaches") {
        return { caches: [{ manager: "pacman", files: 1, bytes: "1024" }] };
      }
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
      assert.deepEqual(deps, ["connection"]);
      callback({
        connection: {
          fetch: {
            register(route: any) {
              // Mirror the harness's assertFetchRoute: the route must live
              // under the API channel, or the registration is refused.
              if (!route.path.startsWith("/api/")) {
                throw new Error(
                  `connection: invalid exact Fetch route ${JSON.stringify(route.path)}`,
                );
              }
              routes.push(route);
              return async () => {};
            },
          },
        },
      });
    },
  };
  return { ctx, routes };
}

function cardRequest(init?: RequestInit): Request {
  return new Request(`http://dsh.test${CARD_PATH}`, init);
}

test("registerCardRoute registers the card's exact fetch route", () => {
  assert.ok(CARD_PATH.startsWith("/api/"), "the route must live under the API channel");
  const { resolver } = fakeResolver();
  const { ctx, routes } = fakeRouteContext();
  registerCardRoute(ctx, resolver);
  assert.equal(routes.length, 1);
  assert.equal(routes[0].path, CARD_PATH);
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
    [
      "getVersion",
      "listContainers",
      "listImages",
      "listWorkspaces",
      "listVolumes",
      "listSecrets",
      "listCaches",
    ],
  );
  assert.equal(typeof snapshot.dshVersion, "string");
  assert.equal(snapshot.orchestratorVersion, "9.9.9");
  assert.equal(
    snapshot.versionState,
    "major-mismatch",
    "a differing major is surfaced on the card",
  );
});

test("a refused control call reports the version mismatch instead of an empty snapshot", async () => {
  const { resolver } = fakeResolver();
  const refusal = new Error("plugin is incompatible");
  (refusal as { code?: string }).code = "FailedPrecondition";
  resolver.control = async (method: string) => {
    if (method === "getVersion") return { version: "9.9.9", commit: "abc" };
    throw refusal;
  };
  const { ctx, routes } = fakeRouteContext();
  registerCardRoute(ctx, resolver);
  const response = await routes[0].fetch(cardRequest());
  assert.equal(response.status, 200);
  const snapshot = (await response.json()) as any;
  assert.equal(typeof snapshot.dshVersion, "string");
  assert.equal(snapshot.orchestratorVersion, "9.9.9");
  assert.equal(snapshot.versionState, "major-mismatch");
  assert.deepEqual(snapshot.containers, []);
  assert.deepEqual(snapshot.workspaces, []);
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
