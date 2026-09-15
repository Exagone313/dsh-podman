// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import {
  reasonLocale,
  renderCacheCleanNotice,
  renderDenial,
  renderReason,
  resolveReasonLocale,
} from "./approval-reasons.js";
import { preExecutePolicy, summarizeArgs } from "./index.js";
import { testReadSession } from "./test-support.js";

test("reasonLocale normalizes a locale id to a shipped language", () => {
  assert.equal(reasonLocale("zh"), "zh");
  assert.equal(reasonLocale("zh-Hans"), "zh");
  assert.equal(reasonLocale("zh_CN"), "zh");
  assert.equal(reasonLocale("ZH"), "zh");
  assert.equal(reasonLocale("en-US"), "en");
  assert.equal(reasonLocale("fr"), "en");
  assert.equal(reasonLocale(undefined), "en");
  assert.equal(reasonLocale(42), "en");
});

test("resolveReasonLocale prefers the client-observed locale over the preference", () => {
  const settings = (container: unknown, locale: unknown) => ({
    get: (ns: string) => (ns === "podman" ? container : ns === "locale" ? locale : undefined),
  });
  assert.equal(resolveReasonLocale(undefined), "en");
  assert.equal(resolveReasonLocale(settings({ uiLocale: "zh" }, { preference: "en" })), "zh");
  assert.equal(resolveReasonLocale(settings({ uiLocale: "" }, { preference: "zh" })), "zh");
  assert.equal(resolveReasonLocale(settings({}, { preference: "zh" })), "zh");
  assert.equal(resolveReasonLocale(settings({ uiLocale: "en" }, { preference: "zh" })), "en");
  assert.equal(resolveReasonLocale(settings({}, {})), "en");
});

test("summarizeArgs renders reasons in Chinese when asked", () => {
  assert.equal(
    summarizeArgs(
      "container_mount_add",
      {
        container: "web",
        kind: "volume",
        volume: "valkey-data",
        destination: "/data",
        mode: "read_only",
      },
      undefined,
      "zh",
    ),
    "在容器 “web” 中添加挂载：卷 “valkey-data” 挂载到 “/data”（只读）。",
  );
  assert.equal(
    summarizeArgs(
      "container_start",
      {
        container: "web",
        image: "img",
        mounts: [{ project: "team", mode: "read_only" }],
        env: { A: "1" },
      },
      undefined,
      "zh",
    ),
    "启动容器 “web”（镜像 “img”），挂载：项目 “team”（只读），环境变量：A。",
  );
});

test("renderDenial renders both languages", () => {
  assert.equal(
    renderDenial("en", { kind: "read_only", tool: "container_start" }),
    'Denied: the session is read-only, but "container_start" needs write access.',
  );
  assert.equal(
    renderDenial("zh", { kind: "read_only", tool: "container_start" }),
    "已拒绝：当前会话为只读，而 “container_start” 需要写入权限。",
  );
  assert.equal(
    renderDenial("zh", {
      kind: "project_destination",
      source: "team/src",
      mirror: "/projects/team/src",
    }),
    "项目挂载不能指定目标路径；“team/src” 始终挂载到 “/projects/team/src”。",
  );
  assert.equal(
    renderDenial("zh", { kind: "project_destination" }),
    "项目挂载不能指定目标路径。",
  );
  assert.equal(
    renderDenial("en", { kind: "project_destination", mirror: "/projects" }),
    'Project mounts cannot set a destination; the project always mounts at "/projects".',
  );
  assert.equal(
    renderDenial("zh", { kind: "project_destination", mirror: "/projects" }),
    "项目挂载不能指定目标路径；该项目 始终挂载到 “/projects”。",
  );
});

