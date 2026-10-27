// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// Localized text for the plugin's user-facing messages: approval reasons,
// policy denials, and the cache-cleanup notice. The host has no locale service,
// so the UI language arrives through the plugin's own volatile `uiLocale`
// preference, which the browser client writes.
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

// One template image: the base alone, or the base plus the packages the
// template adds on top of it.
export interface TemplateImageFact {
  base: string;
  // Extra packages the template installs; omitted for a base-only template.
  packages?: readonly string[];
}

// One secret environment entry: the variable the template sets and the secret
// it reads the value from.
export interface TemplateSecretEnvFact {
  env: string;
  secret: string;
}

// One port the template publishes. `host` is omitted when the gateway picks
// the host port.
export interface TemplatePortFact {
  container: number;
  host?: number;
}

// What an apply removes from the existing container: the current items absent
// from the staged template. A group the template leaves undeclared keeps its
// values, so its count is always zero.
export interface TemplateLoadRemovals {
  mounts: number;
  env: number;
  secretEnv: number;
  paths: number;
}

// The facts a template apply will act on, read from the template document and
// the existing container before the user approves it. It is structured so the
// renderer stays synchronous; the provider that reads it is asynchronous.
export interface TemplateLoadSummary {
  image: TemplateImageFact;
  mounts: readonly MountFact[];
  secretEnv: readonly TemplateSecretEnvFact[];
  ports: readonly TemplatePortFact[];
  envCount: number;
  pathCount: number;
  removals: TemplateLoadRemovals;
}

// The locale-independent shape of one gated call's reason. summarizeArgs builds
// it; renderReason turns it into the single-line headline.
export type ReasonFact =
  | {
    kind: "image_build";
    image: string;
    parent?: string;
    packages?: readonly string[];
  }
  | { kind: "image_rebuild"; image: string }
  | { kind: "image_rebuild_all" }
  | { kind: "image_remove"; image: string }
  | {
    kind: "container_start" | "container_recreate";
    container: string;
    image?: string;
    mounts?: readonly MountFact[];
    env?: readonly string[];
    secretEnv?: readonly string[];
    paths?: readonly string[];
  }
  | { kind: "container_remove"; container: string }
  | {
    kind: "container_template_load";
    template: string;
    container?: string;
    // Present when the host could read the template and the existing
    // container; absent keeps the base sentence alone.
    summary?: TemplateLoadSummary;
  }
  | {
    kind: "container_template_save";
    name: string;
    container: string;
    path: string;
  }
  | { kind: "container_mount_add"; container: string; mount: MountFact }
  | { kind: "container_mount_remove"; container: string; mount: MountFact }
  | { kind: "container_mount_update"; container: string; mount: MountFact }
  | {
    kind: "container_publish_port";
    container: string;
    port: number;
    protocol: string;
    suggestedHostPort?: number;
  }
  | {
    kind: "container_unpublish_port";
    container: string;
    port: number;
    protocol: string;
  }
  | { kind: "container_path_set"; container: string; paths: readonly string[] }
  | { kind: "container_path_add"; container: string; path: string }
  | { kind: "container_path_remove"; container: string; path: string }
  | {
    kind: "read_only_remount";
    tool: string;
    remount: readonly MountFact[];
    keep: readonly MountFact[];
  }
  | { kind: "volume_remove"; name: string }
  | { kind: "secret_remove"; name: string }
  | {
    kind: "container_secret_add";
    container: string;
    secret: string;
    env: string;
  }
  | { kind: "container_secret_remove"; container: string; env: string }
  | {
    kind: "container_bash";
    container: string;
    command: string;
    cwd?: string;
    uid?: number;
    gid?: number;
    groups?: readonly number[];
  }
  | {
    kind: "container_exec";
    container: string;
    argv: readonly string[];
    cwd?: string;
    uid?: number;
    gid?: number;
    groups?: readonly number[];
  }
  | { kind: "container_write"; container: string; path: string }
  | { kind: "container_edit"; container: string; path: string }
  | {
    kind: "daemon_start";
    container: string;
    argv: readonly string[];
    name?: string;
    uid?: number;
    gid?: number;
    groups?: readonly number[];
  };

