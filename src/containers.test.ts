// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { WORKSPACE_ID, fakeToolContext, guestExecRecorder, guestFileRecorder, secretBearingResolver } from "./test-support.js";
import {
  TOOLS,
  podmanRuntimeSection,
  resolveGuestCwd,
  resolveGuestPath,
  toolHandlers,
} from "./index.js";

test("container start/recreate/bash accept an env map schema", () => {
  for (const name of ["container_start", "container_recreate", "container_bash"]) {
    const tool = TOOLS.find((entry) => entry.name === name);
    assert.ok(tool, `${name} registered`);
    const env = tool!.parameters.properties.env;
    assert.equal(env.type, "object", `${name}.env type`);
    assert.equal(
      env.additionalProperties.type,
      "string",
      `${name}.env values type`,
    );
    assert.ok(
      !Array.isArray(tool!.parameters.required.includes("env")),
      `${name}.env must stay optional`,
    );
  }
});

test("container_list returns sanitized container objects with env values", async () => {
  const resolver = {
    registry: {
      resolveByPath: async () => ({ id: WORKSPACE_ID }),
    },
    control: async (method: string) => {
      if (method === "listContainers") {
        return {
          containers: [
            {
              workspaceSlug: WORKSPACE_ID,
              containerName: "default",
              status: "running",
              imageId: "img-1",
              env: { PATH: "/bin", HOME: "/root" },
            },
            {
              workspaceSlug: WORKSPACE_ID,
              containerName: "db",
              status: "running",
              env: { PORT: "5432", DB: "main", X: "1", Y: "2" },
            },
            {
              workspaceSlug: WORKSPACE_ID,
              containerName: "worker",
              status: "stopped",
            },
          ],
        };
      }
      return {};
    },
  } as never;
  const exec = { agent: { session: { header: { cwd: "/proj" } } } };
  const out = (await toolHandlers.container_list(resolver, {}, exec)) as any[];
  assert.deepEqual(out, [
    {
      containerName: "default",
      status: "running",
      imageId: "img-1",
      mounts: [],
      paths: [],
      env: { PATH: "/bin", HOME: "/root" },
      secretEnv: {},
    },
    {
      containerName: "db",
      status: "running",
      mounts: [],
      paths: [],
      env: { PORT: "5432", DB: "main", X: "1", Y: "2" },
      secretEnv: {},
    },
    {
      containerName: "worker",
      status: "stopped",
      mounts: [],
      paths: [],
      env: {},
      secretEnv: {},
    },
  ]);
});

test("container_list reports an uncreated default container as not started", async () => {
  const resolver = {
    registry: {
      resolveByPath: async () => ({ id: WORKSPACE_ID }),
    },
    control: async () => ({ containers: [] }),
  } as never;
  const exec = { agent: { session: { header: { cwd: "/proj" } } } };
  const out = (await toolHandlers.container_list(resolver, {}, exec)) as any[];
  assert.deepEqual(out, [
    { containerName: "default", status: "not started" },
  ]);
});

test("container tools never expose internal fields in their results", async () => {
  const exec = { agent: { session: { header: { cwd: "/projects/team" } } } };
  const cases: Array<[any, Record<string, unknown>]> = [
    [toolHandlers.container_start, { container: "default", image: "img-1" }],
    [toolHandlers.container_recreate, { container: "default" }],
    [toolHandlers.container_mount_add, { container: "default", kind: "volume", volume: "v", destination: "/data" }],
    [toolHandlers.container_mount_remove, { container: "default", kind: "volume", volume: "v", destination: "/data" }],
    [toolHandlers.container_mount_update, { container: "default", kind: "volume", volume: "v", destination: "/data", mode: "read_only" }],
    [toolHandlers.container_secret_add, { container: "default", env: "DB_PASS", secret: "db-pass" }],
    [toolHandlers.container_secret_remove, { container: "default", env: "DB_PASS" }],
  ];
  for (const [handler, input] of cases) {
    const out = await handler(secretBearingResolver(), input, exec);
    const json = JSON.stringify(out);
    assert.ok(!json.includes("agentSocketPath"), "must not expose agentSocketPath");
    assert.ok(!json.includes("agentToken"), "must not expose agentToken");
    assert.ok(!json.includes("podmanName"), "must not expose podmanName");
    assert.ok(!json.includes("workspaceSlug"), "must not expose workspaceSlug");
    assert.ok(!json.includes("createdAt"), "must not expose createdAt");
    assert.ok(json.includes("hunter2"), "env values are returned to the model");
    assert.equal(out.containerName, "default");
    assert.equal(out.status, "running");
    assert.equal(out.imageId, "img-1");
    assert.equal(out.secretEnv.DB_PASS, "db-pass");
  }
});

