// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { useState, type CSSProperties, type ReactNode } from "react";
import {
  DisclosureRow,
  IconApiOutline14,
  IconArchiveOutline20,
  IconBrowseOutline16,
  IconDataOutline16,
  IconEditOutline16,
  IconFolderOpenOutline16,
  IconLinkOutline16,
  IconPlayOutline16,
  IconPlusOutline16,
  IconRefreshOutline16,
  IconSearchOutline16,
  IconSparkle16,
  IconStopFill16,
  IconTrashOutline16,
  StateDot,
  TerminalBlock,
  type TerminalBlockLabels,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { PropsLocale, TranslateNS } from "@deepseek-ai/dsh-client-ui-slots";
import type { ToolCallViewProps } from "@deepseek-ai/dsh-client-ui-tool/client";
import { NS, type ContainerPluginKey } from "./locales.js";
import { TERMINAL_CLASS } from "./terminal-styles.js";

// A domain-owned row for every podman tool, registered over the keyed
// `tool.call.toolview` slot. Without it the shipped client renders each call as
// "Tool call · <tool name>"; this row owns the icon, title, summary and body.

interface ToolPresentation {
  readonly titleKey: ContainerPluginKey;
  readonly icon: ReactNode;
  readonly summaryKeys: readonly string[];
}

const TOOL_PRESENTATION: Record<string, ToolPresentation> = {
  container_bash: { titleKey: "toolTitle_container_bash", icon: <IconApiOutline14 size={14} />, summaryKeys: ["description", "command"] },
  container_exec: { titleKey: "toolTitle_container_exec", icon: <IconApiOutline14 size={14} />, summaryKeys: ["description", "argv"] },
  container_read: { titleKey: "toolTitle_container_read", icon: <IconBrowseOutline16 size={14} />, summaryKeys: ["file_path"] },
  container_write: { titleKey: "toolTitle_container_write", icon: <IconEditOutline16 size={14} />, summaryKeys: ["file_path"] },
  container_edit: { titleKey: "toolTitle_container_edit", icon: <IconEditOutline16 size={14} />, summaryKeys: ["file_path"] },
  container_glob: { titleKey: "toolTitle_container_glob", icon: <IconSearchOutline16 size={14} />, summaryKeys: ["pattern"] },
  container_grep: { titleKey: "toolTitle_container_grep", icon: <IconSearchOutline16 size={14} />, summaryKeys: ["pattern"] },
  container_list: { titleKey: "toolTitle_container_list", icon: <IconDataOutline16 size={14} />, summaryKeys: [] },
  container_start: { titleKey: "toolTitle_container_start", icon: <IconPlayOutline16 size={14} />, summaryKeys: ["container", "image"] },
  container_recreate: { titleKey: "toolTitle_container_recreate", icon: <IconRefreshOutline16 size={14} />, summaryKeys: ["container", "image"] },
  container_remove: { titleKey: "toolTitle_container_remove", icon: <IconTrashOutline16 size={14} />, summaryKeys: ["container"] },
  container_mount_list: { titleKey: "toolTitle_container_mount_list", icon: <IconFolderOpenOutline16 size={14} />, summaryKeys: ["container"] },
  container_mount_add: { titleKey: "toolTitle_container_mount_add", icon: <IconFolderOpenOutline16 size={14} />, summaryKeys: ["container", "kind"] },
  container_mount_remove: { titleKey: "toolTitle_container_mount_remove", icon: <IconTrashOutline16 size={14} />, summaryKeys: ["container"] },
  container_mount_update: { titleKey: "toolTitle_container_mount_update", icon: <IconRefreshOutline16 size={14} />, summaryKeys: ["container", "mode"] },
  container_path_set: { titleKey: "toolTitle_container_path_set", icon: <IconEditOutline16 size={14} />, summaryKeys: ["container"] },
  container_path_add: { titleKey: "toolTitle_container_path_add", icon: <IconPlusOutline16 size={14} />, summaryKeys: ["container", "path"] },
  container_path_remove: { titleKey: "toolTitle_container_path_remove", icon: <IconTrashOutline16 size={14} />, summaryKeys: ["container", "path"] },
  container_secret_add: { titleKey: "toolTitle_container_secret_add", icon: <IconLinkOutline16 size={14} />, summaryKeys: ["container", "env"] },
  container_secret_remove: { titleKey: "toolTitle_container_secret_remove", icon: <IconLinkOutline16 size={14} />, summaryKeys: ["container", "env"] },
  image_list: { titleKey: "toolTitle_image_list", icon: <IconArchiveOutline20 size={14} />, summaryKeys: [] },
  image_get: { titleKey: "toolTitle_image_get", icon: <IconArchiveOutline20 size={14} />, summaryKeys: ["imageId"] },
  image_build: { titleKey: "toolTitle_image_build", icon: <IconPlusOutline16 size={14} />, summaryKeys: ["imageId", "parent"] },
  image_rebuild: { titleKey: "toolTitle_image_rebuild", icon: <IconRefreshOutline16 size={14} />, summaryKeys: ["imageId"] },
  image_rebuild_all: { titleKey: "toolTitle_image_rebuild_all", icon: <IconRefreshOutline16 size={14} />, summaryKeys: [] },
  image_remove: { titleKey: "toolTitle_image_remove", icon: <IconTrashOutline16 size={14} />, summaryKeys: ["imageId"] },
  volume_list: { titleKey: "toolTitle_volume_list", icon: <IconDataOutline16 size={14} />, summaryKeys: [] },
  volume_create: { titleKey: "toolTitle_volume_create", icon: <IconPlusOutline16 size={14} />, summaryKeys: ["name"] },
  volume_remove: { titleKey: "toolTitle_volume_remove", icon: <IconTrashOutline16 size={14} />, summaryKeys: ["name"] },
  secret_list: { titleKey: "toolTitle_secret_list", icon: <IconLinkOutline16 size={14} />, summaryKeys: [] },
  secret_create: { titleKey: "toolTitle_secret_create", icon: <IconPlusOutline16 size={14} />, summaryKeys: ["name"] },
  secret_remove: { titleKey: "toolTitle_secret_remove", icon: <IconTrashOutline16 size={14} />, summaryKeys: ["name"] },
  daemon_start: { titleKey: "toolTitle_daemon_start", icon: <IconPlayOutline16 size={14} />, summaryKeys: ["name"] },
  daemon_list: { titleKey: "toolTitle_daemon_list", icon: <IconPlayOutline16 size={14} />, summaryKeys: ["container"] },
  daemon_logs: { titleKey: "toolTitle_daemon_logs", icon: <IconBrowseOutline16 size={14} />, summaryKeys: ["name"] },
  daemon_restart: { titleKey: "toolTitle_daemon_restart", icon: <IconRefreshOutline16 size={14} />, summaryKeys: ["name"] },
  daemon_stop: { titleKey: "toolTitle_daemon_stop", icon: <IconStopFill16 size={14} />, summaryKeys: ["name"] },
};

/** The wire tool names this package owns a row for. */
export const TOOL_VIEW_KEYS: readonly string[] = Object.keys(TOOL_PRESENTATION);

const sepStyle: CSSProperties = {
  flex: "none",
  width: "2px",
  height: "2px",
  borderRadius: "1px",
  margin: "0 8px",
  background: "var(--dsw-alias-label-caption)",
};

const summaryStyle: CSSProperties = {
  flex: "1 1 auto",
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontSize: "14px",
  lineHeight: "24px",
  color: "var(--dsw-alias-label-tertiary)",
};

const errorSummaryStyle: CSSProperties = {
  ...summaryStyle,
  color: "var(--dsw-alias-state-error-primary)",
};

const bodyStyle: CSSProperties = {
  margin: 0,
  padding: "8px 10px",
  maxHeight: "320px",
  overflow: "auto",
  fontFamily: "var(--dsw-font-mono, monospace)",
  fontSize: "12px",
  lineHeight: 1.5,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  background: "var(--dsw-alias-bg-layer-3)",
  border: "1px solid var(--dsw-alias-border-l2)",
  borderRadius: "8px",
};

const errorBodyStyle: CSSProperties = {
  ...bodyStyle,
  color: "var(--dsw-alias-state-error-primary)",
};

function firstLine(text: string): string {
  const newline = text.indexOf("\n");
  return newline === -1 ? text : text.slice(0, newline);
}

// A hard bound on the output lines a result may render, so a multi-megabyte
// result cannot create an unbounded number of DOM nodes. Small outputs pass
// through untouched.
const MAX_RENDERED_LINES = 2000;

function capLines(text: string, max: number): string {
  const lines = text.split("\n");
  return lines.length <= max ? text : lines.slice(0, max).join("\n");
}

function parseArgs(argsRaw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(argsRaw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function argSummary(
  args: Record<string, unknown>,
  keys: readonly string[],
  fallback: string,
): string {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string" && value !== "") return firstLine(value);
    if (Array.isArray(value) && value.length > 0) {
      return firstLine(value.map((item) => String(item)).join(" "));
    }
  }
  return fallback;
}

function resultText(block: ToolCallViewProps["block"]): string | null {
  if (!("kind" in block)) return null;
  const parts: string[] = [];
  for (const item of block.content) {
    parts.push(item.type === "text" ? item.text : JSON.stringify(item, null, 2));
  }
  if (parts.length === 0 && block.error !== undefined) {
    parts.push(`${block.error.name}: ${block.error.code}`);
  }
  return parts.join("\n") || null;
}

// Command results are JSON `{exitCode, signal, stdout, stderr}`; show the
// streams rather than the raw envelope when that shape is recognised.
function prettyOutput(text: string | null): string | null {
  if (text === null) return null;
  try {
    const data: unknown = JSON.parse(text);
    if (typeof data === "object" && data !== null) {
      const record = data as Record<string, unknown>;
      if ("stdout" in record || "stderr" in record) {
        return [record.stdout, record.stderr]
          .filter((value): value is string => typeof value === "string" && value !== "")
          .join("");
      }
    }
  } catch {
    // Not JSON: fall through to the raw text.
  }
  return text;
}

export type PodmanToolRowProps = ToolCallViewProps & PropsLocale<typeof NS>;

// The terminal card the shipped client no longer derives for our command tools
// (0.1.5-rc.2 dropped the host `callView`/`resultView` from the block and only
// recognises the built-in shell tools). Our command results are JSON
// `{exitCode, signal, stdout, stderr}`, so the card is rebuilt from the raw
// arguments and result here.
interface TerminalCard {
  command: string;
  cwd?: string;
  output?: string;
  exitCode?: number;
  signal?: string;
  running: boolean;
}

function terminalCard(
  toolName: string,
  args: Record<string, unknown>,
  block: ToolCallViewProps["block"],
  cwd: string | undefined,
): TerminalCard | null {
  if (toolName !== "container_bash" && toolName !== "container_exec") return null;
  const command =
    toolName === "container_bash"
      ? typeof args.command === "string"
        ? args.command
        : ""
      : Array.isArray(args.argv)
        ? args.argv.map((word) => String(word)).join(" ")
        : "";
  const workdir =
    typeof args.workdir === "string" && args.workdir !== ""
      ? args.workdir
      : undefined;
  const base: TerminalCard = {
    command,
    cwd: workdir ?? cwd,
    running: !("kind" in block),
  };
  if (!("kind" in block)) return base;
  // A failed call keeps the generic error path (red summary + red body).
  if (block.isError) return null;
  const text = resultText(block);
  if (text === null) return null;
  try {
    const data: unknown = JSON.parse(text);
    if (typeof data !== "object" || data === null) return null;
    const record = data as Record<string, unknown>;
    const output = [record.stdout, record.stderr]
      .filter((value): value is string => typeof value === "string" && value !== "")
      .join("");
    const signal =
      typeof record.signal === "string" && record.signal !== ""
        ? record.signal
        : undefined;
    return {
      ...base,
      output,
      ...(signal !== undefined
        ? { signal }
        : { exitCode: typeof record.exitCode === "number" ? record.exitCode : 0 }),
    };
  } catch {
    return null;
  }
}

// Terminal card copy, mirroring ui-tool's terminalBlockLabels; `copy`, `copied`
// and `collapse` resolve from the shared common vocabulary.
function terminalLabels(t: TranslateNS<typeof NS>): TerminalBlockLabels {
  return {
    signal: (signal) => t("terminalSignal", { signal }),
    exitCode: (code) => t("terminalExitCode", { code }),
    running: t("terminalRunning"),
    failed: t("terminalFailed"),
    done: t("terminalDone"),
    copy: t("copy"),
    copied: t("copied"),
    noOutput: t("terminalNoOutput"),
    collapseAria: t("terminalCollapseAria"),
    collapse: t("collapse"),
    expandAria: (hidden) => t("terminalExpandAria", { n: hidden }),
    expand: (hidden) => t("terminalExpandRest", { n: hidden }),
  };
}

/** Render one podman tool call as an icon-titled, expandable row. */
export function PodmanToolRow({
  toolName,
  block,
  cwd,
  home,
  inspect,
  t,
}: PodmanToolRowProps) {
  const presentation = TOOL_PRESENTATION[toolName];
  const title = presentation === undefined ? toolName : t(presentation.titleKey);
  const settled = "kind" in block;
  const argsRaw =
    ((settled ? block.call?.argsRaw : block.argsRaw) ?? "");
  const args = parseArgs(argsRaw);
  const terminal = terminalCard(toolName, args, block, cwd);
  const state = !settled
    ? "running"
    : block.error?.code === "interrupted"
      ? "stopped"
      : block.isError
        ? "error"
        : "done";
  const output = prettyOutput(resultText(block));
  const failureLine =
    state === "error" && output !== null && output !== ""
      ? firstLine(output)
      : null;
  const summary =
    failureLine ??
    argSummary(args, presentation?.summaryKeys ?? [], firstLine(argsRaw) || block.callId);
  const [expanded, setExpanded] = useState(false);
  const expandable = terminal !== null || (output !== null && output !== "");
  const leading =
    state === "error" ? (
      <StateDot state="error" />
    ) : state === "stopped" ? (
      <StateDot state="warning" />
    ) : (
      presentation?.icon ?? <IconSparkle16 size={14} />
    );
  void inspect;
  return (
    <DisclosureRow
      icon={leading}
      title={title}
      open={expanded && expandable}
      expandable={expandable}
      onToggle={() => setExpanded((value) => !value)}
      expandOnRowClick
      keepContentWhenOpen
      collapsedContent={
        <>
          <span style={sepStyle} aria-hidden />
          <span style={failureLine !== null ? errorSummaryStyle : summaryStyle}>
            {summary}
          </span>
        </>
      }
    >
      {terminal !== null ? (
        <TerminalBlock
          command={terminal.command}
          cwd={terminal.cwd}
          home={home}
          output={terminal.output}
          exitCode={terminal.exitCode}
          signal={terminal.signal}
          running={terminal.running}
          maxLines={MAX_RENDERED_LINES}
          className={TERMINAL_CLASS}
          labels={terminalLabels(t)}
        />
      ) : expandable ? (
        <pre style={state === "error" ? errorBodyStyle : bodyStyle}>
          {capLines(output ?? "", MAX_RENDERED_LINES)}
        </pre>
      ) : null}
    </DisclosureRow>
  );
}
