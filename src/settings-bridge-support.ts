// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { strict as assert } from "node:assert";
import { installContainerSettings } from "./settings-bridge.js";

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
    notice: "",
    workspaces: [],
    containers: [],
    images: [],
    volumes: [],
    secrets: [],
    caches: [],
    command: null,
  };
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
  installContainerSettings(fakeContext(scope), resolver);
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
    at: 1,
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