test("container_recreate reports the recreated container", async () => {
  const resolver = {
    registry: {
      resolveByPath: async () => ({ id: WORKSPACE_ID }),
    },
    getConfig: () => ({ projectsRoot: "/projects" }),
    // The control plane answers with the container it recreated: its logical
    // name, and its own mounts and env rather than the default container's.
    control: async () => ({
      workspaceSlug: WORKSPACE_ID,
      containerName: "db",
      imageId: "img-1",
      status: "running",
      mounts: [],
      env: { APP_ENV: "probe" },
    }),
  } as never;
  const exec = { agent: { session: { header: { cwd: "/projects/team" } } } };
  const named = (await toolHandlers.container_recreate(
    resolver,
    { container: "db", image: "img-1" },
    exec,
  )) as any;
  assert.equal(named.containerName, "db");
  assert.deepEqual(named.env, { APP_ENV: "probe" });
});

test("container start and recreate forward PATH additions", async () => {
  const calls: Array<[string, any]> = [];
  const resolver = {
    registry: {
      resolveByPath: async () => ({ id: WORKSPACE_ID }),
    },
    getConfig: () => ({ projectsRoot: "/projects" }),
    control: async (method: string, request: unknown) => {
      calls.push([method, request]);
      return { containerName: "default", status: "running", paths: ["/opt/bin"] };
    },
  } as never;
  const exec = { agent: { session: { header: { cwd: "/projects/team" } } } };
  const started = (await toolHandlers.container_start(
    resolver,
    { container: "default", paths: ["/opt/bin"] },
    exec,
  )) as any;
  assert.deepEqual(calls[0][1].paths, ["/opt/bin"]);
  assert.deepEqual(started.paths, ["/opt/bin"]);
  const recreated = (await toolHandlers.container_recreate(
    resolver,
    { container: "default", paths: ["/usr/local/bin"] },
    exec,
  )) as any;
  assert.deepEqual(calls[1][1].paths, ["/usr/local/bin"]);
  assert.deepEqual(recreated.paths, ["/opt/bin"]);
});

test("resolveGuestPath resolves relative paths and refuses traversal", () => {
  assert.equal(resolveGuestPath("/abs/file", "/projects/team"), "/abs/file");
  assert.equal(resolveGuestPath("README.md", "/projects/team"), "/projects/team/README.md");
  assert.equal(resolveGuestPath("src/main.go", "/projects/team"), "/projects/team/src/main.go");
  assert.equal(resolveGuestPath("./a", "/projects/team"), "/projects/team/a");
  // ".." is refused before resolution, where it would be normalised away.
  assert.throws(() => resolveGuestPath("../escape", "/projects/team"), /must not escape/);
  assert.throws(() => resolveGuestPath("a/../b", "/projects/team"), /must not escape/);
  assert.throws(() => resolveGuestPath("/a/../b", "/projects/team"), /must not escape/);
  // A relative path is meaningless without a session working directory.
  assert.throws(() => resolveGuestPath("rel", undefined), /session working directory/);
  assert.throws(() => resolveGuestPath("rel", ""), /session working directory/);
  assert.equal(resolveGuestPath("/abs", undefined), "/abs");
});

