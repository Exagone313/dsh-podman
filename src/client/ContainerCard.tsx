// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { DefaultsSection } from "./container-card-defaults.js";
import { StatusSection } from "./container-card-status.js";
import { ImagesSection, StorageSection } from "./container-card-resources.js";
import { WorkspaceSection } from "./container-card-workspace.js";
import {
  countLabel,
  StatusChip,
  type StatusTone,
} from "./container-card-shared.js";
import { TABS_CLASS } from "./container-card-tabs-styles.js";
import {
  actionRow,
  banner,
  hint,
  pageColumn,
  statusStrip,
  tabPanel,
} from "./container-card-styles.js";
import {
  type CardState,
  type ContainerCardFace,
} from "./container-card-controller.js";
import { NS, type Translate } from "./locales.js";
import { Button, SegmentedTabs } from "@deepseek-ai/dsh-client-ui-primitives";
import {
  type InjectFace,
  type PropsLocale,
  type PropsRuntime,
} from "@deepseek-ai/dsh-client-ui-slots";
import { type ReactNode, useEffect, useId, useState } from "react";

// The page's tabs: the workspaces and their containers, the images they build
// from, the storage they mount, the defaults every new container starts from,
// and the version lines. Everything but the version lines is one task each, so
// a tab body only ever shows what that task needs.
type CardTab =
  | "workspaces"
  | "images"
  | "storage"
  | "defaults"
  | "status";

export type ContainerCardProps =
  & PropsRuntime<"plugins.bundle.config">
  & PropsLocale<typeof NS>
  & InjectFace<ContainerCardFace>;

// The moment a workspace's newest container was created: the workspaces are
// ordered by it, most recent first. A timestamp the browser cannot read counts
// as no moment at all, so a broken row never claims the top of the list.
function newestContainerAt(
  containers: readonly { createdAt: string }[],
): number {
  return containers.reduce((newest, container) => {
    const at = Date.parse(container.createdAt);
    return Number.isNaN(at) ? newest : Math.max(newest, at);
  }, Number.NEGATIVE_INFINITY);
}

// A chip's tone and wording for a version divergence: the status table's own
// warn/error tones, with the divergence named in the chip's words too, so a
// green "ready" is the only reading that means ready and matching.
function versionChip(
  t: Translate,
  base: { tone: StatusTone; label: string },
  state: CardState["versionState"],
): { tone: StatusTone; label: string } {
  if (state === "major-mismatch") {
    return {
      tone: "error",
      label: `${base.label} · ${t("versionIncompatible")}`,
    };
  }
  if (state === "minor-mismatch") {
    return {
      tone: "warn",
      label: `${base.label} · ${t("versionCompatibleDifferent")}`,
    };
  }
  return base;
}

