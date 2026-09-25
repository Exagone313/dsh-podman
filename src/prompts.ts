// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { PODMAN_OPS_APPROVAL_TOOLS, PODMAN_OPS_PRESET } from "./approval.js";
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

// The built-in shell and filesystem tools whose presence decides which runtime
// wording applies.
const BUILTIN_TOOLS = ["bash", "read", "write", "edit", "glob", "grep"];

// Wording for an agent that has the built-in shell and filesystem tools.
const RUNTIME_WITH_BUILTINS =
  "This dsh session's `bash`, `read`, `write`, `edit`, `glob`, and `grep` " +
  "are container-backed: they run in a Podman container, the default " +
  "container of the current dsh workspace — the same one `container_bash` " +
  "and the other container-scoped tools (`container_*` and `daemon_*`) " +
  'target with `container: "default"`. Containers are scoped to a dsh ' +
  "workspace: each workspace has its own default container and any named " +
  "ones, and the container-scoped tools address them by logical name within " +
  "the current workspace. There is no host shell — never describe their " +
  "output as the host's — and host paths do not exist. Because `bash` and " +
  "`container_bash` run in that one container with the same command-visible " +
  "environment, a command sees the same environment and filesystem either " +
  "way, and matching output is never evidence of a host " +
  "shell. Containers share the host kernel, so `uname -a`, `uname -r`, and " +
  "`/proc/version` do report the host kernel; the " +
  "container's own identity shows in `hostname`, `/etc/os-release`, and " +
  "`/proc/1/cmdline`.";

// Wording for an agent that has only the container tools (the Podman operator
// preset mounts none of the built-in shell or filesystem rows), so it never
// names a tool the agent does not have.
const RUNTIME_CONTAINER_ONLY =
  "This dsh session's container tools run in a Podman container: the default " +
  "container of the current dsh workspace — the same one the container-scoped " +
  'tools (`container_*` and `daemon_*`) target with `container: "default"`. ' +
  "Containers are scoped to a dsh workspace: each workspace has its own " +
  "default container and any named ones, and the container-scoped tools " +
  "address them by logical name within the current workspace. There is no " +
  "host shell — never describe their output as the host's — and host paths do " +
  "not exist. Containers share the host kernel, so `uname -a`, `uname -r`, " +
  "and `/proc/version` do report the host kernel; the container's own identity " +
  "shows in `hostname`, `/etc/os-release`, and `/proc/1/cmdline`.";

// Storage guidance both runtime wordings carry. It names only tools that exist
// in every agent composition (`image_build`, `container_start`,
// `container_recreate`, volume mounts), so it is safe to append verbatim to the
// wording for an agent with or without the built-in tools.
const RUNTIME_STORAGE_NOTES =
  " To install software, prefer building a custom image with `image_build` (a " +
  "short name, a base or custom parent image, and the packages to add) and " +
  "then running containers from it with `container_start` or " +
  "`container_recreate` (`image`); an install into a running container does " +
  "not survive a recreate, while an image change does. For data that must " +
  "outlive a recreate, mount a named `volume` (auto-created on first use) " +
  "instead of a `tmpfs`, including the container's `/tmp` — a tool call that " +
  "recreates the container (a mount or secret change, `container_recreate`, a " +
  "read-only remount) clears tmpfs contents.";

// Correct the model's host/container mental model: the built-in shell and
// filesystem tools are container-backed too, so there is no host shell. It sits
// just before the tool sections so the correction lands next to the tool
// descriptions it explains, and it states the two facts that otherwise invite a
// "bash runs on the host" hallucination: `bash` and `container_bash` use the
// same container, and a container shares the host kernel (so `uname` matches
// the host even though the container's identity does not). It names the
// execution environment a Podman container, not a "Podman workspace", and says
// that containers are scoped to a dsh workspace, so the two vocabularies stay
// apart. An agent without the built-in tools gets the container-only wording.
export function podmanRuntimeSection(ctx: any): {
  name: string;
  order: number;
  text: (context?: { scope?: unknown }) => string;
} {
  return {
    name: "podman:runtime",
    order: 950,
    text: ({ scope }: { scope?: unknown } = {}) =>
      (BUILTIN_TOOLS.some((name) => ctx.tools.get(name, scope) !== undefined)
        ? RUNTIME_WITH_BUILTINS
        : RUNTIME_CONTAINER_ONLY) + RUNTIME_STORAGE_NOTES,
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
    suffix: Your working directory is {{cwd}}.
    prefix: >-
      You are a Podman container-operations agent powered by the {{model}} model.

      You manage container infrastructure through the dsh-podman tools: images
      (image_list, image_get, image_build, image_rebuild, image_rebuild_all,
      image_remove), containers (container_list, container_start,
      container_recreate, container_remove), mounts (container_mount_list,
      container_mount_add, container_mount_remove, container_mount_update),
      PATH additions (container_path_set, container_path_add,
      container_path_remove), volumes (volume_list,
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