test("resolveGuestCwd resolves working directories but keeps traversal", () => {
  assert.equal(resolveGuestCwd(undefined, "/projects/team"), undefined);
  assert.equal(resolveGuestCwd("", "/projects/team"), undefined);
  assert.equal(resolveGuestCwd("/abs", "/projects/team"), "/abs");
  assert.equal(resolveGuestCwd("sub", "/projects/team"), "/projects/team/sub");
  // Commands are not confined to the projects root, so ".." is allowed here.
  assert.equal(resolveGuestCwd("../sibling", "/projects/team"), "/projects/sibling");
});

test("container_read applies offset and limit like the built-in read tool", async () => {
  const exec = { agent: { session: { header: { cwd: "/projects/team" } } } };
  const { resolver } = guestFileRecorder("l1\nl2\nl3\nl4\n");
  assert.equal(
    await toolHandlers.container_read(
      resolver as never,
      { container: "default", file_path: "f" },
      exec,
      fakeToolContext(resolver),
    ),
    "l1\nl2\nl3\nl4\n",
    "no offset/limit returns the whole content",
  );
  assert.equal(
    await toolHandlers.container_read(
      resolver as never,
      { container: "default", file_path: "f", offset: 2, limit: 2 },
      exec,
      fakeToolContext(resolver),
    ),
    "l2\nl3",
  );
});

test("container_read records the read so a later write needs no re-read", async () => {
  const exec = { agent: { session: { header: { cwd: "/projects/team" } } } };
  const { resolver } = guestFileRecorder("hello\n");
  const ctx = fakeToolContext(resolver);
  assert.equal(
    await toolHandlers.container_read(
      resolver as never,
      { container: "default", file_path: "f" },
      exec,
      ctx,
    ),
    "hello\n",
  );
  assert.equal(ctx.observed.length, 1, "a successful read reports one observation");
  assert.equal(ctx.observed[0].target.displayPath, "/projects/team/f");
  assert.equal(ctx.observed[0].observation.kind, "present");
  assert.match(ctx.observed[0].observation.version, /^agent:/);
});

test("container_read reports a missing file and records it as absent", async () => {
  const exec = { agent: { session: { header: { cwd: "/projects/team" } } } };
  const { resolver } = guestFileRecorder("", false);
  const ctx = fakeToolContext(resolver);
  await assert.rejects(
    () =>
      toolHandlers.container_read(
        resolver as never,
        { container: "default", file_path: "gone" },
        exec,
        ctx,
      ),
    (error: any) => error.code === "FS_NOT_FOUND" && /not found/.test(error.message),
  );
  assert.deepEqual(ctx.observed[0].observation, { kind: "absent" });
});

test("container_edit requires a unique match unless replace_all is set", async () => {
  const exec = { agent: { session: { header: { cwd: "/projects/team" } } } };

  const duplicate = guestFileRecorder("a a a");
  await assert.rejects(
    () =>
      toolHandlers.container_edit(
        duplicate.resolver as never,
        { container: "default", file_path: "f", old_string: "a", new_string: "b" },
        exec,
        fakeToolContext(duplicate.resolver),
      ),
    /matched 3 times/,
  );
  assert.deepEqual(duplicate.writes, [], "a non-unique match must not be written");

  const all = guestFileRecorder("a a a");
  await toolHandlers.container_edit(
    all.resolver as never,
    { container: "default", file_path: "f", old_string: "a", new_string: "b", replace_all: true },
    exec,
    fakeToolContext(all.resolver),
  );
  assert.equal(all.writes[0].content, "b b b");
});

