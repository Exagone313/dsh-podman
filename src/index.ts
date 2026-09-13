// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { preExecutePolicy } from "./approval.js";
import { createFilesystemProvider } from "./fs-provider.js";
import {
  ensurePodmanOpsPreset,
  podmanRuntimeSection,
  withoutHarnessSourceSection,
} from "./prompts.js";
import { createSubprocessProvider } from "./subprocess.js";
import { toolHandlers } from "./tool-handlers.js";
import { TOOLS, TOOL_DESCRIPTIONS, defineTool, toolOutput } from "./tool-schemas.js";
import { toolCallView, toolResultView } from "./tool-views.js";
import { installContainerSettings } from "./settings-bridge.js";
import { WorkspaceResolver, normalizeToolError } from "./workspace-binding.js";

function withTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

export const name = "podman";

export const inject = ["tools", "workspaceRegistry"];

export interface PluginConfig {
  socketsRoot?: string;
  defaultImage?: string;
  projectsRoot?: string;
  controlToken?: string;
  imagePrefix?: string;
}

export function apply(ctx: any, config: PluginConfig = {}): void {
  ctx.on(
    "tools/pre-execute",
    (exec: any, next: any) =>
      preExecutePolicy(exec, next, () => resolver.getConfig().projectsRoot),
  );
  ensurePodmanOpsPreset(ctx);
  const imagePrefix = withTrailingSlash(
    config.imagePrefix ?? process.env.DSH_PODMAN_IMAGE_PREFIX ?? "localhost/dsh-podman/",
  );
  const resolver = new WorkspaceResolver(
    {
      socketsRoot:
        config.socketsRoot ??
        process.env.DSH_PODMAN_SOCKETS_ROOT ??
        "/run/dsh-podman",
      defaultImage: config.defaultImage ?? "archlinux",
      projectsRoot:
        config.projectsRoot ??
        process.env.DSH_PODMAN_PROJECTS_ROOT ??
        "/projects",
      controlToken:
        config.controlToken ?? process.env.DSH_PODMAN_ORCHESTRATOR_TOKEN ?? "",
    },
    ctx.workspaceRegistry,
  );
  ctx.provide("workspaceResolver", resolver);
  const subprocess = createSubprocessProvider(resolver);
  ctx.provide("subprocess", subprocess);
  ctx.effect(() => () => subprocess.dispose(), "podman: subprocess cleanup");
  ctx.provide("fs", createFilesystemProvider(resolver));
  ctx.inject(["systemPrompt"], (promptCtx: any) => {
    promptCtx.systemPrompt.section(podmanRuntimeSection());
    promptCtx.on(
      "system-prompt/assemble",
      async (_assembly: any, _context: any, next: any) =>
        withoutHarnessSourceSection(await next()),
      { global: true, prepend: true },
    );
  });
  registerTools(ctx, resolver);
  installContainerSettings(ctx, resolver, ctx.workspaceRegistry);
}

function registerTools(ctx: any, resolver: WorkspaceResolver): void {
  for (const tool of TOOLS) {
    const handler = toolHandlers[tool.name];
    ctx.tools.register(
      defineTool({
        name: tool.name,
        description: TOOL_DESCRIPTIONS[tool.name],
        parameters: tool.parameters,
        ...(tool.approval ? { approval: true } : {}),
        presentCall: (args: any) => toolCallView(tool.name, args),
        presentResult: (args: any, result: any) =>
          toolResultView(tool.name, args, result),
        output: toolOutput,
        execute: async (input: any, exec: any) => {
          try {
            return JSON.stringify(await handler(resolver, input, exec));
          } catch (error) {
            throw normalizeToolError(error);
          }
        },
      }),
    );
  }
}

export {
  PODMAN_OPS_APPROVAL_TOOLS,
  PODMAN_OPS_PRESET,
  READ_ONLY_TOOLS,
  approvalDecision,
  foldApprovalPolicy,
  foldSandboxMode,
  mountDestinationsReason,
  preExecutePolicy,
  summarizeArgs,
} from "./approval.js";
export { FilesystemProvider, createFilesystemProvider } from "./fs-provider.js";
export { resolveGuestCwd, resolveGuestPath, remoteArgv } from "./guest-rpc.js";
export {
  inferMountKind,
  projectMountDestinationReason,
  projectMountMirror,
} from "./mount-input.js";
export {
  HARNESS_SOURCE_SECTION,
  PODMAN_OPS_AGENT_CORDIS_YML,
  PODMAN_OPS_PRESET_YML,
  ensurePodmanOpsPreset,
  homePresetsRoot,
  podmanRuntimeSection,
  withoutHarnessSourceSection,
} from "./prompts.js";
export { publicContainer, publicDaemon, publicImage, publicMount } from "./public.js";
export {
  OutputReader,
  SubprocessProvider,
  createSubprocessProvider,
  outputReader,
} from "./subprocess.js";
export { toolHandlers } from "./tool-handlers.js";
export {
  TOOLS,
  ToolDefinition,
  containerBashParameters,
  containerEditParameters,
  containerExecParameters,
  containerGlobParameters,
  containerGrepParameters,
  containerListParameters,
  containerMountAddParameters,
  containerMountListParameters,
  containerMountRemoveParameters,
  containerReadParameters,
  containerRecreateParameters,
  containerRemoveParameters,
  containerSecretAddParameters,
  containerSecretRemoveParameters,
  containerStartParameters,
  containerWriteParameters,
  daemonListParameters,
  daemonLogsParameters,
  daemonRestartParameters,
  daemonStartParameters,
  daemonStopParameters,
  defineTool,
  envParam,
  imageBuildParameters,
  imageGetParameters,
  imageListParameters,
  imageRebuildAllParameters,
  imageRebuildParameters,
  imageRemoveParameters,
  secretCreateParameters,
  secretListParameters,
  secretRemoveParameters,
  toolOutput,
  volumeCreateParameters,
  volumeListParameters,
  volumeRemoveParameters,
} from "./tool-schemas.js";
export { toolCallView, toolResultView } from "./tool-views.js";
