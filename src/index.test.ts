// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import {
  remoteArgv,
  outputReader,
  createSubprocessProvider,
  createFilesystemProvider,
  TOOLS,
} from "./index.js";

test("remoteArgv remaps ripgrep onto the guest path", () => {
  assert.deepEqual(remoteArgv(["rg", "-n", "foo"]), [
    "/usr/bin/rg",
    "-n",
    "foo",
  ]);
  assert.deepEqual(remoteArgv(["/usr/bin/rg", "-l", "x"]), [
    "/usr/bin/rg",
    "-l",
    "x",
  ]);
});

test("remoteArgv unwraps landlock-run wrappers", () => {
  assert.deepEqual(remoteArgv(["landlock-run", "--", "/usr/bin/rg", "-l"]), [
    "/usr/bin/rg",
    "-l",
  ]);
  assert.deepEqual(
    remoteArgv(["landlock-run", "--", "rg", "-l", "src"]),
    ["/usr/bin/rg", "-l", "src"],
  );
});

test("remoteArgv leaves ordinary commands untouched", () => {
  assert.deepEqual(remoteArgv(["bash", "-c", "echo hi"]), [
    "bash",
    "-c",
    "echo hi",
  ]);
  assert.deepEqual(remoteArgv(["landlock-run", "cmd", "arg"]), [
    "landlock-run",
    "cmd",
    "arg",
  ]);
  assert.deepEqual(remoteArgv([]), []);
});

test("outputReader is undefined without a bounded mode", () => {
  assert.equal(outputReader(undefined), undefined);
  assert.equal(outputReader(null), undefined);
  assert.equal(outputReader("pipe"), undefined);
  assert.equal(outputReader({ maxBytes: -1 }), undefined);
  assert.equal(outputReader({ maxBytes: Number.NaN }), undefined);
});

test("outputReader reads appended output", () => {
  const reader = outputReader({ maxBytes: 16 })!;
  reader.append(Buffer.from("hello "));
  reader.append(Buffer.from("world"));
  const first = reader.readFrom(0);
  assert.equal(first.text, "hello world");
  assert.equal(first.nextOffset, 11);
  assert.equal(first.lossy, false);
});

test("outputReader drops bytes beyond the retention window", () => {
  const reader = outputReader({ maxBytes: 5 })!;
  reader.append(Buffer.from("hello"));
  reader.append(Buffer.from("world"));
  const read = reader.readFrom(0);
  assert.equal(read.text, "world");
  assert.equal(read.nextOffset, 10);
  assert.equal(read.lossy, true);
});

test("outputReader honors in-window offsets", () => {
  const reader = outputReader({ maxBytes: 5 })!;
  reader.append(Buffer.from("abcdefghij"));
  const atStart = reader.readFrom(5);
  assert.equal(atStart.text, "fghij");
  assert.equal(atStart.lossy, false);
  const pastEnd = reader.readFrom(10);
  assert.equal(pastEnd.text, "");
  assert.equal(pastEnd.lossy, false);
});

test("resolveExecutable resolves guest binaries", async () => {
  const provider = createSubprocessProvider({} as any);
  assert.equal(await provider.resolveExecutable("/abs/path"), "/abs/path");
  assert.equal(await provider.resolveExecutable("git"), "/usr/bin/git");
});

test("resolveExecutable rejects invalid names", async () => {
  const provider = createSubprocessProvider({} as any);
  await assert.rejects(() => provider.resolveExecutable(""));
  await assert.rejects(() => provider.resolveExecutable("bin/tool"));
});

const stubResolver = {
  resolve: async () => ({ kind: "binding" }),
} as any;

test("filesystem provider resolves absolute safe paths", async () => {
  const provider = createFilesystemProvider(stubResolver);
  const target = await provider.resolve("/projects/team/app", { cwd: "/x" });
  assert.equal(target.targetKey, "/projects/team/app");
  assert.equal(target.displayPath, "/projects/team/app");
  assert.deepEqual(target.binding, { kind: "binding" });
});

test("filesystem provider rejects unsafe paths", async () => {
  const provider = createFilesystemProvider(stubResolver);
  await assert.rejects(() => provider.resolve("relative"));
  await assert.rejects(() => provider.resolve("/a/../b"));
  await assert.rejects(() => provider.resolve("/a/b/../../etc"));
});

test("filesystem provider maps targets", () => {
  const provider = createFilesystemProvider(stubResolver);
  assert.equal(provider.fileUrl({ targetKey: "/a/b" }), "file:///a/b");
  assert.equal(provider.processPath({ targetKey: "/a/b" }), "/a/b");
  const parent = { targetKey: "/a" };
  assert.equal(provider.contains(parent, { targetKey: "/a" }), true);
  assert.equal(provider.contains(parent, { targetKey: "/a/b" }), true);
  assert.equal(provider.contains(parent, { targetKey: "/a2" }), false);
  assert.equal(provider.contains(parent, { targetKey: "/b" }), false);
});

const EXPECTED_TOOLS = [
  "list_images",
  "get_image",
  "build_image",
  "rebuild_image",
  "list_containers",
  "start_container",
  "recreate_container",
  "replace_container",
  "remove_container",
  "container_bash",
  "container_exec",
  "container_read",
  "container_write",
  "container_edit",
  "container_glob",
  "container_grep",
  "daemon_start",
  "daemon_list",
  "daemon_stop",
  "daemon_restart",
  "daemon_logs",
];

test("tool set covers the image and container surface", () => {
  assert.deepEqual(
    TOOLS.map((tool) => tool.name).sort(),
    [...EXPECTED_TOOLS].sort(),
  );
});

test("every tool parameters is a valid JSON-Schema object", () => {
  for (const tool of TOOLS) {
    assert.equal(tool.parameters.type, "object", `${tool.name} type`);
    assert.equal(typeof tool.parameters.properties, "object");
    assert.ok(Array.isArray(tool.parameters.required));
    for (const key of Object.keys(tool.parameters.properties)) {
      const property = tool.parameters.properties[key];
      assert.ok(
        !Object.prototype.hasOwnProperty.call(property, "required"),
        `${tool.name}.${key} must not carry per-property required`,
      );
      assert.ok(
        !Array.isArray(property.required),
        `${tool.name}.${key} must not carry a required array`,
      );
    }
  }
});

test("the four destructive mutations require approval", () => {
  const approval = TOOLS.filter((tool) => tool.approval)
    .map((tool) => tool.name)
    .sort();
  assert.deepEqual(approval, [
    "build_image",
    "rebuild_image",
    "recreate_container",
    "replace_container",
  ]);
});

const DAEMON_TOOLS = [
  "daemon_start",
  "daemon_list",
  "daemon_stop",
  "daemon_restart",
  "daemon_logs",
];

test("daemon tools require no approval and are valid object-rooted schemas", () => {
  for (const name of DAEMON_TOOLS) {
    const tool = TOOLS.find((entry) => entry.name === name);
    assert.ok(tool, `${name} registered`);
    assert.notEqual(tool!.approval, true, `${name} must not require approval`);
    assert.equal(tool!.parameters.type, "object", `${name} type`);
    assert.equal(typeof tool!.parameters.properties, "object");
    assert.ok(Array.isArray(tool!.parameters.required));
    assert.ok(tool!.parameters.required.includes("container"));
  }
});
