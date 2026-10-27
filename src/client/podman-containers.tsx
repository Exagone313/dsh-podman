// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// The Containers right-Sidebar tab's body: the Session workspace's containers
// only, rendered as the same workspace block the settings card shows — the
// workspace's name, its copyable ID, its running-container count and its Add
// container / Remove containers actions, followed by the full container rows
// with their labelled fields. The workspace is the Session's own — never
// chosen, never shown as another workspace's rows — and it is resolved once
// through the host route the terminal uses.
//
// The slot body is unpadded, so this pane brings its own insets and scroll
// container. The settings action opens the harness's Plugins panel and is
// hidden while no plugin-navigation face is mounted, rather than doing nothing
// silently.
import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import type {
  InjectFace,
  PropsLocale,
  PropsRuntime,
} from "@deepseek-ai/dsh-client-ui-slots";
import {
  type ReactNode,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar-right/client";
import { hint } from "./container-card-styles.js";
import type {
  ContainerCardFace,
  WorkspaceView,
} from "./container-card-controller.js";
import { WorkspaceSection } from "./container-card-workspace.js";
import { containersInWorkspace } from "./container-panel-scope.js";
import { NS } from "./locales.js";
import {
  openPluginSettings,
  pluginSettingsAvailable,
  subscribePluginSettings,
} from "./plugin-navigation.js";
import { CONTAINERS_PANEL_CLASS } from "./podman-containers-styles.js";
import type { TerminalTargetView } from "./terminal-protocol.js";
import { fetchTerminalTarget } from "./terminal-transport.js";
import {
  waitForWorkspaceTarget,
  WORKSPACE_TARGET_WAIT_MS,
} from "./workspace-target.js";

/** Everything the tab body is given: framework shares plus the injected card face. */
export interface PodmanContainersInjected extends ContainerCardFace {
  /** Owning session, resolved by the host to its own workspace. */
  readonly sessionId: string;
}

export type PodmanContainersProps =
  & PropsRuntime<"sidebar.right.pane.tab">
  & PropsLocale<typeof NS>
  & InjectFace<PodmanContainersInjected>;

type TargetState =
  | { readonly phase: "loading" }
  | { readonly phase: "ready"; readonly target: TerminalTargetView }
  | { readonly phase: "pending" }
  | { readonly phase: "failed"; readonly message: string };

export function PodmanContainers(
  props: PodmanContainersProps,
): ReactNode {
  const { t, sessionId } = props;
  const state = props.useContainerCard((snapshot) => snapshot);
  // The settings action opens the harness's Plugins panel, whose navigation
  // face the plugin-manager client UI provides lazily. The pane follows that
  // availability through this module's store rather than reading a service, so
  // a shell without the UI hides the action instead of offering a failed click.
  const settingsAvailable = useSyncExternalStore(
    subscribePluginSettings,
    pluginSettingsAvailable,
  );
  // The host resolves the Session's workspace from the Session itself; the
  // browser neither chooses nor guesses one. While the session or its workspace
  // is still registering, the route answers `workspace-pending`, which this pane
  // retries with backoff; `failed` means a real refusal, so the panel says so
  // instead of listing every row.
  const [target, setTarget] = useState<TargetState>({ phase: "loading" });
  // Bumped by the Retry action to start one fresh wait after the budget ran out.
  const [attempt, setAttempt] = useState(0);
  const scope = target.phase === "ready" ? target.target : undefined;
  const listedWorkspace = scope === undefined
    ? undefined
    : state.workspaces.find((entry) =>
      entry.workspaceSlug === scope.workspaceSlug
    );
  // The settings snapshot may not have listed the workspace yet; the host's
  // target already names it, so the header can still render its identity while
  // the full row follows.
  const workspace: WorkspaceView | undefined =
    scope === undefined || scope.workspaceSlug === ""
      ? undefined
      : listedWorkspace ?? {
        workspaceSlug: scope.workspaceSlug,
        projectName: scope.workspace,
        containerName: "",
        imageId: "",
        status: "",
        createdAt: "",
        mounts: [],
      };

  // The card snapshot is the only source of containers, and the settings scope
  // may not have loaded when this tab opens.
  useEffect(() => {
    props.reload();
  }, [props.reload]);

  useEffect(() => {
    const controller = new AbortController();
    setTarget({ phase: "loading" });
    void waitForWorkspaceTarget({
      signal: controller.signal,
      fetchTarget: (signal) =>
        fetchTerminalTarget(sessionId, signal, {
          waitMs: WORKSPACE_TARGET_WAIT_MS,
        }),
    }).then((result) => {
      // Unmount or a tab switch aborts the loop and must leave the pane alone.
      if (controller.signal.aborted || result.status === "aborted") return;
      switch (result.status) {
        case "ready":
          setTarget({ phase: "ready", target: result.target });
          return;
        case "pending":
          setTarget({ phase: "pending" });
          return;
        default:
          setTarget({
            phase: "failed",
            message: result.error instanceof Error
              ? result.error.message
              : String(result.error),
          });
      }
    });
    return () => {
      controller.abort();
    };
  }, [sessionId, attempt]);

  const containers = containersInWorkspace(state.containers, scope);
  // The workspace header is the settings card's own block header, with this
  // pane's settings action appended to its action group. Both places render the
  // same identity, copy button, count and Add/Remove controls.
  const settingsAction = settingsAvailable
    ? (
      <Button
        variant="outline"
        size="sm"
        onClick={openPluginSettings}
      >
        {t("moreSettings")}
      </Button>
    )
    : undefined;
  return (
    <section
      className={CONTAINERS_PANEL_CLASS}
      style={PANE_STYLE}
      data-dsh-podman-containers
    >
      {state.loadState === "loading"
        ? <p style={hint} role="status">{t("loading")}</p>
        : !state.available
        ? <p style={hint} role="alert">{t("unavailable")}</p>
        : target.phase === "loading"
        ? <p style={hint} role="status">{t("loading")}</p>
        : target.phase === "failed"
        ? <p style={hint} role="alert">{target.message}</p>
        : target.phase === "pending"
        ? (
          <div style={hint} role="status">
            <p style={PENDING_MESSAGE_STYLE}>
              {t("containersWorkspaceStarting")}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAttempt((count) => count + 1)}
            >
              {t("retry")}
            </Button>
          </div>
        )
        : workspace === undefined
        ? <p style={hint} role="status">{t("containersPanelNoWorkspace")}</p>
        : (
          <WorkspaceSection
            t={t}
            workspace={workspace}
            containers={containers}
            images={state.images}
            volumes={state.volumes}
            secrets={state.secrets}
            busy={state.busy}
            writable={state.writable}
            locale={state.locale}
            pendingActions={state.pendingActions}
            defaultImage={state.defaultImage}
            defaultEnv={state.containerEnv}
            projectsRoot={state.projectsRoot}
            directoryPicker={state.directoryPicker}
            onRemove={props.remove}
            onRecreate={props.recreate}
            onRemoveWorkspace={props.removeWorkspace}
            onCreate={props.createContainer}
            onCreateVolume={props.createVolume}
            onCreateSecret={props.createSecret}
            onStartContainer={props.startContainer}
            onApplyContainerConfig={props.applyContainerConfig}
            gatewayUnavailable={state.gatewayState === "absent" ||
              state.gatewayState === "incompatible"}
            templateActions={{
              listTemplates: props.listTemplates,
              inspectTemplate: props.inspectTemplate,
              buildTemplate: props.buildTemplate,
              applyTemplate: props.applyTemplate,
              publishTemplate: props.publishTemplate,
            }}
            onBuildImage={props.buildImage}
            onRebuildImage={props.rebuildImage}
            onRebuildBaseImage={props.rebuildBaseImage}
            onPullBaseImage={props.pullBaseImage}
            onReload={props.reload}
            extraAction={settingsAction}
          />
        )}
    </section>
  );
}

// The pending notice keeps the pane's hint typography but drops the paragraph's
// own margins, so the Retry action sits right below it.
const PENDING_MESSAGE_STYLE: React.CSSProperties = { margin: 0 };

// The slot body has no padding of its own, so the pane supplies its insets and
// scrolls the workspace block as one unit. The pane is the panel's one surface:
// the card it holds draws no outline here (see podman-containers-styles.ts),
// while its fill, padding and inner rules stay exactly as the settings page
// renders them.
const PANE_STYLE: React.CSSProperties = {
  boxSizing: "border-box",
  height: "100%",
  minHeight: 0,
  overflowY: "auto",
  padding: "10px",
  color: "var(--dsw-alias-label-primary)",
  background: "var(--dsw-alias-bg-layer-2)",
  fontSize: "13px",
};
