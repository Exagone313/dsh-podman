// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { CONTAINER_NS } from "./settings-schema.js";

// Localized text for the plugin's user-facing messages: approval reasons,
// policy denials, and the cache-cleanup notice. The host has no locale service,
// so the UI language arrives through settings: the browser client writes its
// active locale into the plugin namespace (`uiLocale`) and the durable user
// preference (`locale.preference`) is the fallback.
export type ReasonLocale = "en" | "zh";

// One mount as a reason renders it.
export interface MountFact {
  kind: "project" | "volume" | "tmpfs" | "secret";
  // Project path (`team/src`), volume name, secret name, or empty for tmpfs.
  source: string;
  destination?: string;
  // The mount's mode when the call carries one; undefined when it does not
  // (removal has no mode, and the mount's current mode is not known here).
  readOnly?: boolean;
}

// The locale-independent shape of one gated call's reason. summarizeArgs builds
// it; renderReason turns it into the single-line headline.
export type ReasonFact =
  | { kind: "image_build"; image: string; parent?: string; packages?: readonly string[] }
  | { kind: "image_rebuild"; image: string }
  | { kind: "image_rebuild_all" }
  | { kind: "image_remove"; image: string }
  | {
      kind: "container_start" | "container_recreate";
      container: string;
      image?: string;
      mounts?: readonly MountFact[];
      env?: readonly string[];
    }
  | { kind: "container_remove"; container: string }
  | { kind: "container_mount_add"; container: string; mount: MountFact }
  | { kind: "container_mount_remove"; container: string; mount: MountFact }
  | { kind: "container_mount_update"; container: string; mount: MountFact }
  | { kind: "volume_remove"; name: string }
  | { kind: "secret_remove"; name: string }
  | { kind: "container_secret_add"; container: string; secret: string; env: string }
  | { kind: "container_secret_remove"; container: string; env: string }
  | { kind: "container_bash"; container: string; command: string; cwd?: string }
  | { kind: "container_exec"; container: string; argv: readonly string[]; cwd?: string }
  | { kind: "container_write"; container: string; path: string }
  | { kind: "container_edit"; container: string; path: string }
  | {
      kind: "daemon_start";
      container: string;
      argv: readonly string[];
      name?: string;
      uid?: number;
      gid?: number;
    };

// A policy denial. These surface as tool errors (not approval prompts) and stay
// in the session's language alongside the reason.
export type DenialFact =
  | { kind: "read_only"; tool: string }
  | { kind: "read_only_builtin"; tool: string }
  | { kind: "project_destination"; source?: string; mirror?: string };

// Settings namespace owned by the browser locale plugin; only read here.
const LOCALE_NS = "locale";
const LOCALE_PREFERENCE_FIELD = "preference";

// A reader over registered settings namespaces (the host SettingsProvider's
// `get(ns)`); typed structurally so this module stays dependency-free.
export interface SettingsReader {
  get(ns: string): unknown;
}

// The locale to render approval text in: the client-observed active locale
// first (it also captures the browser default), then the durable user
// preference, then English.
export function resolveReasonLocale(settings: SettingsReader | undefined): ReasonLocale {
  if (settings === undefined) return "en";
  const observed = field(settings.get(CONTAINER_NS), "uiLocale");
  if (typeof observed === "string" && observed !== "") return reasonLocale(observed);
  return reasonLocale(field(settings.get(LOCALE_NS), LOCALE_PREFERENCE_FIELD));
}

