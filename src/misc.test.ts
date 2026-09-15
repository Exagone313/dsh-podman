// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import { guestExecRecorder, guestFileRecorder } from "./test-support.js";
import {
  HARNESS_SOURCE_SECTION,
  TOOLS,
  toolCallView,
  toolHandlers,
  toolResultView,
  withoutHarnessSourceSection,
} from "./index.js";

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

test("file tools resolve relative paths against the session cwd", async () => {
  const exec = { agent: { session: { header: { cwd: "/projects/team" } } } };

  const read = guestFileRecorder();
  await toolHandlers.container_read(
    read.resolver as never,
    { container: "default", file_path: "README.md" },
    exec,
  );
  assert.deepEqual(read.reads, ["/projects/team/README.md"]);

  const absolute = guestFileRecorder();
  await toolHandlers.container_read(
    absolute.resolver as never,
    { container: "default", file_path: "/etc/hosts" },
    exec,
  );
  assert.deepEqual(absolute.reads, ["/etc/hosts"], "absolute paths pass through");

  const write = guestFileRecorder();
  await toolHandlers.container_write(
    write.resolver as never,
    { container: "default", file_path: "out.txt", content: "x" },
    exec,
  );
  assert.deepEqual(write.writes.map((entry) => entry.path), ["/projects/team/out.txt"]);

  const edit = guestFileRecorder("hello");
  await toolHandlers.container_edit(
    edit.resolver as never,
    { container: "default", file_path: "a.txt", old_string: "hello", new_string: "bye" },
    exec,
  );
  assert.deepEqual(edit.reads, ["/projects/team/a.txt"]);
  assert.deepEqual(edit.writes.map((entry) => entry.path), ["/projects/team/a.txt"]);
});

test("file tools refuse traversal before reaching the guest", async () => {
  const exec = { agent: { session: { header: { cwd: "/projects/team" } } } };
  const { reads, writes, resolver } = guestFileRecorder();
  for (const path of ["../escape", "a/../../b"]) {
    await assert.rejects(
      () => toolHandlers.container_read(resolver as never, { container: "default", file_path: path }, exec),
      /must not escape/,
    );
  }
  await assert.rejects(
    () =>
      toolHandlers.container_write(
        resolver as never,
        { container: "default", file_path: "../escape", content: "x" },
        exec,
      ),
    /must not escape/,
  );
  assert.deepEqual(reads, [], "a refused path must not reach the guest");
  assert.deepEqual(writes, []);
});

test("tool presenters label every tool and render terminal commands", () => {
  for (const tool of TOOLS) {
    assert.notEqual(
      toolCallView(tool.name, {}),
      undefined,
      `${tool.name} has a call view`,
    );
  }
  assert.deepEqual(
    toolCallView("container_bash", { command: "ls", description: "List files" }),
    { card: "terminal", title: "ls", description: "List files" },
  );
  assert.deepEqual(
    toolCallView("container_exec", { argv: ["ls", "-la"], description: "List all" }),
    { card: "terminal", title: "ls -la", description: "List all" },
  );
  assert.deepEqual(
    toolCallView("image_list", {}),
    { card: "generic", title: "List images", kind: "search" },
  );
  assert.deepEqual(
    toolCallView("container_read", {}),
    { card: "generic", title: "Container read", kind: "read" },
  );
  assert.deepEqual(
    toolCallView("container_write", {}),
    { card: "generic", title: "Container write", kind: "edit" },
  );
  assert.deepEqual(
    toolCallView("container_edit", {}),
    { card: "generic", title: "Container edit", kind: "edit" },
  );
  assert.deepEqual(
    toolCallView("container_glob", {}),
    { card: "generic", title: "Container glob", kind: "search" },
  );
  assert.deepEqual(
    toolCallView("container_grep", {}),
    { card: "generic", title: "Container grep", kind: "search" },
  );
});

test("tool presenters render command results as terminal output", () => {
  const result = (value: unknown) => ({
    content: [{ type: "text", text: JSON.stringify(value) }],
    isError: false,
  });
  assert.deepEqual(
    toolResultView("container_bash", {}, result({ exitCode: 0, signal: null, stdout: "hi\n", stderr: "" })),
    { card: "terminal", output: "hi\n", exitCode: 0 },
  );
  assert.deepEqual(
    toolResultView("container_bash", {}, result({ exitCode: 0, signal: "SIGTERM", stdout: "", stderr: "" })),
    { card: "terminal", output: "", signal: "SIGTERM" },
  );
  assert.equal(
    toolResultView("container_bash", {}, { content: [{ type: "text", text: "boom" }], isError: true }),
    undefined,
  );
  assert.equal(toolResultView("image_list", {}, result({})), undefined);
});

