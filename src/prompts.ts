// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { PODMAN_OPS_APPROVAL_TOOLS, PODMAN_OPS_PRESET } from "./approval.js";
import { name } from "./index.js";
import { metadata } from "./workspace-binding.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Prompt section the harness registers to name its own on-disk checkout.
// Mirrors @deepseek-ai/dsh-app-boot's HARNESS_SOURCE_SECTION.
export const HARNESS_SOURCE_SECTION = "harness:source";

// The checkout the section points at lives on the host and is never reachable
// from the workspace container, so the line is false under this plugin. Drop it
// from the assembled prompt without touching any other section.
export function withoutHarnessSourceSection(assembly: any): any {
  return {
    ...assembly,
    sections: assembly.sections.filter(
      (section: any) => section.name !== HARNESS_SOURCE_SECTION,
    ),
  };
}

// Correct the model's host/container mental model: the built-in shell and
// filesystem tools are container-backed too, so there is no host shell.
export function podmanRuntimeSection(): {
  name: string;
  order: number;
  text: string;
} {
  return {
    name: "podman:runtime",
    order: 90,
    text:
      "This session runs inside a Podman workspace. The shell and filesystem " +
      "tools execute in the workspace's default container, not on the host: " +
      "`bash`, `read`, `write`, `edit`, `glob`, and `grep` are all " +
      "container-backed and only see the mounted project and that container's " +
      "filesystem. There is no host shell, and host paths are unavailable. The " +
      "`container_*` tools are the same operations against a named container " +
      '(pass `container`; "default" selects the same default container as ' +
      "`bash`) plus container, image, mount, volume, secret, and daemon management.",
  };
}

// The "Podman operator mode" preset metadata, shipped verbatim into the
// harness's user-presets root.
export const PODMAN_OPS_PRESET_YML = `name: Podman operator mode
description: Podman-focused container operations — manage images, containers, volumes, mounts, secrets, and daemons. Inspections and lifecycle run directly; commands, container file edits, daemon starts, and secret changes ask for approval; supports web research.
order: 2
`;

// The "Podman operator mode" agent composition: a Podman-focused persona plus
// the built-in task and web tools. The plugin's own container tools are global
// and need no rows; the command/file/daemon/secret tools stay available but
// gated by the pre-execute policy (PODMAN_OPS_APPROVAL_TOOLS + global flags).
export const PODMAN_OPS_AGENT_CORDIS_YML = `- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: >-
      You are a Podman container-operations agent powered by the {{model}} model.
      Your working directory is {{cwd}}.

      You manage container infrastructure through the dsh-podman tools: images
      (image_list, image_get, image_build, image_rebuild, image_rebuild_all,
      image_remove), containers (container_list, container_start,
      container_recreate, container_remove), mounts (container_mount_list,
      container_mount_add, container_mount_remove), volumes (volume_list,
      volume_create, volume_remove), secrets (secret_list, secret_create,
      secret_remove, container_secret_add, container_secret_remove), daemons
      (daemon_list, daemon_start, daemon_stop, daemon_restart, daemon_logs),
      and container inspection (container_read, container_glob,
      container_grep).

      Inspection and lifecycle operations run directly. Running commands inside
      a container (container_bash, container_exec), editing container files
      (container_write, container_edit), starting daemons (daemon_start),
      exposing or removing secret environment variables (container_secret_add,
      container_secret_remove), removing secrets (secret_remove), and
      rebuilding all images (image_rebuild_all) require the user's approval.
      Use web_search to research images and documentation. Use
      ask_user_question for user decisions and todo_write to track work.
- id: tool-ask-user
  name: '@deepseek-ai/dsh-tool-ask-user'
- id: tool-todo
  name: '@deepseek-ai/dsh-tool-todo'
  config:
    allowParallelInProgress: true
- id: tool-web
  name: '@deepseek-ai/dsh-tool-web'
  config:
    fetch: false
    searchTimeoutMs: 60000
`;

// Install the "Podman operator mode" agent preset into the harness's
// user-presets root (~/.dsh/.agent-presets/<id>). The plugin owns the preset
// content and (re)writes it on every load, so a local copy is always brought
// back to the shipped composition. Best-effort — a failure only logs.
export function ensurePodmanOpsPreset(ctx: any, dir?: string): void {
  const log = (message: string, ...args: unknown[]): void => {
    try {
      ctx?.logger?.warn?.(message, ...args);
    } catch {
      // Logger failure must not abort preset installation.
    }
  };
  try {
    const target = dir ?? join(homePresetsRoot(), PODMAN_OPS_PRESET);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "preset.yml"), PODMAN_OPS_PRESET_YML);
    writeFileSync(join(target, "agent.cordis.yml"), PODMAN_OPS_AGENT_CORDIS_YML);
    log(`[dsh-podman] wrote the "${PODMAN_OPS_PRESET}" agent preset to %s`, target);
  } catch (error) {
    log(`[dsh-podman] could not install the "${PODMAN_OPS_PRESET}" agent preset: %o`, error);
  }
}

// The harness user-presets root ($DSH_HOME or ~/.dsh, plus .agent-presets).
export function homePresetsRoot(): string {
  return join(process.env.DSH_HOME ?? join(homedir(), ".dsh"), ".agent-presets");
}