// Normalize a BCP 47-style locale id to a shipped language; `zh-Hans`, `zh_CN`
// and friends all map to `zh`, everything else to English.
export function reasonLocale(value: unknown): ReasonLocale {
  if (typeof value !== "string") return "en";
  const primary = value.toLowerCase().split(/[-_]/, 1)[0];
  return primary === "zh" ? "zh" : "en";
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

// Pick the locale's variant of one string.
function pick(locale: ReasonLocale, en: string, zh: string): string {
  return locale === "zh" ? zh : en;
}

// Quote one identifier with the locale's quote marks.
function quoted(locale: ReasonLocale, value: string): string {
  return pick(locale, `"${value}"`, `“${value}”`);
}

// Join list elements, capping at 8 with a localized "more" tail.
const LIST_CAP = 8;

function joinList(locale: ReasonLocale, items: readonly string[]): string {
  if (items.length === 0) return "";
  const separator = pick(locale, ", ", "、");
  const shown = items.slice(0, LIST_CAP).join(separator);
  const extra = items.length - LIST_CAP;
  return extra > 0
    ? pick(locale, `${shown}, +${extra} more`, `${shown}，另有 ${extra} 项`)
    : shown;
}

// Render one mount as `volume "data" at "/data" (read-only)`. The mode is
// named only when the call carries one and the kind has a mode (tmpfs is
// always read-write and secrets take none).
function mountText(locale: ReasonLocale, mount: MountFact): string {
  const name = quoted(locale, mount.source);
  const source =
    mount.kind === "tmpfs"
      ? "tmpfs"
      : mount.kind === "volume"
        ? pick(locale, `volume ${name}`, `卷 ${name}`)
        : mount.kind === "secret"
          ? pick(locale, `secret ${name}`, `机密 ${name}`)
          : pick(locale, `directory ${name}`, `目录 ${name}`);
  const destination =
    mount.destination === undefined
      ? ""
      : pick(
          locale,
          ` at ${quoted(locale, mount.destination)}`,
          ` 挂载到 ${quoted(locale, mount.destination)}`,
        );
  const mode =
    mount.readOnly === undefined ||
    mount.kind === "tmpfs" ||
    mount.kind === "secret"
      ? ""
      : mount.readOnly
        ? pick(locale, " (read-only)", "（只读）")
        : pick(locale, " (read-write)", "（读写）");
  return `${source}${destination}${mode}`;
}

// Render a command word list, capped at 8 words with an ellipsis tail.
function argvText(argv: readonly string[]): string {
  const shown = argv.slice(0, 8).join(" ");
  return argv.length > 8 ? `${shown} …` : shown;
}

// Start/recreate share one shape; only the verb differs.
function containerRun(
  locale: ReasonLocale,
  fact: Extract<ReasonFact, { kind: "container_start" | "container_recreate" }>,
): string {
  const image =
    fact.image === undefined
      ? ""
      : pick(locale, ` from image ${quoted(locale, fact.image)}`, `（镜像 ${quoted(locale, fact.image)}）`);
  const mounts =
    fact.mounts === undefined || fact.mounts.length === 0
      ? ""
      : pick(
          locale,
          ` with mounts: ${joinList(locale, fact.mounts.map((mount) => mountText(locale, mount)))}`,
          `，挂载：${joinList(locale, fact.mounts.map((mount) => mountText(locale, mount)))}`,
        );
  const env =
    fact.env === undefined || fact.env.length === 0
      ? ""
      : pick(
          locale,
          ` with env: ${joinList(locale, fact.env)}`,
          `，环境变量：${joinList(locale, fact.env)}`,
        );
  const verb =
    fact.kind === "container_start"
      ? pick(locale, "Start", "启动")
      : pick(locale, "Recreate", "重建");
  return pick(
    locale,
    `${verb} container ${quoted(locale, fact.container)}${image}${mounts}${env}.`,
    `${verb}容器 ${quoted(locale, fact.container)}${image}${mounts}${env}。`,
  );
}

// Render one reason as the single-line headline shown in the approval prompt.
// Reasons that end in a raw command keep no trailing period, so the command
// reads as typed.
export function renderReason(locale: ReasonLocale, fact: ReasonFact): string {
  switch (fact.kind) {
    case "image_build": {
      const parent =
        fact.parent === undefined
          ? ""
          : pick(locale, ` from ${quoted(locale, fact.parent)}`, `（基于 ${quoted(locale, fact.parent)}）`);
      const packages =
        fact.packages === undefined
          ? ""
          : pick(
              locale,
              ` with packages: ${joinList(locale, fact.packages)}`,
              `，软件包：${joinList(locale, fact.packages)}`,
            );
      return pick(
        locale,
        `Build image ${quoted(locale, fact.image)}${parent}${packages}.`,
        `构建镜像 ${quoted(locale, fact.image)}${parent}${packages}。`,
      );
    }
    case "image_rebuild":
      return pick(locale, `Rebuild image ${quoted(locale, fact.image)}.`, `重建镜像 ${quoted(locale, fact.image)}。`);
    case "image_rebuild_all":
      return pick(locale, "Rebuild all images.", "重建全部镜像。");
    case "image_remove":
      return pick(locale, `Remove image ${quoted(locale, fact.image)}.`, `移除镜像 ${quoted(locale, fact.image)}。`);
    case "container_start":
    case "container_recreate":
      return containerRun(locale, fact);
    case "container_remove":
      return pick(
        locale,
        `Remove container ${quoted(locale, fact.container)}.`,
        `移除容器 ${quoted(locale, fact.container)}。`,
      );
    case "container_mount_add":
      return pick(
        locale,
        `Add mount to container ${quoted(locale, fact.container)}: ${mountText(locale, fact.mount)}.`,
        `在容器 ${quoted(locale, fact.container)} 中添加挂载：${mountText(locale, fact.mount)}。`,
      );
    case "container_mount_remove":
      return pick(
        locale,
        `Remove mount from container ${quoted(locale, fact.container)}: ${mountText(locale, fact.mount)}.`,
        `从容器 ${quoted(locale, fact.container)} 中移除挂载：${mountText(locale, fact.mount)}。`,
      );
    case "container_mount_update":
      return pick(
        locale,
        `Change the mount mode in container ${quoted(locale, fact.container)}: ${mountText(locale, fact.mount)}.`,
        `更改容器 ${quoted(locale, fact.container)} 中挂载的模式：${mountText(locale, fact.mount)}。`,
      );
    case "volume_remove":
      return pick(locale, `Remove volume ${quoted(locale, fact.name)}.`, `移除卷 ${quoted(locale, fact.name)}。`);
    case "secret_remove":
      return pick(locale, `Remove secret ${quoted(locale, fact.name)}.`, `移除机密 ${quoted(locale, fact.name)}。`);
    case "container_secret_add":
      return pick(
        locale,
        `Attach secret ${quoted(locale, fact.secret)} to container ${quoted(locale, fact.container)} as ${quoted(locale, fact.env)}.`,
        `将机密 ${quoted(locale, fact.secret)} 作为 ${quoted(locale, fact.env)} 注入容器 ${quoted(locale, fact.container)}。`,
      );
    case "container_secret_remove":
      return pick(
        locale,
        `Detach secret env var ${quoted(locale, fact.env)} from container ${quoted(locale, fact.container)}.`,
        `从容器 ${quoted(locale, fact.container)} 中移除机密环境变量 ${quoted(locale, fact.env)}。`,
      );
    case "container_bash": {
      const cwd =
        fact.cwd === undefined
          ? ""
          : pick(locale, ` (cwd ${quoted(locale, fact.cwd)})`, `（工作目录 ${quoted(locale, fact.cwd)}）`);
      return pick(
        locale,
        `Run a shell command in container ${quoted(locale, fact.container)}${cwd}: ${fact.command}`,
        `在容器 ${quoted(locale, fact.container)}${cwd} 中运行 shell 命令：${fact.command}`,
      );
    }
    case "container_exec": {
      const cwd =
        fact.cwd === undefined
          ? ""
          : pick(locale, ` (cwd ${quoted(locale, fact.cwd)})`, `（工作目录 ${quoted(locale, fact.cwd)}）`);
      return pick(
        locale,
        `Run a command in container ${quoted(locale, fact.container)}${cwd}: ${argvText(fact.argv)}`,
        `在容器 ${quoted(locale, fact.container)}${cwd} 中运行命令：${argvText(fact.argv)}`,
      );
    }
    case "container_write":
      return pick(
        locale,
        `Write ${quoted(locale, fact.path)} in container ${quoted(locale, fact.container)}.`,
        `在容器 ${quoted(locale, fact.container)} 中写入 ${quoted(locale, fact.path)}。`,
      );
    case "container_edit":
      return pick(
        locale,
        `Edit ${quoted(locale, fact.path)} in container ${quoted(locale, fact.container)}.`,
        `在容器 ${quoted(locale, fact.container)} 中编辑 ${quoted(locale, fact.path)}。`,
      );
    case "daemon_start": {
      const named = fact.name === undefined ? "" : ` ${quoted(locale, fact.name)}`;
      const ids: string[] = [];
      if (fact.uid !== undefined) ids.push(`uid ${fact.uid}`);
      if (fact.gid !== undefined) ids.push(`gid ${fact.gid}`);
      const suffix = ids.length === 0 ? "" : pick(locale, ` (${ids.join(", ")})`, `（${ids.join("、")}）`);
      return pick(
        locale,
        `Start daemon${named} in container ${quoted(locale, fact.container)}: ${argvText(fact.argv)}${suffix}`,
        `在容器 ${quoted(locale, fact.container)} 中启动守护进程${named}：${argvText(fact.argv)}${suffix}`,
      );
    }
  }
}

// Render the settings notice shown after a cache cleanup. The card already
// shows the resulting sizes, so the notice only names how many files went.
export function renderCacheCleanNotice(locale: ReasonLocale, files: number): string {
  return pick(
    locale,
    `removed ${files} cached ${files === 1 ? "file" : "files"}`,
    `已移除 ${files} 个缓存文件`,
  );
}

// Render one policy denial.
export function renderDenial(locale: ReasonLocale, fact: DenialFact): string {
  switch (fact.kind) {
    case "read_only":
      return pick(
        locale,
        `Denied: the session is read-only, but ${quoted(locale, fact.tool)} needs write access.`,
        `已拒绝：当前会话为只读，而 ${quoted(locale, fact.tool)} 需要写入权限。`,
      );
    case "read_only_builtin":
      return pick(
        locale,
        `Denied: the session is read-only, but ${quoted(locale, fact.tool)} can modify files.`,
        `已拒绝：当前会话为只读，而 ${quoted(locale, fact.tool)} 可能修改文件。`,
      );
    case "project_destination": {
      if (fact.mirror === undefined || fact.mirror === "") {
        return pick(
          locale,
          "Project mounts cannot set a destination.",
          "项目挂载不能指定目标路径。",
        );
      }
      const source =
        fact.source === undefined || fact.source === ""
          ? pick(locale, "the directory", "该目录")
          : quoted(locale, fact.source);
      return pick(
        locale,
        `Project mounts cannot set a destination; ${source} always mounts at ${quoted(locale, fact.mirror)}.`,
        `项目挂载不能指定目标路径；${source} 始终挂载到 ${quoted(locale, fact.mirror)}。`,
      );
    }
  }
}
