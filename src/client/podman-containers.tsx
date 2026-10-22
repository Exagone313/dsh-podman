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
  // browser neither chooses nor guesses one. `failed` means it cannot place this
  // session in a workspace, so the panel says so instead of listing every row.
  const [target, setTarget] = useState<TargetState>({ phase: "loading" });
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
    void fetchTerminalTarget(sessionId, controller.signal).then(
      (resolved) => {
        if (!controller.signal.aborted) {
          setTarget({ phase: "ready", target: resolved });
        }
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setTarget({
          phase: "failed",
          message: error instanceof Error ? error.message : String(error),
        });
      },
    );
    return () => {
      controller.abort();
    };
  }, [sessionId]);

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
            onCreateSecret={props.createSecret}
            onStartContainer={props.startContainer}
            onApplyContainerConfig={props.applyContainerConfig}
            gatewayUnavailable={state.gatewayState === "absent" ||
              state.gatewayState === "incompatible"}
            extraAction={settingsAction}
          />
        )}
    </section>
  );
}

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
