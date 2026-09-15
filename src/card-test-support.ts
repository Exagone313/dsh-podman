// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// Test doubles for the settings card. `installCardCommandDriver` stands in for
// the browser transport: it hands each committed command to the real
// `runCommand` and folds the real `cardSnapshot` back into the fake scope, so
// the command tests stay focused on the command-to-control mapping. The HTTP
// layer itself is covered by card-route.test.ts.

import { strict as assert } from "node:assert";
import { CONTAINER_NS, settingsSchema } from "./settings-schema.js";
import { cardSnapshot, runCommand } from "./card-route.js";

export interface FakeScope {
  value: Record<string, unknown>;
  listeners: Array<(next: any, prev: any) => void>;
  update: (patch: object) => Promise<void>;
  watch: (
    callback: (next: any, prev: any) => void | Promise<void>,
  ) => () => void;
}

export function fakeScope(initial: Record<string, unknown>): FakeScope {
  const scope: FakeScope = {
    value: { ...initial },
    listeners: [],
    async update(patch: object) {
      const prev = scope.value;
      scope.value = { ...scope.value, ...patch };
      for (const listener of [...scope.listeners]) {
        await listener(scope.value, prev);
      }
    },
    watch(callback) {
      scope.listeners.push(callback);
      return () => {
        scope.listeners = scope.listeners.filter(
          (listener) => listener !== callback,
        );
      };
    },
  };
  return scope;
}

export function fakeContext(scope: FakeScope): any {
  return {
    inject(deps: string[], callback: (sctx: any) => void): void {
      assert.deepEqual(deps, ["settings"]);
      callback({
        settings: {
          register() {
            return scope;
          },
          get() {
            return undefined;
          },
        },
      });
    },
  };
}

export function baseValue(): Record<string, unknown> {
  return {
    defaultImage: "archlinux",
    socketsRoot: "/run/dsh-podman",
    uiLocale: "",
    notice: "",
    command: null,
    workspaces: [],
    containers: [],
    images: [],
    volumes: [],
    secrets: [],
    caches: [],
  };
}

// installCardCommandDriver wires a fake settings scope to the real command
// runner and snapshot builder, standing in for the browser transport: it
// mirrors what the card does per request — run the command, then refresh the
// live snapshot and record the notice.
export function installCardCommandDriver(
  ctx: any,
  resolver: any,
  registry?: any,
): Promise<void> {
  let installed: Promise<void> = Promise.resolve();
  ctx.inject(["settings"], (sctx: any) => {
    const scope = sctx.settings.register(CONTAINER_NS, settingsSchema, {
      base: {
        defaultImage: resolver.getConfig().defaultImage,
        socketsRoot: resolver.getConfig().socketsRoot,
      },
    }) as FakeScope;
    const refresh = async (notice = ""): Promise<void> => {
      let view: Record<string, unknown> = {};
      try {
        const snapshot = await cardSnapshot(resolver, registry);
        view = {
          workspaces: snapshot.workspaces,
          containers: snapshot.containers,
          images: snapshot.images,
          volumes: snapshot.volumes,
          secrets: snapshot.secrets,
          caches: snapshot.caches,
        };
      } catch {
        // Command tests do not always stub every list call.
      }
      await scope.update({ ...view, notice });
    };
    scope.watch((next: any) => {
      resolver.setConfig({
        defaultImage: next.defaultImage,
        socketsRoot: next.socketsRoot,
      });
      const command = next.command;
      if (command === null || command === undefined) return;
      void (async () => {
        // Clear the command before running it, so the refresh below cannot
        // re-deliver it.
        await scope.update({ command: null });
        let notice = "";
        try {
          notice = await runCommand(sctx, resolver, registry, command);
        } catch (error) {
          notice = error instanceof Error ? error.message : String(error);
        }
        await refresh(notice);
      })();
    });
    installed = refresh();
  });
  return installed;
}

export async function installedMountScope(): Promise<{
  scope: FakeScope;
  calls: Array<[string, unknown]>;
}> {
  const scope = fakeScope(baseValue());
  const calls: Array<[string, unknown]> = [];
  const resolver: any = {
    getConfig: () => ({}),
    setConfig: () => {},
    async control(method: string, request: unknown) {
      calls.push([method, request]);
      if (method === "listContainers") return { containers: [] };
      if (method === "listImages") return { images: [] };
      if (method === "listWorkspaces") return { workspaces: [] };
      return {};
    },
  };
  await installCardCommandDriver(fakeContext(scope), resolver);
  await scope.update({}); // settle the queued async refresh
  await new Promise((resolve) => setImmediate(resolve));
  calls.length = 0;
  return { scope, calls };
}

export function mountCommand(
  op: string,
  mount: Record<string, string>,
): Record<string, unknown> {
  return {
    op,
    workspace: "w1",
    container: "web",
    image: "",
    mount: {
      kind: "",
      project: "",
      destination: "",
      mode: "",
      volume: "",
      secret: "",
      ...mount,
    },
  };
}