test("command tools resolve a relative working directory", async () => {
  const exec = { agent: { session: { header: { cwd: "/projects/team" } } } };

  const bash = guestExecRecorder("/projects/team");
  await toolHandlers.container_bash(
    bash.resolver as never,
    { container: "default", command: "ls", workdir: "sub" },
    exec,
  );
  assert.equal(bash.starts[0].cwd, "/projects/team/sub");

  const run = guestExecRecorder("/projects/team");
  await toolHandlers.container_exec(
    run.resolver as never,
    { container: "default", argv: ["ls"], workdir: "/abs" },
    exec,
  );
  assert.equal(run.starts[0].cwd, "/abs", "absolute working directories pass through");

  // An unset working directory defaults to the session's (when mounted).
  const bare = guestExecRecorder("/projects/team");
  await toolHandlers.container_exec(
    bare.resolver as never,
    { container: "default", argv: ["ls"] },
    exec,
  );
  assert.equal(bare.starts[0].cwd, "/projects/team");

  // Commands are not confined to the projects root, so ".." is allowed.
  const up = guestExecRecorder("/projects/team");
  await toolHandlers.container_bash(
    up.resolver as never,
    { container: "default", command: "ls", workdir: "../sibling" },
    exec,
  );
  assert.equal(up.starts[0].cwd, "/projects/sibling");
});

test("command tools pass an optional uid, gid, and groups", async () => {
  const exec = { agent: { session: { header: { cwd: "/projects/team" } } } };

  const bash = guestExecRecorder("/projects/team");
  await toolHandlers.container_bash(
    bash.resolver as never,
    { container: "default", command: "id", uid: 1000 },
    exec,
  );
  assert.deepEqual(bash.starts[0], { argv: ["bash", "-c", "id"], cwd: "/projects/team", uid: 1000 });

  const run = guestExecRecorder("/projects/team");
  await toolHandlers.container_exec(
    run.resolver as never,
    { container: "default", argv: ["id"], uid: 1000, gid: 2000, groups: [3000, 4000] },
    exec,
  );
  assert.deepEqual(run.starts[0], {
    argv: ["id"],
    cwd: "/projects/team",
    uid: 1000,
    gid: 2000,
    groups: [3000, 4000],
  });

  // No identity leaves the command as the container's default user.
  const none = guestExecRecorder("/projects/team");
  await toolHandlers.container_exec(none.resolver as never, { container: "default", argv: ["id"] }, exec);
  assert.equal("uid" in none.starts[0], false);
  assert.equal("groups" in none.starts[0], false);

  for (const bad of [
    { uid: -1 },
    { gid: -1 },
    { groups: [1, -2] },
    { groups: "1" },
    { uid: 1.5 },
  ]) {
    await assert.rejects(
      toolHandlers.container_exec(
        guestExecRecorder("/projects/team").resolver as never,
        { container: "default", argv: ["id"], ...bad },
        exec,
      ),
    );
  }
});

test("withoutHarnessSourceSection drops only the harness checkout section", () => {
  const assembly = {
    sections: [
      { name: "harness:identity", text: "identity" },
      { name: HARNESS_SOURCE_SECTION, text: "checkout at /src" },
      { name: "deployment:persona", text: "persona" },
    ],
    contexts: [{ name: "c", text: "t" }],
    tools: [{ name: "t" }],
    variables: { model: "m" },
  };
  const result = withoutHarnessSourceSection(assembly);
  assert.deepEqual(
    result.sections.map((section: { name: string }) => section.name),
    ["harness:identity", "deployment:persona"],
  );
  assert.deepEqual(result.contexts, assembly.contexts);
  assert.deepEqual(result.tools, assembly.tools);
  assert.deepEqual(result.variables, assembly.variables);
  // The input assembly is not mutated.
  assert.equal(assembly.sections.length, 3);
});

test("withoutHarnessSourceSection leaves an assembly without the section intact", () => {
  const assembly = { sections: [{ name: "harness:identity", text: "i" }] };
  const result = withoutHarnessSourceSection(assembly);
  assert.deepEqual(result, assembly);
});