test("container command and file tools mirror the built-in arguments", () => {
  const parameters = (name: string): any =>
    TOOLS.find((entry) => entry.name === name)!.parameters;

  const bash = parameters("container_bash");
  assert.ok(bash.required.includes("command"));
  assert.ok(bash.required.includes("description"));
  assert.equal(bash.properties.timeoutMs.type, "number");

  const exec = parameters("container_exec");
  assert.ok(exec.required.includes("description"));
  assert.equal(exec.properties.workdir.type, "string");
  assert.equal(exec.properties.cwd, undefined);

  const read = parameters("container_read");
  assert.equal(read.properties.file_path.type, "string");
  assert.equal(read.properties.offset.type, "integer");
  assert.equal(read.properties.limit.type, "integer");

  const write = parameters("container_write");
  assert.equal(write.properties.file_path.type, "string");

  const edit = parameters("container_edit");
  assert.equal(edit.properties.old_string.type, "string");
  assert.equal(edit.properties.new_string.type, "string");
  assert.equal(edit.properties.replace_all.type, "boolean");

  const glob = parameters("container_glob");
  assert.equal(glob.properties.path.type, "string");
  assert.equal(glob.properties.cwd, undefined);

  const grep = parameters("container_grep");
  assert.equal(grep.properties.include.type, "string");
  assert.equal(grep.properties.cwd, undefined);
});

test("container_bash enforces timeoutMs", async () => {
  const exec = { agent: { session: { header: { cwd: "/projects/team" } } } };
  let signaled: any;
  const guest = {
    exec: () => {
      const handlers: Record<string, ((value?: unknown) => void)[]> = {};
      return {
        on(event: string, handler: (value?: unknown) => void) {
          (handlers[event] ??= []).push(handler);
          if (event === "data") queueMicrotask(() => handler({ processId: "42" }));
        },
        write() {},
        end() {},
      };
    },
    signal: (
      request: any,
      _metadata: unknown,
      callback: (error: Error | null, result: unknown) => void,
    ) => {
      signaled = request;
      callback(null, {});
    },
  };
  const resolver = {
    resolve: async () => ({
      guest,
      token: "t",
      socket: "/run/x.sock",
      defaultCwd: "/projects/team",
    }),
  };
  await assert.rejects(
    () =>
      toolHandlers.container_bash(
        resolver as never,
        { container: "default", command: "sleep", description: "x", timeoutMs: 10 },
        exec,
      ),
    /timed out/,
  );
  assert.equal(signaled.processId, "42");
  assert.equal(signaled.signal, "SIGTERM");
});

test("container commands inherit the managed shell environment", async () => {
  const exec = { agent: { session: { header: { cwd: "/projects/team" } } } };
  const ctx = {
    get: (name: string) =>
      name === "shellEnv"
        ? {
            collect: () => ({
              DSH_HOME: "/dsh",
              DSH_SHELL: "1",
              DSH_SESSION_ID: "s1",
            }),
          }
        : undefined,
  };
  const bash = guestExecRecorder();
  await toolHandlers.container_bash(
    bash.resolver as never,
    {
      container: "default",
      command: "env",
      description: "x",
      env: { TERM: "xterm", DSH_SESSION_ID: "spoofed" },
    },
    exec,
    ctx,
  );
  assert.deepEqual(
    bash.starts[0].env,
    {
      // The terminal overrides come first, the caller's entry beats them, and
      // the managed DSH_* snapshot displaces the caller's spoofed session id.
      NO_COLOR: "1",
      TERM: "xterm",
      PAGER: "cat",
      GIT_PAGER: "cat",
      DSH_HOME: "/dsh",
      DSH_SHELL: "1",
      DSH_SESSION_ID: "s1",
    },
  );

  const run = guestExecRecorder();
  await toolHandlers.container_exec(
    run.resolver as never,
    { container: "default", argv: ["env"], description: "x" },
    exec,
    ctx,
  );
  assert.equal(run.starts[0].env?.DSH_SESSION_ID, "s1");
  assert.equal(run.starts[0].env?.TERM, "dumb");
});

