// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import test from "node:test";
import assert from "node:assert/strict";
import {
  reasonLocale,
  renderCacheCleanNotice,
  renderDefaultEnvSyncNotice,
  renderDenial,
  renderPublishNotice,
  renderReason,
  resolveReasonLocale,
  type TemplateLoadSummary,
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

test("resolveReasonLocale reads the plugin's recorded locale", () => {
  assert.equal(resolveReasonLocale(undefined), "en");
  assert.equal(resolveReasonLocale(""), "en");
  assert.equal(resolveReasonLocale("zh"), "zh");
  assert.equal(resolveReasonLocale("zh-Hans"), "zh");
  assert.equal(resolveReasonLocale("en"), "en");
  assert.equal(resolveReasonLocale(42), "en");
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
  assert.equal(
    renderReason("en", { kind: "image_rebuild_all" }),
    "Rebuild all images.",
  );
  assert.equal(
    renderReason("zh", { kind: "image_rebuild_all" }),
    "重建全部镜像。",
  );
  assert.equal(
    renderReason("zh", {
      kind: "daemon_start",
      container: "c",
      argv: ["x"],
      uid: 1,
    }),
    "在容器 “c” 中启动守护进程：x（uid 1）",
  );
  assert.equal(
    renderReason("zh", {
      kind: "container_bash",
      container: "c",
      command: "id",
      uid: 1,
      groups: [3, 4],
    }),
    "在容器 “c” 中运行 shell 命令：id（uid 1、groups 3、4）",
  );
  assert.equal(
    renderReason("zh", {
      kind: "container_secret_add",
      container: "c",
      secret: "s",
      env: "E",
    }),
    "将机密 “s” 作为 “E” 注入容器 “c”。",
  );
  assert.equal(
    renderReason("zh", {
      kind: "container_mount_update",
      container: "valkey-ctr",
      mount: {
        kind: "volume",
        source: "valkey-data",
        destination: "/data",
        readOnly: false,
      },
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

test("renderPublishNotice names the endpoint the gateway bound", () => {
  assert.equal(
    renderPublishNotice("en", "tcp://127.0.0.1:26000"),
    "published on tcp://127.0.0.1:26000",
  );
  assert.equal(
    renderPublishNotice("zh", "tcp://127.0.0.1:26000"),
    "已发布到 tcp://127.0.0.1:26000",
  );
});

test("renderReason renders the read-only remount plan", () => {
  assert.equal(
    renderReason("en", {
      kind: "read_only_remount",
      tool: "bash",
      remount: [
        { kind: "project", source: "team", readOnly: false },
        {
          kind: "volume",
          source: "data",
          destination: "/data",
          readOnly: false,
        },
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

test("renderDefaultEnvSyncNotice renders both languages", () => {
  assert.equal(
    renderDefaultEnvSyncNotice("en", 2, 0),
    "applied the default environment to 2 containers",
  );
  assert.equal(
    renderDefaultEnvSyncNotice("en", 1, 2),
    "applied the default environment to 1 container; 2 containers stopped, to pick up on their next start",
  );
  assert.equal(
    renderDefaultEnvSyncNotice("en", 0, 1),
    "no running container needed the default environment; 1 container stopped",
  );
  assert.equal(
    renderDefaultEnvSyncNotice("en", 0, 0),
    "the default environment is already applied to every running container",
  );
  assert.equal(
    renderDefaultEnvSyncNotice("zh", 2, 0),
    "已将默认环境应用于 2 个容器",
  );
  assert.equal(
    renderDefaultEnvSyncNotice("zh", 0, 1),
    "没有运行中的容器需要默认环境；已跳过 1 个容器",
  );
});

test("preExecutePolicy renders a localized deny reason", async () => {
  const denied = (await preExecutePolicy(
    {
      name: "container_start",
      agent: { session: { facts: { mode: "read-only" } } },
    },
    () => Promise.resolve({ kind: "allow" }),
    undefined,
    () => "zh",
    testReadSession,
  )) as { kind: string; reason: string };
  assert.equal(denied.kind, "deny");
  assert.equal(
    denied.reason,
    "已拒绝：当前会话为只读，而 “container_start” 需要写入权限。",
  );
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
  assert.equal(
    denied.reason,
    "已拒绝：当前会话为只读，而 “bash” 可能修改文件。",
  );
});

const DEVELOP_SUMMARY: TemplateLoadSummary = {
  image: {
    base: "archlinux",
    packages: ["go", "nodejs", "npm", "python-chardet", "reuse"],
  },
  mounts: [
    { kind: "project", source: "dsh-podman", readOnly: false },
    { kind: "project", source: "deepseek-harness", readOnly: true },
    {
      kind: "volume",
      source: "dsh-podman-toolchain",
      destination: "/opt/toolchain",
      readOnly: false,
    },
  ],
  secretEnv: [],
  ports: [],
  envCount: 7,
  pathCount: 3,
  removals: { mounts: 0, env: 0, secretEnv: 0, paths: 0 },
};

test("a template apply summary renders every fact in English", () => {
  assert.equal(
    renderReason("en", {
      kind: "container_template_load",
      template: "develop",
      container: "default",
      summary: DEVELOP_SUMMARY,
    }),
    'Apply container template "develop" to container "default". Image: archlinux plus 5 packages (go, nodejs, npm, python-chardet, reuse). Mounts: project "dsh-podman" (read-write); project "deepseek-harness" (read-only); volume "dsh-podman-toolchain" at "/opt/toolchain" (read-write). Secret environment: none. Ports: none. Environment: 7 variables. PATH: 3 additions.',
  );
});

test("a template apply summary renders every fact in Chinese", () => {
  assert.equal(
    renderReason("zh", {
      kind: "container_template_load",
      template: "develop",
      container: "default",
      summary: DEVELOP_SUMMARY,
    }),
    "将容器模板“develop”应用到容器“default”。镜像：以 archlinux 为基础，另加 5 个软件包（go、nodejs、npm、python-chardet、reuse）。挂载：项目“dsh-podman”（读写）；项目“deepseek-harness”（只读）；卷“dsh-podman-toolchain”挂载到“/opt/toolchain”（读写）。机密环境变量：无。端口：无。环境变量：7 个；PATH 追加项：3 个。",
  );
});

test("a template apply summary names secrets, ports and a base-only image", () => {
  const summary: TemplateLoadSummary = {
    image: { base: "ubuntu" },
    mounts: [
      { kind: "tmpfs", source: "", destination: "/scratch" },
      {
        kind: "secret",
        source: "npm-token",
        destination: "/run/secrets/npm",
      },
    ],
    secretEnv: [{ env: "NPM_TOKEN", secret: "npm-token" }],
    ports: [{ container: 8080, host: 9090 }],
    envCount: 2,
    pathCount: 1,
    removals: { mounts: 0, env: 0, secretEnv: 0, paths: 0 },
  };
  assert.equal(
    renderReason("en", {
      kind: "container_template_load",
      template: "web",
      container: "web",
      summary,
    }),
    'Apply container template "web" to container "web". Image: ubuntu. Mounts: tmpfs at "/scratch"; secret "npm-token" at "/run/secrets/npm". Secret environment: "NPM_TOKEN" from secret "npm-token". Ports: container 8080 to host 9090. Environment: 2 variables. PATH: 1 addition.',
  );
  assert.equal(
    renderReason("zh", {
      kind: "container_template_load",
      template: "web",
      container: "web",
      summary,
    }),
    "将容器模板“web”应用到容器“web”。镜像：ubuntu。挂载：tmpfs 挂载到“/scratch”；机密“npm-token”挂载到“/run/secrets/npm”。机密环境变量：“NPM_TOKEN”来自机密“npm-token”。端口：容器 8080 映射到主机 9090。环境变量：2 个；PATH 追加项：1 个。",
  );
});

test("a template apply summary omits a port's host when the gateway picks it", () => {
  const summary: TemplateLoadSummary = {
    image: { base: "alpine" },
    mounts: [],
    secretEnv: [],
    ports: [{ container: 8080 }],
    envCount: 0,
    pathCount: 0,
    removals: { mounts: 0, env: 0, secretEnv: 0, paths: 0 },
  };
  assert.equal(
    renderReason("en", {
      kind: "container_template_load",
      template: "web",
      summary,
    }),
    'Apply container template "web" to the default container. Image: alpine. Mounts: none. Secret environment: none. Ports: container 8080.',
  );
  assert.equal(
    renderReason("zh", {
      kind: "container_template_load",
      template: "web",
      summary,
    }),
    "将容器模板“web”应用到默认容器。镜像：alpine。挂载：无。机密环境变量：无。端口：容器 8080。",
  );
});

test("a template apply summary counts every non-zero removal group", () => {
  const summary: TemplateLoadSummary = {
    ...DEVELOP_SUMMARY,
    removals: { mounts: 1, env: 2, secretEnv: 1, paths: 3 },
  };
  assert.equal(
    renderReason("en", {
      kind: "container_template_load",
      template: "develop",
      container: "default",
      summary,
    }),
    'Apply container template "develop" to container "default". Image: archlinux plus 5 packages (go, nodejs, npm, python-chardet, reuse). Mounts: project "dsh-podman" (read-write); project "deepseek-harness" (read-only); volume "dsh-podman-toolchain" at "/opt/toolchain" (read-write). Secret environment: none. Ports: none. Environment: 7 variables. PATH: 3 additions. Removes 1 mount, 2 environment variables, 1 secret environment variable and 3 PATH additions.',
  );
  assert.equal(
    renderReason("zh", {
      kind: "container_template_load",
      template: "develop",
      container: "default",
      summary,
    }),
    "将容器模板“develop”应用到容器“default”。镜像：以 archlinux 为基础，另加 5 个软件包（go、nodejs、npm、python-chardet、reuse）。挂载：项目“dsh-podman”（读写）；项目“deepseek-harness”（只读）；卷“dsh-podman-toolchain”挂载到“/opt/toolchain”（读写）。机密环境变量：无。端口：无。环境变量：7 个；PATH 追加项：3 个。将移除 1 个挂载、2 个环境变量、1 个机密环境变量和 3 个 PATH 追加项。",
  );
});

test("a template apply summary counts a single removal without plurals", () => {
  assert.equal(
    renderReason("en", {
      kind: "container_template_load",
      template: "web",
      container: "web",
      summary: {
        ...DEVELOP_SUMMARY,
        removals: { mounts: 1, env: 0, secretEnv: 0, paths: 0 },
      },
    }).endsWith(" Removes 1 mount."),
    true,
  );
  assert.equal(
    renderReason("zh", {
      kind: "container_template_load",
      template: "web",
      container: "web",
      summary: {
        ...DEVELOP_SUMMARY,
        removals: { mounts: 0, env: 0, secretEnv: 0, paths: 2 },
      },
    }).endsWith("将移除 2 个 PATH 追加项。"),
    true,
  );
});
