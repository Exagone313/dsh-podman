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
    "启动容器 “web”（镜像 “img”），挂载：目录 “team”（只读），环境变量：A。",
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
});

test("renderCacheCleanNotice reports the removed file count", () => {
  assert.equal(renderCacheCleanNotice("en", 1), "removed 1 cached file");
  assert.equal(renderCacheCleanNotice("en", 3), "removed 3 cached files");
  assert.equal(renderCacheCleanNotice("zh", 3), "已移除 3 个缓存文件");
});

test("preExecutePolicy renders a localized deny reason", async () => {
  const readOnly = [{ type: "sandbox/mode", data: { mode: "read-only" } }];
  const denied = (await preExecutePolicy(
    { name: "container_start", agent: { session: { events: readOnly } } },
    () => Promise.resolve({ kind: "allow" }),
    undefined,
    () => "zh",
  )) as { kind: string; reason: string };
  assert.equal(denied.kind, "deny");
  assert.equal(denied.reason, "已拒绝：当前会话为只读，而 “container_start” 需要写入权限。");
});