test("renderReason covers the remaining reason kinds in both languages", () => {
  assert.equal(renderReason("en", { kind: "image_rebuild_all" }), "Rebuild all images.");
  assert.equal(renderReason("zh", { kind: "image_rebuild_all" }), "重建全部镜像。");
  assert.equal(
    renderReason("zh", { kind: "daemon_start", container: "c", argv: ["x"], uid: 1 }),
    "在容器 “c” 中启动守护进程：x（uid 1）",
  );
  assert.equal(
    renderReason("zh", { kind: "container_secret_add", container: "c", secret: "s", env: "E" }),
    "将机密 “s” 作为 “E” 注入容器 “c”。",
  );
  assert.equal(
    renderReason("zh", {
      kind: "container_mount_update",
      container: "valkey-ctr",
      mount: { kind: "volume", source: "valkey-data", destination: "/data", readOnly: false },
    }),
    "更新容器 “valkey-ctr” 中的挂载：将卷 “valkey-data”（挂载到 “/data”）重新挂载为读写。",
  );
  assert.equal(
    renderReason("zh", {
      kind: "container_mount_update",
      container: "web",
      mount: { kind: "project", source: "team", readOnly: true },
    }),
    "更新容器 “web” 中的挂载：将项目 “team” 重新挂载为只读。",
  );
});

test("renderCacheCleanNotice reports the removed file count", () => {
  assert.equal(renderCacheCleanNotice("en", 1), "removed 1 cached file");
  assert.equal(renderCacheCleanNotice("en", 3), "removed 3 cached files");
  assert.equal(renderCacheCleanNotice("zh", 3), "已移除 3 个缓存文件");
});

test("renderReason renders the read-only remount plan", () => {
  assert.equal(
    renderReason("en", {
      kind: "read_only_remount",
      tool: "bash",
      remount: [
        { kind: "project", source: "team", readOnly: false },
        { kind: "volume", source: "data", destination: "/data", readOnly: false },
      ],
      keep: [{ kind: "tmpfs", source: "", destination: "/scratch" }],
    }),
    'Read-only mode blocks "bash" while a mount is read-write. Remount these mounts read-only to run it:\n\n- project "team" (read-write)\n- volume "data" at "/data" (read-write)\n\nKept as-is: tmpfs at "/scratch".',
  );
  assert.equal(
    renderReason("zh", {
      kind: "read_only_remount",
      tool: "bash",
      remount: [{ kind: "project", source: "team", readOnly: false }],
      keep: [],
    }),
    "只读模式在存在读写挂载时会阻止 “bash”。将这些挂载重新挂载为只读即可运行：\n\n- 项目 “team”（读写）",
  );
});

test("renderDenial renders the declined remount", () => {
  assert.equal(
    renderDenial("en", { kind: "read_only_remount_declined", tool: "bash" }),
    'Denied: read-only mode blocks "bash" and the mounts were not remounted.',
  );
  assert.equal(
    renderDenial("zh", { kind: "read_only_remount_declined", tool: "bash" }),
    "已拒绝：只读模式阻止 “bash”，且挂载未被重新挂载。",
  );
});

test("preExecutePolicy renders a localized deny reason", async () => {
  const denied = (await preExecutePolicy(
    { name: "container_start", agent: { session: { facts: { mode: "read-only" } } } },
    () => Promise.resolve({ kind: "allow" }),
    undefined,
    () => "zh",
    testReadSession,
  )) as { kind: string; reason: string };
  assert.equal(denied.kind, "deny");
  assert.equal(denied.reason, "已拒绝：当前会话为只读，而 “container_start” 需要写入权限。");
});

test("preExecutePolicy renders a localized deny reason for a built-in tool", async () => {
  const denied = (await preExecutePolicy(
    { name: "bash", agent: { session: { facts: { mode: "read-only" } } } },
    () => Promise.resolve({ kind: "allow" }),
    undefined,
    () => "zh",
    testReadSession,
  )) as { kind: string; reason: string };
  assert.equal(denied.kind, "deny");
  assert.equal(denied.reason, "已拒绝：当前会话为只读，而 “bash” 可能修改文件。");
});
