// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

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
