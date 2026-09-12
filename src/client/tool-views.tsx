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
import { NS } from "./locales.js";
import { TERMINAL_CLASS } from "./terminal-styles.js";

// A domain-owned row for every podman tool, registered over the keyed
// `tool.call.toolview` slot. Without it the shipped client renders each call as
// "Tool call · <tool name>"; this row owns the icon, title, summary and body.

interface ToolPresentation {
  readonly title: string;
  readonly icon: ReactNode;
  readonly summaryKeys: readonly string[];
}

const TOOL_PRESENTATION: Record<string, ToolPresentation> = {
  container_bash: { title: "Container bash", icon: <IconApiOutline14 size={14} />, summaryKeys: ["description", "command"] },
  container_exec: { title: "Container exec", icon: <IconApiOutline14 size={14} />, summaryKeys: ["description", "argv"] },
  container_read: { title: "Read", icon: <IconBrowseOutline16 size={14} />, summaryKeys: ["file_path"] },
  container_write: { title: "Write", icon: <IconEditOutline16 size={14} />, summaryKeys: ["file_path"] },
  container_edit: { title: "Edit", icon: <IconEditOutline16 size={14} />, summaryKeys: ["file_path"] },
  container_glob: { title: "Glob", icon: <IconSearchOutline16 size={14} />, summaryKeys: ["pattern"] },
  container_grep: { title: "Grep", icon: <IconSearchOutline16 size={14} />, summaryKeys: ["pattern"] },
  container_list: { title: "List containers", icon: <IconDataOutline16 size={14} />, summaryKeys: [] },
  container_start: { title: "Start container", icon: <IconPlayOutline16 size={14} />, summaryKeys: ["container", "image"] },
  container_recreate: { title: "Recreate container", icon: <IconRefreshOutline16 size={14} />, summaryKeys: ["container", "image"] },
  container_remove: { title: "Remove container", icon: <IconTrashOutline16 size={14} />, summaryKeys: ["container"] },
  container_mount_list: { title: "List mounts", icon: <IconFolderOpenOutline16 size={14} />, summaryKeys: ["container"] },
  container_mount_add: { title: "Add mount", icon: <IconFolderOpenOutline16 size={14} />, summaryKeys: ["container", "kind"] },
  container_mount_remove: { title: "Remove mount", icon: <IconTrashOutline16 size={14} />, summaryKeys: ["container"] },
  container_secret_add: { title: "Attach secret", icon: <IconLinkOutline16 size={14} />, summaryKeys: ["container", "env"] },
  container_secret_remove: { title: "Detach secret", icon: <IconLinkOutline16 size={14} />, summaryKeys: ["container", "env"] },
  image_list: { title: "List images", icon: <IconArchiveOutline20 size={14} />, summaryKeys: [] },
  image_get: { title: "Inspect image", icon: <IconArchiveOutline20 size={14} />, summaryKeys: ["imageId"] },
  image_build: { title: "Build image", icon: <IconPlusOutline16 size={14} />, summaryKeys: ["imageId", "parent"] },
  image_rebuild: { title: "Rebuild image", icon: <IconRefreshOutline16 size={14} />, summaryKeys: ["imageId"] },
  image_rebuild_all: { title: "Rebuild all images", icon: <IconRefreshOutline16 size={14} />, summaryKeys: [] },
  image_remove: { title: "Remove image", icon: <IconTrashOutline16 size={14} />, summaryKeys: ["imageId"] },
  volume_list: { title: "List volumes", icon: <IconDataOutline16 size={14} />, summaryKeys: [] },
  volume_create: { title: "Create volume", icon: <IconPlusOutline16 size={14} />, summaryKeys: ["name"] },
  volume_remove: { title: "Remove volume", icon: <IconTrashOutline16 size={14} />, summaryKeys: ["name"] },
  secret_list: { title: "List secrets", icon: <IconLinkOutline16 size={14} />, summaryKeys: [] },
  secret_create: { title: "Create secret", icon: <IconPlusOutline16 size={14} />, summaryKeys: ["name"] },
  secret_remove: { title: "Remove secret", icon: <IconTrashOutline16 size={14} />, summaryKeys: ["name"] },
  daemon_start: { title: "Start daemon", icon: <IconPlayOutline16 size={14} />, summaryKeys: ["name"] },
  daemon_list: { title: "List daemons", icon: <IconPlayOutline16 size={14} />, summaryKeys: ["container"] },
  daemon_logs: { title: "Daemon logs", icon: <IconBrowseOutline16 size={14} />, summaryKeys: ["name"] },
  daemon_restart: { title: "Restart daemon", icon: <IconRefreshOutline16 size={14} />, summaryKeys: ["name"] },
  daemon_stop: { title: "Stop daemon", icon: <IconStopFill16 size={14} />, summaryKeys: ["name"] },
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

function firstLine(text: string): string {
  const newline = text.indexOf("\n");
  return newline === -1 ? text : text.slice(0, newline);
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

// Terminal card copy, mirroring ui-tool's terminalBlockLabels; `copy`, `copied`
// and `collapse` resolve from the shared common vocabulary.
function terminalLabels(
  t: TranslateNS<typeof NS>,
): Partial<TerminalBlockLabels> {
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
  const presentation = TOOL_PRESENTATION[toolName] ?? {
    title: toolName,
    icon: <IconSparkle16 size={14} />,
    summaryKeys: [] as readonly string[],
  };
  const settled = "kind" in block;
  const terminalCall = block.callView?.card === "terminal" ? block.callView : null;
  const terminalResult =
    settled && block.resultView?.card === "terminal" ? block.resultView : null;
  const terminal = settled ? terminalResult !== null : terminalCall !== null;
  const argsRaw =
    ((settled ? block.call?.argsRaw : block.argsRaw) ?? "");
  const args = parseArgs(argsRaw);
  const state = !settled
    ? "running"
    : block.error?.code === "interrupted"
      ? "stopped"
      : block.isError
        ? "error"
        : "done";
  const output = prettyOutput(resultText(block));
  const summary = argSummary(
    args,
    presentation.summaryKeys,
    firstLine(argsRaw) || block.callId,
  );
  const [expanded, setExpanded] = useState(false);
  const expandable = terminal || (output !== null && output !== "");
  const leading =
    state === "error" ? (
      <StateDot state="error" />
    ) : state === "stopped" ? (
      <StateDot state="warning" />
    ) : (
      presentation.icon
    );
  void inspect;
  return (
    <DisclosureRow
      icon={leading}
      title={presentation.title}
      open={expanded && expandable}
      expandable={expandable}
      onToggle={() => setExpanded((value) => !value)}
      expandOnRowClick
      keepContentWhenOpen
      collapsedContent={
        <>
          <span style={sepStyle} aria-hidden />
          <span style={summaryStyle}>{summary}</span>
        </>
      }
    >
      {terminal ? (
        <TerminalBlock
          command={terminalResult?.title ?? terminalCall?.title ?? ""}
          cwd={terminalCall?.cwd ?? cwd}
          home={home}
          output={terminalResult?.output}
          exitCode={terminalResult?.exitCode}
          signal={terminalResult?.signal}
          running={!settled}
          maxLines={Infinity}
          className={TERMINAL_CLASS}
          labels={terminalLabels(t)}
        />
      ) : expandable ? (
        <pre style={bodyStyle}>{output}</pre>
      ) : null}
    </DisclosureRow>
  );
}