test("container_grep resolves its search path like a shell would", async () => {
  const exec = { agent: { session: { header: { cwd: "/projects/team" } } } };

  // With a search path, it is relative to the session directory.
  const plain = guestExecRecorder("/projects/team");
  await toolHandlers.container_grep(
    plain.resolver as never,
    { container: "default", pattern: "TODO", path: "src" },
    exec,
  );
  assert.deepEqual(plain.starts[0].argv, ["/usr/bin/rg", "-n", "TODO", "/projects/team/src"]);

  // An include filter maps to ripgrep's --glob.
  const filtered = guestExecRecorder("/projects/team");
  await toolHandlers.container_grep(
    filtered.resolver as never,
    { container: "default", pattern: "TODO", path: "src", include: "*.ts" },
    exec,
  );
  assert.deepEqual(filtered.starts[0].argv, ["/usr/bin/rg", "-n", "--glob", "*.ts", "TODO", "/projects/team/src"]);
  assert.equal(filtered.starts[0].cwd, "/projects/team");

  const none = guestExecRecorder("/projects/team");
  await toolHandlers.container_grep(
    none.resolver as never,
    { container: "default", pattern: "TODO" },
    exec,
  );
  // No path searches the session workspace explicitly: ripgrep would otherwise
  // read its (non-TTY) stdin instead of the working directory.
  assert.deepEqual(none.starts[0].argv, ["/usr/bin/rg", "-n", "TODO", "/projects/team"]);
  assert.equal(none.starts[0].cwd, "/projects/team");
});

test("container_glob passes the pattern as a glob and scopes the search", async () => {
  const exec = { agent: { session: { header: { cwd: "/projects/team" } } } };

  const plain = guestExecRecorder("/projects/team");
  await toolHandlers.container_glob(
    plain.resolver as never,
    { container: "default", pattern: "*.ts" },
    exec,
  );
  assert.deepEqual(plain.starts[0].argv, [
    "/usr/bin/rg",
    "--files",
    "--glob=*.ts",
    "--sort=modified",
    "--no-ignore",
    "--hidden",
    "--glob=!**/.git",
    "--glob=!**/.git/**",
    "--glob=!**/.svn",
    "--glob=!**/.svn/**",
    "--glob=!**/.hg",
    "--glob=!**/.hg/**",
    "--glob=!**/.bzr",
    "--glob=!**/.bzr/**",
    "--glob=!**/.jj",
    "--glob=!**/.jj/**",
    "--glob=!**/.sl",
    "--glob=!**/.sl/**",
  ]);
  assert.equal(plain.starts[0].cwd, "/projects/team");

  // An explicit search path becomes the working directory.
  const scoped = guestExecRecorder("/projects/team");
  await toolHandlers.container_glob(
    scoped.resolver as never,
    { container: "default", pattern: "*", path: "/volumes/data" },
    exec,
  );
  assert.equal(scoped.starts[0].cwd, "/volumes/data");
  assert.ok(scoped.starts[0].argv.includes("--glob=*"));
});

test("container_glob caps its result at 100 files", async () => {
  const exec = { agent: { session: { header: { cwd: "/projects/team" } } } };
  const lines = (count: number) =>
    Array.from({ length: count }, (_, index) => `file-${index}.ts`).join("\n") + "\n";

  const small = guestExecRecorder("/projects/team", lines(3));
  const few = (await toolHandlers.container_glob(
    small.resolver as never,
    { container: "default", pattern: "*" },
    exec,
  )) as { files: string[]; note?: string };
  assert.equal(few.files.length, 3);
  assert.equal(few.note, undefined);

  const big = guestExecRecorder("/projects/team", lines(101));
  const many = (await toolHandlers.container_glob(
    big.resolver as never,
    { container: "default", pattern: "*" },
    exec,
  )) as { files: string[]; note?: string };
  assert.equal(many.files.length, 100);
  assert.match(many.note ?? "", /showing 100 of 101 files/);
});

