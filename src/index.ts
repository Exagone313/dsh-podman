// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { isSandboxEscalation, preExecutePolicy, type SessionFacts } from "./approval.js";
import { resolveReasonLocale, type ReasonLocale } from "./approval-reasons.js";
import { createFilesystemProvider } from "./fs-provider.js";
import {
  ensurePodmanOpsPreset,
  podmanRuntimeSection,
  withoutHarnessSourceSection,
} from "./prompts.js";
import { createSubprocessProvider } from "./subprocess.js";
import { createReadOnlyShellGate, REMOUNT_TOOL_NAME } from "./read-only-shell.js";
import { toolHandlers } from "./tool-handlers.js";
import { TOOLS, TOOL_DESCRIPTIONS, defineTool, toolOutput } from "./tool-schemas.js";
import { toolCallView, toolResultView } from "./tool-views.js";
import { installContainerPreferences } from "./preferences.js";
import { registerCardRoute } from "./card-route.js";
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
  // Approval text follows the session language: the browser client records its
  // active locale in the plugin namespace, with the durable user preference as
  // the fallback. Without a settings provider everything renders in English.
  let readLocale: () => ReasonLocale = () => "en";
  ctx.inject(["settings"], (settingsCtx: any) => {
    readLocale = () => resolveReasonLocale(settingsCtx.settings);
  });
  // The session's permission knobs live in the harness's own services: the
  // sandbox policy resolves the effective mode (approved override, last logged
  // mode, then the deployment default), the approval service reports the logged
  // policy override, and the agent-preset projection reports the preset the
  // session currently runs (its header only names the creation-time one).
  const readSession = (session: any): SessionFacts => ({
    mode: ctx.get("sandboxPolicy")?.resolve({ session })?.mode,
    // The deployment default is private, so an unset override conservatively
    // keeps asking.
    policy: ctx.get("approval")?.overrideOf(session) ?? "ask",
    preset:
      ctx.get("sessionProjections")?.stateOf(session, "agentPreset") ??
      session?.header?.agentPreset,
  });
  // The read-only shell gate needs the resolver, which is created below, so it
  // is built on first use. Under read-only permission it re-checks the target
  // container's mounts and, when a read-write mount would block the tool, asks
  // the user (through the approval service) to remount them read-only.
  let readOnlyShell: ReturnType<typeof createReadOnlyShellGate> | undefined;
  const readOnlyShellGate = (): ReturnType<typeof createReadOnlyShellGate> =>
    (readOnlyShell ??= createReadOnlyShellGate({
      resolver,
      approve: async (exec: any, reason: string): Promise<boolean> => {
        const approval = ctx.get("approval");
        if (approval === undefined || exec?.agent === undefined) return false;
        try {
          const outcome = await approval.request({
            agent: exec.agent,
            toolName: REMOUNT_TOOL_NAME,
            ...(exec.callId !== undefined ? { callId: exec.callId } : {}),
            ...(exec.signal !== undefined ? { signal: exec.signal } : {}),
            reason,
          });
          return outcome === "allowed-once";
        } catch {
          // A request that cannot be raised (no open turn, no channel) fails
          // closed, exactly like a rejection.
          return false;
        }
      },
    }));
  ctx.on(
    "tools/pre-execute",
    (exec: any, next: any) =>
      preExecutePolicy(
        exec,
        next,
        () => resolver.getConfig().projectsRoot,
        () => readLocale(),
        readSession,
        readOnlyShellGate(),
      ),
  );
  // The harness asks the user to widen the sandbox before a confined call (for
  // example `bash` with `sandbox_permissions`). This deployment bypasses the
  // sandbox inside the container, so the grant changes nothing: claim the
  // request so a stray `sandbox_permissions` argument raises no prompt. The
  // listener is prepended so it runs before the bridge that forwards approvals
  // to the browser, and it delegates everything else.
  ctx.on(
    "approval/request",
    (request: any, next: any) =>
      isSandboxEscalation(request) ? Promise.resolve("allowed-once") : next(),
    { prepend: true },
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
    promptCtx.systemPrompt.section(podmanRuntimeSection(promptCtx));
    promptCtx.on(
      "system-prompt/assemble",
      async (_assembly: any, _context: any, next: any) =>
        withoutHarnessSourceSection(await next()),
      { global: true, prepend: true },
    );
  });
  registerTools(ctx, resolver);
  installContainerPreferences(ctx, resolver);
  registerCardRoute(ctx, resolver, ctx.workspaceRegistry);
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
            return JSON.stringify(await handler(resolver, input, exec, ctx));
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
  SANDBOX_ESCALATION_REASON_PREFIX,
  approvalDecision,
  isSandboxEscalation,
  mountDestinationsReason,
  preExecutePolicy,
  summarizeArgs,
} from "./approval.js";
export type { SessionFacts } from "./approval.js";
export {
  READ_ONLY_GATED_TOOLS,
  REMOUNT_TOOL_NAME,
  createReadOnlyShellGate,
} from "./read-only-shell.js";
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
