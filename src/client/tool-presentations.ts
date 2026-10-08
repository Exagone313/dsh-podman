// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import type { ContainerPluginKey } from "./locales.js";

// The data half of the rows this package owns for its own tools: the localized
// title a call shows and the arguments that summarize it. It is deliberately
// React-free, because the coverage test imports it while the browser bundle
// cannot be loaded in Node (its UI primitives are browser-only). The icons live
// in tool-views.tsx, typed against these keys.

export interface ToolPresentation {
  readonly titleKey: ContainerPluginKey;
  readonly summaryKeys: readonly string[];
}

export const TOOL_PRESENTATION = {
  container_bash: {
    titleKey: "toolTitle_container_bash",
    summaryKeys: ["description", "command"],
  },
  container_exec: {
    titleKey: "toolTitle_container_exec",
    summaryKeys: ["description", "argv"],
  },
  container_read: {
    titleKey: "toolTitle_container_read",
    summaryKeys: ["file_path"],
  },
  container_write: {
    titleKey: "toolTitle_container_write",
    summaryKeys: ["file_path"],
  },
  container_edit: {
    titleKey: "toolTitle_container_edit",
    summaryKeys: ["file_path"],
  },
  container_glob: {
    titleKey: "toolTitle_container_glob",
    summaryKeys: ["pattern"],
  },
  container_grep: {
    titleKey: "toolTitle_container_grep",
    summaryKeys: ["pattern"],
  },
  container_list: {
    titleKey: "toolTitle_container_list",
    summaryKeys: [],
  },
  container_start: {
    titleKey: "toolTitle_container_start",
    summaryKeys: ["container", "image"],
  },
  container_recreate: {
    titleKey: "toolTitle_container_recreate",
    summaryKeys: ["container", "image"],
  },
  container_remove: {
    titleKey: "toolTitle_container_remove",
    summaryKeys: ["container"],
  },
  container_mount_list: {
    titleKey: "toolTitle_container_mount_list",
    summaryKeys: ["container"],
  },
  container_mount_add: {
    titleKey: "toolTitle_container_mount_add",
    summaryKeys: ["container", "kind"],
  },
  container_mount_remove: {
    titleKey: "toolTitle_container_mount_remove",
    summaryKeys: ["container"],
  },
  container_mount_update: {
    titleKey: "toolTitle_container_mount_update",
    summaryKeys: ["container", "mode"],
  },
  container_publish_port: {
    titleKey: "toolTitle_container_publish_port",
    summaryKeys: ["port", "container"],
  },
  container_unpublish_port: {
    titleKey: "toolTitle_container_unpublish_port",
    summaryKeys: ["port", "container"],
  },
  container_path_set: {
    titleKey: "toolTitle_container_path_set",
    summaryKeys: ["container"],
  },
  container_path_add: {
    titleKey: "toolTitle_container_path_add",
    summaryKeys: ["container", "path"],
  },
  container_path_remove: {
    titleKey: "toolTitle_container_path_remove",
    summaryKeys: ["container", "path"],
  },
  container_secret_add: {
    titleKey: "toolTitle_container_secret_add",
    summaryKeys: ["container", "env"],
  },
  container_secret_remove: {
    titleKey: "toolTitle_container_secret_remove",
    summaryKeys: ["container", "env"],
  },
  image_list: {
    titleKey: "toolTitle_image_list",
    summaryKeys: [],
  },
  image_get: {
    titleKey: "toolTitle_image_get",
    summaryKeys: ["imageId"],
  },
  image_build: {
    titleKey: "toolTitle_image_build",
    summaryKeys: ["imageId", "parent"],
  },
  image_rebuild: {
    titleKey: "toolTitle_image_rebuild",
    summaryKeys: ["imageId"],
  },
  image_rebuild_all: {
    titleKey: "toolTitle_image_rebuild_all",
    summaryKeys: [],
  },
  image_remove: {
    titleKey: "toolTitle_image_remove",
    summaryKeys: ["imageId"],
  },
  volume_list: {
    titleKey: "toolTitle_volume_list",
    summaryKeys: [],
  },
  volume_create: {
    titleKey: "toolTitle_volume_create",
    summaryKeys: ["name"],
  },
  volume_remove: {
    titleKey: "toolTitle_volume_remove",
    summaryKeys: ["name"],
  },
  secret_list: {
    titleKey: "toolTitle_secret_list",
    summaryKeys: [],
  },
  secret_create: {
    titleKey: "toolTitle_secret_create",
    summaryKeys: ["name"],
  },
  secret_remove: {
    titleKey: "toolTitle_secret_remove",
    summaryKeys: ["name"],
  },
  daemon_start: {
    titleKey: "toolTitle_daemon_start",
    summaryKeys: ["name"],
  },
  daemon_list: {
    titleKey: "toolTitle_daemon_list",
    summaryKeys: ["container"],
  },
  daemon_logs: {
    titleKey: "toolTitle_daemon_logs",
    summaryKeys: ["name"],
  },
  daemon_restart: {
    titleKey: "toolTitle_daemon_restart",
    summaryKeys: ["name"],
  },
  daemon_stop: {
    titleKey: "toolTitle_daemon_stop",
    summaryKeys: ["name"],
  },
} as const satisfies Record<string, ToolPresentation>;

/** The wire tool names this package owns a row for. */
export const TOOL_VIEW_KEYS: readonly string[] = Object.keys(TOOL_PRESENTATION);

/** The presentation of one tool, or undefined when this package has no row. */
export function toolPresentation(name: string): ToolPresentation | undefined {
  return (TOOL_PRESENTATION as Record<string, ToolPresentation>)[name];
}