test("podmanRuntimeSection names only the tools the agent has", () => {
  // The harness's shell/filesystem tools are mounted for this agent.
  const withBuiltins = podmanRuntimeSection({ tools: { get: () => ({}) } });
  assert.equal(withBuiltins.name, "podman:runtime");
  assert.equal(withBuiltins.order, 950);
  const full = withBuiltins.text({ scope: "agent" });
  for (const tool of ["bash", "read", "write", "edit", "glob", "grep"]) {
    assert.match(full, new RegExp("`" + tool + "`"));
  }
  assert.match(full, /container-backed/);
  assert.match(full, /run in a Podman container/);
  assert.match(full, /There is no host shell/);
  // The facts that pre-empt the "bash runs on the host" hallucination: the
  // built-in shell and container_bash run in one container, and identical uname
  // output is the shared kernel, not a host shell.
  assert.match(full, /container: "default"/);
  assert.match(full, /sees the same environment and filesystem/);
  assert.match(full, /share the host kernel/);
  assert.match(full, /hostname/);
  assert.match(full, /\/etc\/os-release/);
  // Containers belong to a dsh workspace, and the daemon tools are
  // container-scoped too (they do not start with `container_`).
  assert.match(full, /scoped to a dsh workspace/);
  assert.match(full, /container_\*/);
  assert.match(full, /daemon_\*/);
  // Neither the old vocabulary nor plugin lore belongs in the section.
  assert.doesNotMatch(full, /Podman workspace/);
  assert.doesNotMatch(full, /those same operations/);
  assert.doesNotMatch(full, /plugin/i);

  // The Podman operator preset mounts none of them, so the wording must not
  // name a tool the agent cannot call.
  const containerOnly = podmanRuntimeSection({ tools: { get: () => undefined } });
  const short = containerOnly.text({ scope: "agent" });
  for (const tool of ["bash", "read", "write", "edit", "glob", "grep"]) {
    assert.doesNotMatch(short, new RegExp("`" + tool + "`"));
  }
  assert.doesNotMatch(short, /container-backed/);
  assert.doesNotMatch(short, /sees the same/);
  assert.match(short, /run in a Podman container/);
  assert.match(short, /There is no host shell/);
  assert.match(short, /container: "default"/);
  assert.match(short, /scoped to a dsh workspace/);
  assert.match(short, /container_\*/);
  assert.match(short, /daemon_\*/);
  assert.match(short, /share the host kernel/);
});

test("podmanRuntimeSection guides the model to custom images and named volumes", () => {
  const variants = [
    podmanRuntimeSection({ tools: { get: () => ({}) } }),
    podmanRuntimeSection({ tools: { get: () => undefined } }),
  ];
  for (const section of variants) {
    const text = section.text({ scope: "agent" });
    // Software installs belong in an image, not a running container.
    assert.match(text, /custom image/);
    assert.match(text, /`image_build`/);
    assert.match(text, /`container_start`/);
    assert.match(text, /`container_recreate`/);
    // Persistence belongs in a named volume, not a tmpfs.
    assert.match(text, /named `volume`/);
    assert.match(text, /`tmpfs`/);
    assert.match(text, /\/tmp/);
    assert.match(text, /clears tmpfs contents/);
    // The guidance stays free of plugin lore: the section reads as facts.
    assert.doesNotMatch(text, /plugin/i);
  }
});

test("container_grep fails loudly when ripgrep reports an error", async () => {
  const guest = {
    exec: () => {
      const handlers: Record<string, ((value?: unknown) => void)[]> = {};
      return {
        on(event: string, handler: (value?: unknown) => void) {
          (handlers[event] ??= []).push(handler);
        },
        write() {},
        end() {
          for (const handler of handlers.data ?? []) {
            handler({ stderrChunk: Buffer.from("rg: error parsing glob '[bad'\n") });
            handler({ exit: { exitCode: 2, signaled: false } });
          }
        },
      };
    },
  };
  const resolver = {
    resolve: async () => ({ guest, token: "t" }),
    containerBinding: async () => ({ guest, token: "t" }),
  } as never;
  const exec = { agent: { session: { header: { cwd: "/projects/team" } } } };
  await assert.rejects(
    toolHandlers.container_grep(
      resolver,
      { container: "default", pattern: "TODO", include: "[bad" },
      exec,
    ),
    /error parsing glob/,
  );
});