// A policy denial. These surface as tool errors (not approval prompts) and stay
// in the session's language alongside the reason.
export type DenialFact =
  | { kind: "read_only"; tool: string }
  | { kind: "read_only_builtin"; tool: string }
  | { kind: "read_only_remount_declined"; tool: string }
  | { kind: "project_destination"; source?: string; mirror?: string };

// The locale to render approval text in, from the plugin's own volatile
// `uiLocale` preference (the browser client writes it); an unset value renders
// in English.
export function resolveReasonLocale(value: unknown): ReasonLocale {
  return reasonLocale(value);
}

// Normalize a BCP 47-style locale id to a shipped language; `zh-Hans`, `zh_CN`
// and friends all map to `zh`, everything else to English.
export function reasonLocale(value: unknown): ReasonLocale {
  if (typeof value !== "string") return "en";
  const primary = value.toLowerCase().split(/[-_]/, 1)[0];
  return primary === "zh" ? "zh" : "en";
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

// Render a mount's source name: `volume "data"`, `project "team/src"`,
// `secret "valkey-tls"`, or `tmpfs`.
function mountLabel(locale: ReasonLocale, mount: MountFact): string {
  const name = quoted(locale, mount.source);
  switch (mount.kind) {
    case "tmpfs":
      return "tmpfs";
    case "volume":
      return pick(locale, `volume ${name}`, `卷 ${name}`);
    case "secret":
      return pick(locale, `secret ${name}`, `机密 ${name}`);
    default:
      return pick(locale, `project ${name}`, `项目 ${name}`);
  }
}

// Render a mount's destination clause (`at "/data"` / `挂载到 “/data”`), or
// undefined when it has none. The caller supplies the surrounding punctuation,
// since the locales wrap it differently.
function mountDestinationText(
  locale: ReasonLocale,
  mount: MountFact,
): string | undefined {
  return mount.destination === undefined ? undefined : pick(
    locale,
    `at ${quoted(locale, mount.destination)}`,
    `挂载到 ${quoted(locale, mount.destination)}`,
  );
}

// Render a mount's source and destination: `volume "data" at "/data"`.
function mountSourceText(locale: ReasonLocale, mount: MountFact): string {
  const destination = mountDestinationText(locale, mount);
  const label = mountLabel(locale, mount);
  return destination === undefined ? label : `${label} ${destination}`;
}

// A mount's mode as a bare word (`read-only` / `read-write`), or undefined when
// the call carries no mode or the kind has none (tmpfs is always read-write and
// secrets take none).
function mountModeName(
  locale: ReasonLocale,
  mount: MountFact,
): string | undefined {
  if (
    mount.readOnly === undefined ||
    mount.kind === "tmpfs" ||
    mount.kind === "secret"
  ) {
    return undefined;
  }
  return mount.readOnly
    ? pick(locale, "read-only", "只读")
    : pick(locale, "read-write", "读写");
}

// Render one mount as `volume "data" at "/data" (read-only)`.
function mountText(locale: ReasonLocale, mount: MountFact): string {
  const mode = mountModeName(locale, mount);
  const suffix = mode === undefined
    ? ""
    : pick(locale, ` (${mode})`, `（${mode}）`);
  return `${mountSourceText(locale, mount)}${suffix}`;
}

// Render one template mount compactly for the apply summary. The template
// sentences keep Chinese naming tight against its quotation marks
// (`项目“app”`), so they cannot reuse mountText's spaced labels.
function templateMountText(locale: ReasonLocale, mount: MountFact): string {
  const name = quoted(locale, mount.source);
  const destination = mount.destination === undefined
    ? undefined
    : quoted(locale, mount.destination);
  const mode = mountModeName(locale, mount);
  const suffix = mode === undefined
    ? ""
    : pick(locale, ` (${mode})`, `（${mode}）`);
  switch (mount.kind) {
    case "tmpfs":
      return pick(
        locale,
        `tmpfs at ${destination ?? ""}`,
        `tmpfs 挂载到${destination ?? ""}`,
      );
    case "volume":
      return pick(
        locale,
        `volume ${name} at ${destination ?? ""}${suffix}`,
        `卷${name}挂载到${destination ?? ""}${suffix}`,
      );
    case "secret":
      return pick(
        locale,
        `secret ${name} at ${destination ?? ""}`,
        `机密${name}挂载到${destination ?? ""}`,
      );
    default:
      return pick(
        locale,
        `project ${name}${suffix}`,
        `项目${name}${suffix}`,
      );
  }
}

// Render a template's image: the base alone, or the base plus its extra
// packages.
function templateImageText(
  locale: ReasonLocale,
  image: TemplateImageFact,
): string {
  const packages = image.packages ?? [];
  if (packages.length === 0) {
    return pick(locale, `Image: ${image.base}.`, `镜像：${image.base}。`);
  }
  const count = packages.length;
  return pick(
    locale,
    `Image: ${image.base} plus ${count} ${
      count === 1 ? "package" : "packages"
    } (${packages.join(", ")}).`,
    `镜像：以 ${image.base} 为基础，另加 ${count} 个软件包（${
      packages.join("、")
    }）。`,
  );
}

// Render every mount the template stages, semicolon-separated.
function templateMountsText(
  locale: ReasonLocale,
  mounts: readonly MountFact[],
): string {
  if (mounts.length === 0) {
    return pick(locale, "Mounts: none.", "挂载：无。");
  }
  const list = mounts.map((mount) => templateMountText(locale, mount));
  return pick(
    locale,
    `Mounts: ${list.join("; ")}.`,
    `挂载：${list.join("；")}。`,
  );
}

// Render the template's secret environment entries, or "none" when it declares
// no secrets.
function templateSecretEnvText(
  locale: ReasonLocale,
  pairs: readonly TemplateSecretEnvFact[],
): string {
  if (pairs.length === 0) {
    return pick(locale, "Secret environment: none.", "机密环境变量：无。");
  }
  const list = pairs.map((pair) =>
    pick(
      locale,
      `${quoted(locale, pair.env)} from secret ${quoted(locale, pair.secret)}`,
      `${quoted(locale, pair.env)}来自机密${quoted(locale, pair.secret)}`,
    )
  );
  return pick(
    locale,
    `Secret environment: ${list.join("; ")}.`,
    `机密环境变量：${list.join("；")}。`,
  );
}

// Render the template's published ports, omitting the host port when the
// gateway will pick one.
function templatePortsText(
  locale: ReasonLocale,
  ports: readonly TemplatePortFact[],
): string {
  if (ports.length === 0) {
    return pick(locale, "Ports: none.", "端口：无。");
  }
  const list = ports.map((port) =>
    port.host === undefined
      ? pick(locale, `container ${port.container}`, `容器 ${port.container}`)
      : pick(
        locale,
        `container ${port.container} to host ${port.host}`,
        `容器 ${port.container} 映射到主机 ${port.host}`,
      )
  );
  return pick(
    locale,
    `Ports: ${list.join("; ")}.`,
    `端口：${list.join("；")}。`,
  );
}

// A count with its noun: `1 mount` / `2 mounts` and their Chinese unit.
function countedNoun(
  locale: ReasonLocale,
  count: number,
  singular: string,
  plural: string,
  zhUnit: string,
): string {
  return pick(
    locale,
    `${count} ${count === 1 ? singular : plural}`,
    `${count} ${zhUnit}`,
  );
}

// Render the environment and PATH counts. A zero group is omitted; when both
// are zero the sentence is omitted entirely.
function templateCountsText(
  locale: ReasonLocale,
  envCount: number,
  pathCount: number,
): string {
  const env = countedNoun(
    locale,
    envCount,
    "variable",
    "variables",
    "个",
  );
  const paths = countedNoun(locale, pathCount, "addition", "additions", "个");
  if (envCount > 0 && pathCount > 0) {
    return pick(
      locale,
      `Environment: ${env}. PATH: ${paths}.`,
      `环境变量：${env}；PATH 追加项：${paths}。`,
    );
  }
  if (envCount > 0) {
    return pick(locale, `Environment: ${env}.`, `环境变量：${env}。`);
  }
  if (pathCount > 0) {
    return pick(locale, `PATH: ${paths}.`, `PATH 追加项：${paths}。`);
  }
  return "";
}

// Join groups the way each locale lists them: `a, b and c` / `a、b和c`.
function joinGroups(locale: ReasonLocale, groups: readonly string[]): string {
  if (groups.length <= 1) return groups.join("");
  const head = groups.slice(0, -1).join(pick(locale, ", ", "、"));
  const tail = groups[groups.length - 1];
  return pick(locale, `${head} and ${tail}`, `${head}和 ${tail}`);
}

// Render how many current items the apply removes. Only non-zero groups are
// listed, and a zero total omits the sentence.
function templateRemovalsText(
  locale: ReasonLocale,
  removals: TemplateLoadRemovals,
): string {
  const groups: string[] = [];
  if (removals.mounts > 0) {
    groups.push(
      countedNoun(locale, removals.mounts, "mount", "mounts", "个挂载"),
    );
  }
  if (removals.env > 0) {
    groups.push(
      countedNoun(
        locale,
        removals.env,
        "environment variable",
        "environment variables",
        "个环境变量",
      ),
    );
  }
  if (removals.secretEnv > 0) {
    groups.push(
      countedNoun(
        locale,
        removals.secretEnv,
        "secret environment variable",
        "secret environment variables",
        "个机密环境变量",
      ),
    );
  }
  if (removals.paths > 0) {
    groups.push(
      countedNoun(
        locale,
        removals.paths,
        "PATH addition",
        "PATH additions",
        "个 PATH 追加项",
      ),
    );
  }
  if (groups.length === 0) return "";
  return pick(
    locale,
    `Removes ${joinGroups(locale, groups)}.`,
    `将移除 ${joinGroups(locale, groups)}。`,
  );
}

// Render a command word list, capped at 8 words with an ellipsis tail.
function argvText(argv: readonly string[]): string {
  const shown = argv.slice(0, 8).join(" ");
  return argv.length > 8 ? `${shown} …` : shown;
}

// identityText renders the process identity a call requests as a parenthesized
// suffix, or "" when it requests none. Shared by every tool that can run a
// process as another user.
function identityText(
  locale: ReasonLocale,
  fact: { uid?: number; gid?: number; groups?: readonly number[] },
): string {
  const ids: string[] = [];
  if (fact.uid !== undefined) ids.push(`uid ${fact.uid}`);
  if (fact.gid !== undefined) ids.push(`gid ${fact.gid}`);
  if (fact.groups !== undefined && fact.groups.length > 0) {
    ids.push(
      `groups ${joinList(locale, fact.groups.map((group) => String(group)))}`,
    );
  }
  return ids.length === 0
    ? ""
    : pick(locale, ` (${ids.join(", ")})`, `（${ids.join("、")}）`);
}

// Start/recreate share one shape; only the verb differs.
function containerRun(
  locale: ReasonLocale,
  fact: Extract<ReasonFact, { kind: "container_start" | "container_recreate" }>,
): string {
  const image = fact.image === undefined ? "" : pick(
    locale,
    ` from image ${quoted(locale, fact.image)}`,
    `（镜像 ${quoted(locale, fact.image)}）`,
  );
  const mounts = fact.mounts === undefined || fact.mounts.length === 0
    ? ""
    : pick(
      locale,
      ` with mounts: ${
        joinList(locale, fact.mounts.map((mount) => mountText(locale, mount)))
      }`,
      `，挂载：${
        joinList(locale, fact.mounts.map((mount) => mountText(locale, mount)))
      }`,
    );
  const env = fact.env === undefined || fact.env.length === 0 ? "" : pick(
    locale,
    ` with env: ${joinList(locale, fact.env)}`,
    `，环境变量：${joinList(locale, fact.env)}`,
  );
  const secretEnv = fact.secretEnv === undefined || fact.secretEnv.length === 0
    ? ""
    : pick(
      locale,
      ` with secret env: ${joinList(locale, fact.secretEnv)}`,
      `，机密环境变量：${joinList(locale, fact.secretEnv)}`,
    );
  const paths = fact.paths === undefined || fact.paths.length === 0 ? "" : pick(
    locale,
    ` with PATH additions: ${
      joinList(locale, fact.paths.map((path) => quoted(locale, path)))
    }`,
    `，PATH 附加项：${
      joinList(locale, fact.paths.map((path) => quoted(locale, path)))
    }`,
  );
  const verb = fact.kind === "container_start"
    ? pick(locale, "Start", "启动")
    : pick(locale, "Recreate", "重建");
  return pick(
    locale,
    `${verb} container ${
      quoted(locale, fact.container)
    }${image}${mounts}${env}${secretEnv}${paths}.`,
    `${verb}容器 ${
      quoted(locale, fact.container)
    }${image}${mounts}${env}${secretEnv}${paths}。`,
  );
}

// Render one reason as the single-line headline shown in the approval prompt.
// Reasons that end in a raw command keep no trailing period, so the command
// reads as typed.
export function renderReason(locale: ReasonLocale, fact: ReasonFact): string {
  switch (fact.kind) {
    case "image_build": {
      const parent = fact.parent === undefined ? "" : pick(
        locale,
        ` from ${quoted(locale, fact.parent)}`,
        `（基于 ${quoted(locale, fact.parent)}）`,
      );
      const packages = fact.packages === undefined ? "" : pick(
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
      return pick(
        locale,
        `Rebuild image ${quoted(locale, fact.image)}.`,
        `重建镜像 ${quoted(locale, fact.image)}。`,
      );
    case "image_rebuild_all":
      return pick(locale, "Rebuild all images.", "重建全部镜像。");
    case "image_remove":
      return pick(
        locale,
        `Remove image ${quoted(locale, fact.image)}.`,
        `移除镜像 ${quoted(locale, fact.image)}。`,
      );
    case "container_start":
    case "container_recreate":
      return containerRun(locale, fact);
    case "container_remove":
      return pick(
        locale,
        `Remove container ${quoted(locale, fact.container)}.`,
        `移除容器 ${quoted(locale, fact.container)}。`,
      );
    case "container_template_load": {
      const base = fact.container === undefined
        ? pick(
          locale,
          `Apply container template ${
            quoted(locale, fact.template)
          } to the default container.`,
          `将容器模板${quoted(locale, fact.template)}应用到默认容器。`,
        )
        : pick(
          locale,
          `Apply container template ${
            quoted(locale, fact.template)
          } to container ${quoted(locale, fact.container)}.`,
          `将容器模板${quoted(locale, fact.template)}应用到容器${
            quoted(locale, fact.container)
          }。`,
        );
      if (fact.summary === undefined) return base;
      const summary = fact.summary;
      const sentences = [
        templateImageText(locale, summary.image),
        templateMountsText(locale, summary.mounts),
        templateSecretEnvText(locale, summary.secretEnv),
        templatePortsText(locale, summary.ports),
        templateCountsText(locale, summary.envCount, summary.pathCount),
        templateRemovalsText(locale, summary.removals),
      ].filter((sentence) => sentence !== "");
      return pick(
        locale,
        [base, ...sentences].join(" "),
        base + sentences.join(""),
      );
    }
    case "container_template_save":
      return pick(
        locale,
        `Save container ${quoted(locale, fact.container)} as template ${
          quoted(locale, fact.name)
        } at ${quoted(locale, fact.path)}.`,
        `将容器 ${quoted(locale, fact.container)} 保存为模板 ${
          quoted(locale, fact.name)
        }，路径为 ${quoted(locale, fact.path)}。`,
      );
    case "container_mount_add":
      return pick(
        locale,
        `Add mount to container ${quoted(locale, fact.container)}: ${
          mountText(locale, fact.mount)
        }.`,
        `在容器 ${quoted(locale, fact.container)} 中添加挂载：${
          mountText(locale, fact.mount)
        }。`,
      );
    case "container_publish_port": {
      const target = `${fact.port}/${fact.protocol}`;
      const where = fact.suggestedHostPort === undefined
        ? pick(locale, "a free host port", "主机上的一个空闲端口")
        : pick(
          locale,
          `the host port ${fact.suggestedHostPort}`,
          `主机端口 ${fact.suggestedHostPort}`,
        );
      return pick(
        locale,
        `Publish ${target} from container ${
          quoted(locale, fact.container)
        } on ${where}; it becomes reachable on the host.`,
        `将容器 ${
          quoted(locale, fact.container)
        } 的 ${target} 发布到${where}；主机将可访问该端口。`,
      );
    }
    case "container_unpublish_port":
      return pick(
        locale,
        `Stop publishing ${fact.port}/${fact.protocol} from container ${
          quoted(locale, fact.container)
        }.`,
        `停止发布容器 ${
          quoted(locale, fact.container)
        } 的 ${fact.port}/${fact.protocol}。`,
      );
    case "container_mount_remove":
      return pick(
        locale,
        `Remove mount from container ${quoted(locale, fact.container)}: ${
          mountText(locale, fact.mount)
        }.`,
        `从容器 ${quoted(locale, fact.container)} 中移除挂载：${
          mountText(locale, fact.mount)
        }。`,
      );
    case "container_mount_update": {
      const destination = mountDestinationText(locale, fact.mount);
      const mode = mountModeName(locale, fact.mount) ?? "";
      // The zh sentence separates the mount from the verb with a space after a
      // quoted name, but a full-width parenthetical needs none.
      const target = destination === undefined
        ? `${mountLabel(locale, fact.mount)} `
        : `${mountLabel(locale, fact.mount)}（${destination}）`;
      return pick(
        locale,
        `Update mount in container ${quoted(locale, fact.container)}: remount ${
          mountSourceText(locale, fact.mount)
        } to ${mode}.`,
        `更新容器 ${
          quoted(locale, fact.container)
        } 中的挂载：将${target}重新挂载为${mode}。`,
      );
    }
    case "container_path_set": {
      const list = fact.paths.length === 0
        ? pick(locale, "(none)", "（无）")
        : joinList(locale, fact.paths.map((path) => quoted(locale, path)));
      return pick(
        locale,
        `Set the PATH additions of container ${
          quoted(locale, fact.container)
        }: ${list}.`,
        `设置容器 ${quoted(locale, fact.container)} 的 PATH 附加项：${list}。`,
      );
    }
    case "container_path_add":
      return pick(
        locale,
        `Add ${quoted(locale, fact.path)} to the PATH of container ${
          quoted(locale, fact.container)
        }.`,
        `将 ${quoted(locale, fact.path)} 添加到容器 ${
          quoted(locale, fact.container)
        } 的 PATH 中。`,
      );
    case "container_path_remove":
      return pick(
        locale,
        `Remove ${quoted(locale, fact.path)} from the PATH of container ${
          quoted(locale, fact.container)
        }.`,
        `从容器 ${quoted(locale, fact.container)} 的 PATH 中移除 ${
          quoted(locale, fact.path)
        }。`,
      );
    case "read_only_remount": {
      const remount = fact.remount
        .map((mount) => `- ${mountText(locale, mount)}`)
        .join("\n");
      const keep = fact.keep.length === 0 ? "" : pick(
        locale,
        `\n\nKept as-is: ${
          joinList(locale, fact.keep.map((mount) => mountText(locale, mount)))
        }.`,
        `\n\n保持不变：${
          joinList(locale, fact.keep.map((mount) => mountText(locale, mount)))
        }。`,
      );
      return pick(
        locale,
        `Read-only mode blocks ${
          quoted(locale, fact.tool)
        } while a mount is read-write. Remount these mounts read-only to run it:\n\n${remount}${keep}`,
        `只读模式在存在读写挂载时会阻止 ${
          quoted(locale, fact.tool)
        }。将这些挂载重新挂载为只读即可运行：\n\n${remount}${keep}`,
      );
    }
    case "volume_remove":
      return pick(
        locale,
        `Remove volume ${quoted(locale, fact.name)}.`,
        `移除卷 ${quoted(locale, fact.name)}。`,
      );
    case "secret_remove":
      return pick(
        locale,
        `Remove secret ${quoted(locale, fact.name)}.`,
        `移除机密 ${quoted(locale, fact.name)}。`,
      );
    case "container_secret_add":
      return pick(
        locale,
        `Attach secret ${quoted(locale, fact.secret)} to container ${
          quoted(locale, fact.container)
        } as ${quoted(locale, fact.env)}.`,
        `将机密 ${quoted(locale, fact.secret)} 作为 ${
          quoted(locale, fact.env)
        } 注入容器 ${quoted(locale, fact.container)}。`,
      );
    case "container_secret_remove":
      return pick(
        locale,
        `Detach secret env var ${quoted(locale, fact.env)} from container ${
          quoted(locale, fact.container)
        }.`,
        `从容器 ${quoted(locale, fact.container)} 中移除机密环境变量 ${
          quoted(locale, fact.env)
        }。`,
      );
    case "container_bash": {
      const cwd = fact.cwd === undefined ? "" : pick(
        locale,
        ` (cwd ${quoted(locale, fact.cwd)})`,
        `（工作目录 ${quoted(locale, fact.cwd)}）`,
      );
      const identity = identityText(locale, fact);
      return pick(
        locale,
        `Run a shell command in container ${
          quoted(locale, fact.container)
        }${cwd}: ${fact.command}${identity}`,
        `在容器 ${
          quoted(locale, fact.container)
        }${cwd} 中运行 shell 命令：${fact.command}${identity}`,
      );
    }
    case "container_exec": {
      const cwd = fact.cwd === undefined ? "" : pick(
        locale,
        ` (cwd ${quoted(locale, fact.cwd)})`,
        `（工作目录 ${quoted(locale, fact.cwd)}）`,
      );
      const identity = identityText(locale, fact);
      return pick(
        locale,
        `Run a command in container ${quoted(locale, fact.container)}${cwd}: ${
          argvText(fact.argv)
        }${identity}`,
        `在容器 ${quoted(locale, fact.container)}${cwd} 中运行命令：${
          argvText(fact.argv)
        }${identity}`,
      );
    }
    case "container_write":
      return pick(
        locale,
        `Write ${quoted(locale, fact.path)} in container ${
          quoted(locale, fact.container)
        }.`,
        `在容器 ${quoted(locale, fact.container)} 中写入 ${
          quoted(locale, fact.path)
        }。`,
      );
    case "container_edit":
      return pick(
        locale,
        `Edit ${quoted(locale, fact.path)} in container ${
          quoted(locale, fact.container)
        }.`,
        `在容器 ${quoted(locale, fact.container)} 中编辑 ${
          quoted(locale, fact.path)
        }。`,
      );
    case "daemon_start": {
      const named = fact.name === undefined
        ? ""
        : ` ${quoted(locale, fact.name)}`;
      const suffix = identityText(locale, fact);
      return pick(
        locale,
        `Start daemon${named} in container ${quoted(locale, fact.container)}: ${
          argvText(fact.argv)
        }${suffix}`,
        `在容器 ${quoted(locale, fact.container)} 中启动守护进程${named}：${
          argvText(fact.argv)
        }${suffix}`,
      );
    }
  }
}

// Render the settings notice shown after a cache cleanup. The card already
// shows the resulting sizes, so the notice only names how many files went.
export function renderCacheCleanNotice(
  locale: ReasonLocale,
  files: number,
): string {
  return pick(
    locale,
    `removed ${files} cached ${files === 1 ? "file" : "files"}`,
    `已移除 ${files} 个缓存文件`,
  );
}

// Render the settings notice shown after a port was published. The gateway may
// have chosen the host port when the caller suggested none, so the notice names
// the endpoint it reported rather than the port that was asked for.
export function renderPublishNotice(
  locale: ReasonLocale,
  endpoint: string,
): string {
  return pick(locale, `published on ${endpoint}`, `已发布到 ${endpoint}`);
}

// Render the settings notice shown after the default environment was applied
// to existing containers: how many were recreated, and how many stopped
// containers were left for their next start.
export function renderDefaultEnvSyncNotice(
  locale: ReasonLocale,
  applied: number,
  skipped: number,
): string {
  const containers = (count: number): string =>
    pick(
      locale,
      `${count} container${count === 1 ? "" : "s"}`,
      `${count} 个容器`,
    );
  if (applied === 0 && skipped === 0) {
    return pick(
      locale,
      "the default environment is already applied to every running container",
      "默认环境已应用于所有运行中的容器",
    );
  }
  if (applied === 0) {
    return pick(
      locale,
      `no running container needed the default environment; ${
        containers(skipped)
      } stopped`,
      `没有运行中的容器需要默认环境；已跳过 ${containers(skipped)}`,
    );
  }
  const suffix = skipped === 0 ? "" : pick(
    locale,
    `; ${containers(skipped)} stopped, to pick up on their next start`,
    `；已跳过 ${containers(skipped)}，将在下次启动时生效`,
  );
  return pick(
    locale,
    `applied the default environment to ${containers(applied)}${suffix}`,
    `已将默认环境应用于 ${containers(applied)}${suffix}`,
  );
}

// Render one policy denial.
export function renderDenial(locale: ReasonLocale, fact: DenialFact): string {
  switch (fact.kind) {
    case "read_only":
      return pick(
        locale,
        `Denied: the session is read-only, but ${
          quoted(locale, fact.tool)
        } needs write access.`,
        `已拒绝：当前会话为只读，而 ${
          quoted(locale, fact.tool)
        } 需要写入权限。`,
      );
    case "read_only_builtin":
      return pick(
        locale,
        `Denied: the session is read-only, but ${
          quoted(locale, fact.tool)
        } can modify files.`,
        `已拒绝：当前会话为只读，而 ${
          quoted(locale, fact.tool)
        } 可能修改文件。`,
      );
    case "read_only_remount_declined":
      return pick(
        locale,
        `Denied: read-only mode blocks ${
          quoted(locale, fact.tool)
        } and the mounts were not remounted.`,
        `已拒绝：只读模式阻止 ${
          quoted(locale, fact.tool)
        }，且挂载未被重新挂载。`,
      );
    case "project_destination": {
      if (fact.mirror === undefined || fact.mirror === "") {
        return pick(
          locale,
          "Project mounts cannot set a destination.",
          "项目挂载不能指定目标路径。",
        );
      }
      const source = fact.source === undefined || fact.source === ""
        ? pick(locale, "the project", "该项目")
        : quoted(locale, fact.source);
      return pick(
        locale,
        `Project mounts cannot set a destination; ${source} always mounts at ${
          quoted(locale, fact.mirror)
        }.`,
        `项目挂载不能指定目标路径；${source} 始终挂载到 ${
          quoted(locale, fact.mirror)
        }。`,
      );
    }
  }
}
