// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import {
  handleWorkingDirectoryAccess,
  workingCwd,
} from "./working-directory.js";
import { WorkingDirectoryUnreachableError } from "./workspace-binding.js";

function fakeContext(current: string | null) {
  return {
    get(name: string) {
      return name === "workingDirectory"
        ? {
          get: () => current,
        }
        : undefined;
    },
    logger: { warn: () => {} },
  };
}

function fakeSession(headerCwd: string, appended: string[]) {
  return {
    header: { cwd: headerCwd },
    append: (_type: string, data: { cwd: string }) => {
      appended.push(data.cwd);
      return [];
    },
  };
}

const HEADER = "/projects/team";
const MOUNTED = "/projects/other";

test("workingCwd prefers the harness projection and falls back to the header", () => {
  const session = { header: { cwd: HEADER } };
  assert.equal(
    workingCwd(fakeContext(MOUNTED), { agent: { session } }),
    MOUNTED,
  );
  assert.equal(workingCwd(fakeContext(null), { agent: { session } }), HEADER);
  assert.equal(workingCwd(undefined, { agent: { session } }), HEADER);
});

test("ensure records a mounted working directory", async () => {
  const appended: string[] = [];
  const session = fakeSession(HEADER, appended);
  const recorded: unknown[] = [];
  const binding = { defaultCwd: MOUNTED };
  const resolver = {
    resolveSessionDirectory: async (
      header: string,
      target: string,
    ) => {
      assert.equal(header, HEADER);
      assert.equal(target, MOUNTED);
      return binding;
    },
    recordMountedCwd: (cwd: unknown) => recorded.push(cwd),
  };
  let nextCalls = 0;
  const result = await handleWorkingDirectoryAccess(
    fakeContext(MOUNTED),
    resolver as never,
    { agent: { session }, path: null, signal: new AbortController().signal },
    async () => {
      nextCalls++;
      return MOUNTED;
    },
  );
  assert.equal(result, MOUNTED);
  assert.equal(nextCalls, 1);
  assert.deepEqual(recorded, [MOUNTED]);
  assert.deepEqual(appended, []);
});

test("ensure restores the header when the persisted directory is unmounted", async () => {
  const appended: string[] = [];
  const session = fakeSession(HEADER, appended);
  const resolver = {
    resolveSessionDirectory: async () => {
      throw new WorkingDirectoryUnreachableError("not mounted");
    },
    recordMountedCwd: () => {},
  };
  const result = await handleWorkingDirectoryAccess(
    fakeContext("/tmp/gone"),
    resolver as never,
    { agent: { session }, path: null, signal: new AbortController().signal },
    async () => HEADER,
  );
  assert.equal(result, HEADER);
  assert.deepEqual(appended, [HEADER]);
});

test("ensure leaves the original project to the harness service", async () => {
  const appended: string[] = [];
  const session = fakeSession(HEADER, appended);
  const resolver = {
    resolveSessionDirectory: async () => {
      throw new WorkingDirectoryUnreachableError("not mounted");
    },
    recordMountedCwd: () => {},
  };
  let nextCalls = 0;
  const result = await handleWorkingDirectoryAccess(
    fakeContext(HEADER),
    resolver as never,
    {
      agent: { session },
      path: null,
      signal: new AbortController().signal,
    },
    async () => {
      nextCalls++;
      return HEADER;
    },
  );
  assert.equal(result, HEADER);
  assert.equal(nextCalls, 1);
  assert.deepEqual(appended, []);
});

test("set validates and records the target, rejecting an unmounted path", async () => {
  const appended: string[] = [];
  const session = fakeSession(HEADER, appended);
  const recorded: unknown[] = [];
  const resolver = {
    resolveSessionDirectory: async (
      _header: string,
      target: string,
    ) => {
      if (target !== MOUNTED) {
        throw new WorkingDirectoryUnreachableError("not mounted");
      }
      return { defaultCwd: target };
    },
    recordMountedCwd: (cwd: unknown) => recorded.push(cwd),
  };
  let nextCalls = 0;
  const result = await handleWorkingDirectoryAccess(
    fakeContext(HEADER),
    resolver as never,
    {
      agent: { session },
      path: MOUNTED,
      signal: new AbortController().signal,
    },
    async () => {
      nextCalls++;
      return MOUNTED;
    },
  );
  assert.equal(result, MOUNTED);
  assert.equal(nextCalls, 1);
  assert.deepEqual(recorded, [MOUNTED]);
  assert.deepEqual(appended, []);

  await assert.rejects(
    () =>
      handleWorkingDirectoryAccess(
        fakeContext(HEADER),
        resolver as never,
        {
          agent: { session },
          path: "/tmp/gone",
          signal: new AbortController().signal,
        },
        async () => {
          nextCalls++;
          return "/tmp/gone";
        },
      ),
    WorkingDirectoryUnreachableError,
  );
  assert.equal(nextCalls, 1);
});