export function ContainerCard(props: ContainerCardProps): ReactNode {
  const { t } = props;
  const state = props.useContainerCard((snapshot) => snapshot);
  const [tab, setTab] = useState<CardTab>("workspaces");
  const tabsId = useId();
  // The Plugins page renders a one-liner in its list and this component again
  // as the entry's page, so the orchestrator snapshot is only fetched for the
  // page. Re-reading on every page view keeps a workspace created since the
  // last visit visible without pressing Reload.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh per page view
  useEffect(() => {
    if (props.view === "page") props.reload();
  }, [props.view]);
  // The list shows only the one-liner; the page heading already carries the
  // plugin's title and description. The one-liner reports what the snapshot
  // actually holds, and whether the orchestrator answered it.
  if (props.view === "summary") {
    if (state.loadState === "loading") return t("loading");
    if (!state.available) return t("unavailable");
    return [
      countLabel(
        t,
        state.workspaces.length,
        "countWorkspaceOne",
        "countWorkspaceMany",
      ),
      countLabel(
        t,
        state.containers.length,
        "countContainerOne",
        "countContainerMany",
      ),
      t(
        state.orchestratorReady
          ? "orchestratorReady"
          : "orchestratorUnavailable",
      ),
    ].join(" · ");
  }
  if (state.loadState === "loading") {
    return (
      <div
        style={{ padding: "8px 0", fontSize: "13px", opacity: 0.8 }}
        role="status"
      >
        <p style={{ margin: 0 }}>{t("loading")}</p>
      </div>
    );
  }
  if (!state.available) {
    return (
      <div style={{ padding: "8px 0", fontSize: "13px", opacity: 0.8 }}>
        <p style={{ margin: 0 }} role="alert">{t("unavailable")}</p>
        {state.notice === "" ? null : (
          <p
            style={{ margin: "4px 0 0" }}
            role={state.noticeIsError ? "alert" : "status"}
          >
            {t("notice")}: {state.notice}
          </p>
        )}
        <div style={{ marginTop: "8px" }}>
          <Button
            variant="outline"
            size="sm"
            disabled={state.busy}
            onClick={props.reload}
          >
            {state.busy ? t("busy") : t("reload")}
          </Button>
        </div>
      </div>
    );
  }
  const tabId = (value: CardTab): string => `${tabsId}-tab-${value}`;
  const panelId = (value: CardTab): string => `${tabsId}-panel-${value}`;
  // Both daemons read as ready or not ready. The orchestrator stays unknown
  // only until its first snapshot settles; the gateway keeps the snapshot's own
  // unknown when the orchestrator cannot report it at all, because "unknown" is
  // then the fact rather than a state this card can resolve. A daemon that runs
  // with a diverging version carries that divergence in the chip's own tone and
  // words, so its version is never colour alone.
  const orchestratorChip = state.orchestratorKnown
    ? state.orchestratorReady
      ? versionChip(
        t,
        { tone: "ok", label: t("orchestratorReady") },
        state.versionState,
      )
      : { tone: "error" as const, label: t("orchestratorNotReady") }
    : { tone: "muted" as const, label: t("orchestratorUnknown") };
  const gatewayChip = state.gatewayState === "running"
    ? versionChip(
      t,
      { tone: "ok", label: t("gatewayReady") },
      state.gatewayVersionState,
    )
    : state.gatewayState === "absent"
    ? { tone: "warn" as const, label: t("gatewayNotReady") }
    : state.gatewayState === "incompatible"
    ? { tone: "error" as const, label: t("gatewayNotReady") }
    : { tone: "muted" as const, label: t("gatewayUnknown") };
  const noWorkspace = state.workspaces.length === 0;
  // Every known workspace is listed, including the ones without a container:
  // the workspaces whose newest container was created most recently come first,
  // the empty ones sort last (where they also read muted), and each workspace
  // lists its default container first, since that is the one its own mount and
  // create actions target.
  const workspaceRows = state.workspaces
    .map((workspace) => ({
      workspace,
      containers: state.containers
        .filter(
          (container) => container.workspaceSlug === workspace.workspaceSlug,
        )
        .sort((left, right) =>
          Number(right.containerName === "default") -
          Number(left.containerName === "default")
        ),
    }))
    .sort((left, right) => {
      const leftEmpty = left.containers.length === 0;
      const rightEmpty = right.containers.length === 0;
      // An empty workspace is always last, whatever the other holds.
      if (leftEmpty || rightEmpty) {
        return Number(leftEmpty) - Number(rightEmpty);
      }
      return newestContainerAt(right.containers) -
        newestContainerAt(left.containers);
    });
  // The strip counts what it names: the workspaces that actually hold a
  // container (an empty workspace is listed, but it has nothing to count), and
  // the running containers alone.
  const containerWorkspaces = workspaceRows.filter(
    ({ containers }) => containers.length > 0,
  ).length;
  const runningContainers = state.containers.filter(
    (container) => container.status === "running",
  ).length;
  return (
    <div style={pageColumn}>
      {state.notice === ""
        ? null
        : (
          <div style={banner} role={state.noticeIsError ? "alert" : "status"}>
            {t("notice")}: {state.notice}
          </div>
        )}
      {state.versionState === "ok" ? null : (
        <div
          style={{
            ...banner,
            display: "flex",
            alignItems: "center",
            gap: "8px",
          }}
          role={state.versionState === "major-mismatch" ? "alert" : "status"}
        >
          <StatusChip
            tone={state.versionState === "major-mismatch" ? "error" : "warn"}
            label={t(
              state.versionState === "major-mismatch"
                ? "versionIncompatible"
                : "versionCompatibleDifferent",
            )}
          />
          <span>
            {t(
              state.versionState === "major-mismatch"
                ? "versionMismatchMajor"
                : "versionMismatchMinor",
            )}
          </span>
        </div>
      )}
      <div style={statusStrip} role="group" aria-label={t("statusOverview")}>
        <StatusChip
          tone="muted"
          label={countLabel(
            t,
            containerWorkspaces,
            "countWorkspaceOne",
            "countWorkspaceMany",
          )}
        />
        <StatusChip
          tone="muted"
          label={countLabel(
            t,
            runningContainers,
            "countRunningContainerOne",
            "countRunningContainerMany",
          )}
        />
        <StatusChip
          tone={orchestratorChip.tone}
          label={orchestratorChip.label}
        />
        <StatusChip tone={gatewayChip.tone} label={gatewayChip.label} />
      </div>
      <SegmentedTabs<CardTab>
        label={t("settingsTabs")}
        className={TABS_CLASS}
        value={tab}
        onChange={setTab}
        items={[
          {
            value: "workspaces",
            label: t("tabWorkspaces"),
            id: tabId("workspaces"),
            panelId: panelId("workspaces"),
          },
          {
            value: "images",
            label: t("tabImages"),
            id: tabId("images"),
            panelId: panelId("images"),
          },
          {
            value: "storage",
            label: t("tabStorage"),
            id: tabId("storage"),
            panelId: panelId("storage"),
          },
          {
            value: "defaults",
            label: t("tabDefaults"),
            id: tabId("defaults"),
            panelId: panelId("defaults"),
          },
          {
            value: "status",
            label: t("tabStatus"),
            id: tabId("status"),
            panelId: panelId("status"),
          },
        ]}
      />
      {
        /* Every panel stays mounted while it is hidden, so a draft a tab holds
          (a staged container edit, an environment being typed) survives a
          switch between tabs. The body style is only applied to the visible
          panel: an inline display would otherwise beat the `hidden` attribute
          and show every tab at once. */
      }
      <div
        id={panelId("workspaces")}
        role="tabpanel"
        aria-labelledby={tabId("workspaces")}
        hidden={tab !== "workspaces"}
        style={tab === "workspaces" ? tabPanel : undefined}
      >
        {noWorkspace ? <p style={hint}>{t("noWorkspaces")}</p> : (
          workspaceRows.map(({ workspace, containers }) => (
            <WorkspaceSection
              key={workspace.workspaceSlug}
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
            />
          ))
        )}
      </div>
      <div
        id={panelId("images")}
        role="tabpanel"
        aria-labelledby={tabId("images")}
        hidden={tab !== "images"}
        style={tab === "images" ? tabPanel : undefined}
      >
        <ImagesSection
          t={t}
          images={state.images}
          busy={state.busy}
          pendingActions={state.pendingActions}
          defaultImage={state.defaultImage}
          locale={state.locale}
          onBuildImage={props.buildImage}
          onRebuildAllImages={props.rebuildAllImages}
          onRebuildBaseImage={props.rebuildBaseImage}
          onPullBaseImage={props.pullBaseImage}
          onRemoveImage={props.removeImage}
          onRebuildImage={props.rebuildImage}
          onBuildPtcImage={props.buildPtcImage}
          onSetDefaultImage={props.setDefaultImage}
        />
      </div>
      <div
        id={panelId("storage")}
        role="tabpanel"
        aria-labelledby={tabId("storage")}
        hidden={tab !== "storage"}
        style={tab === "storage" ? tabPanel : undefined}
      >
        <StorageSection
          t={t}
          volumes={state.volumes}
          secrets={state.secrets}
          caches={state.caches}
          busy={state.busy}
          writable={state.writable}
          pendingActions={state.pendingActions}
          onCleanCaches={props.cleanCaches}
          onCreateVolume={props.createVolume}
          onRemoveVolume={props.removeVolume}
          onCreateSecret={props.createSecret}
          onRemoveSecret={props.removeSecret}
          onSetSecret={props.setSecret}
        />
      </div>
      <div
        id={panelId("defaults")}
        role="tabpanel"
        aria-labelledby={tabId("defaults")}
        hidden={tab !== "defaults"}
        style={tab === "defaults" ? tabPanel : undefined}
      >
        <DefaultsSection
          t={t}
          images={state.images}
          defaultImage={state.defaultImage}
          env={state.containerEnv}
          workspaces={state.workspaces}
          containers={state.containers}
          busy={state.busy}
          writable={state.writable}
          onSetDefaultImage={props.setDefaultImage}
          onSaveEnv={props.saveContainerEnv}
          onApplyDefaultEnv={props.applyDefaultEnv}
        />
      </div>
      <div
        id={panelId("status")}
        role="tabpanel"
        aria-labelledby={tabId("status")}
        hidden={tab !== "status"}
        style={tab === "status" ? tabPanel : undefined}
      >
        <StatusSection
          t={t}
          dshVersion={state.dshVersion}
          version={state.version}
          commit={state.commit}
          versionState={state.versionState}
          orchestratorVersion={state.orchestratorVersion}
          orchestratorCommit={state.orchestratorCommit}
          orchestratorReady={state.orchestratorReady}
          orchestratorKnown={state.orchestratorKnown}
          gatewayState={state.gatewayState}
          gatewayVersion={state.gatewayVersion}
          gatewayCommit={state.gatewayCommit}
          gatewayVersionState={state.gatewayVersionState}
          ptc={state.ptc}
          locale={state.locale}
          pendingActions={state.pendingActions}
          onRecreatePtc={props.recreatePtc}
          onRemovePtc={props.removePtc}
        />
      </div>
      {
        /* The reload re-reads the whole snapshot, so it acts on the page rather
          than on one tab: it sits below the tabs, where it is reachable from
          every one of them without competing with the state chips. */
      }
      <div style={actionRow}>
        <Button
          variant="outline"
          size="sm"
          disabled={state.busy}
          onClick={props.reload}
        >
          {state.busy ? t("busy") : t("reload")}
        </Button>
      </div>
    </div>
  );
}
