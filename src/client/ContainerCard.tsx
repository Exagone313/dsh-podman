// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { BaseImageRow, ImageBuildModal, ImageItem } from "./container-card-images.js";
import { CachesSection } from "./container-card-caches.js";
import { DefaultEnvironmentSection } from "./container-card-default-env.js";
import { SecretsSection } from "./container-card-secrets.js";
import { ConfigField, ConfirmButton } from "./container-card-shared.js";
import { banner, footerRow, hint, imageSelect, sectionTitle } from "./container-card-styles.js";
import { VolumesSection } from "./container-card-volumes.js";
import { WorkspaceSection } from "./container-card-workspace.js";
import { type ContainerCardFace } from "./container-card-controller.js";
import { NS } from "./locales.js";
import { Button, Input, Modal, writeClipboard } from "@deepseek-ai/dsh-client-ui-primitives";
import {
  type InjectFace,
  type PropsLocale,
  type PropsRuntime,
} from "@deepseek-ai/dsh-client-ui-slots";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";

// The labels of the version lines, emphasised against their values.
const versionLabel: React.CSSProperties = { fontWeight: 600 };

export type ContainerCardProps =
  & PropsRuntime<"plugins.bundle.config">
  & PropsLocale<typeof NS>
  & InjectFace<ContainerCardFace>;

export function ContainerCard(props: ContainerCardProps): ReactNode {
  const { t } = props;
  const state = props.useContainerCard((snapshot) => snapshot);
  const [buildOpen, setBuildOpen] = useState(false);
  const [imageId, setImageId] = useState("");
  const [parent, setParent] = useState("");
  const [packages, setPackages] = useState<string[]>([]);
  const [defaultOpen, setDefaultOpen] = useState(false);
  const [defaultImage, setDefaultImage] = useState(state.defaultImage);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const copyResetTimer = useRef<ReturnType<typeof setTimeout>>();
  const projectsRootId = useId();
  // Copies the version lines as displayed, so a user can paste them into a bug
  // report without transcribing anything.
  const copyVersions = async (): Promise<void> => {
    const lines = [
      `${t("dsh")} ${state.dshVersion || t("versionUnknown")}`,
      `${t("cardTitle")} ${state.version}${state.commit ? ` · ${state.commit}` : ""}`,
      `${t("orchestrator")} ${state.orchestratorVersion || t("versionUnknown")}`,
    ];
    setCopyState((await writeClipboard(lines.join("\n"))) ? "copied" : "failed");
    if (copyResetTimer.current !== undefined) clearTimeout(copyResetTimer.current);
    copyResetTimer.current = setTimeout(() => setCopyState("idle"), 1500);
  };
  // The reset timer is cancelled on unmount, so it cannot fire against an
  // unmounted component.
  useEffect(
    () => () => {
      if (copyResetTimer.current !== undefined) clearTimeout(copyResetTimer.current);
    },
    [],
  );
  // The Plugins page renders a one-liner in its list and this component again
  // as the entry's page, so the orchestrator snapshot is only fetched for the
  // page. Re-reading on every page view keeps a workspace created since the
  // last visit visible without pressing Reload.
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh per page view
  useEffect(() => {
    if (props.view === "page") props.reload();
  }, [props.view]);
  // The list shows only the one-liner; the page heading already carries the
  // plugin's title and description.
  if (props.view === "summary") return t("cardDescription");
  const baseImages = state.images.filter((image) => image.isBase);
  const customImages = state.images.filter((image) => !image.isBase);
  const defaultCandidates = [
    ...baseImages.map((image) => image.imageId),
    ...customImages.map((image) => image.imageId),
  ];
  if (!state.available) {
    return (
      <div style={{ padding: "8px 0", fontSize: "13px", opacity: 0.8 }}>
        <p style={{ margin: 0 }}>{t("unavailable")}</p>
        {state.notice === "" ? null : (
          <p style={{ margin: "4px 0 0" }} role="status">
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
  return (
    <div>
      {state.notice === "" ? null : (
        <div style={banner} role="status">
          {t("notice")}: {state.notice}
        </div>
      )}
      {state.versionState === "ok" ? null : (
        <div
          style={state.versionState === "major-mismatch"
            ? { ...banner, borderColor: "var(--dsw-alias-state-error-primary)" }
            : banner}
          role={state.versionState === "major-mismatch" ? "alert" : "status"}
        >
          {t(
            state.versionState === "major-mismatch"
              ? "versionMismatchMajor"
              : "versionMismatchMinor",
          )}
        </div>
      )}
      <div style={sectionTitle}>{t("workspacesTitle")}</div>
      {state.workspaces.length === 0 ? <p style={hint}>{t("none")}</p> : (
        state.workspaces.map((workspace) => (
          <WorkspaceSection
            key={workspace.workspaceSlug}
            t={t}
            workspace={workspace}
            containers={state.containers.filter(
              (container) => container.workspaceSlug === workspace.workspaceSlug,
            )}
            images={state.images}
            volumes={state.volumes}
            secrets={state.secrets}
            busy={state.busy}
            defaultImage={state.defaultImage}
            projectsRoot={state.projectsRoot}
            directoryPicker={state.directoryPicker}
            onRemove={props.remove}
            onRemoveWorkspace={props.removeWorkspace}
            onRecreate={props.recreate}
            onCreate={props.createContainer}
            onStartContainer={props.startContainer}
            onAddContainerMount={props.addContainerMount}
            onRemoveContainerMount={props.removeContainerMount}
            onUpdateContainerMount={props.updateContainerMount}
            onSetContainerPaths={props.setContainerPaths}
            onAddContainerSecret={props.addContainerSecret}
            onRemoveContainerSecret={props.removeContainerSecret}
            onSyncDefaults={props.syncDefaultEnv}
            defaultEnvCount={Object.keys(state.containerEnv).length}
          />
        ))
      )}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "8px",
        }}
      >
        <div style={{ ...sectionTitle, flex: 1 }}>{t("imagesTitle")}</div>
        <Button
          variant="outline"
          size="sm"
          disabled={state.busy}
          onClick={() => {
            setDefaultImage(state.defaultImage);
            setDefaultOpen(true);
          }}
        >
          {t("setDefaultImage")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={state.busy}
          onClick={() => {
            setImageId("");
            setParent(baseImages[0]?.imageId ?? customImages[0]?.imageId ?? "");
            setPackages([]);
            setBuildOpen(true);
          }}
        >
          {t("buildImage")}
        </Button>
        <ConfirmButton
          t={t}
          label={t("rebuildAllImages")}
          title={t("confirmTitle")}
          description={t("confirmRebuildAllImages")}
          disabled={state.busy}
          onConfirm={props.rebuildAllImages}
        />
      </div>
      <div style={sectionTitle}>{t("baseImagesTitle")}</div>
      {baseImages.length === 0 ? <p style={hint}>{t("none")}</p> : (
        baseImages.map((image) => (
          <BaseImageRow
            key={image.imageId}
            t={t}
            image={image}
            busy={state.busy}
            defaultImage={state.defaultImage}
            onRebuild={props.rebuildBaseImage}
            onPull={props.pullBaseImage}
            onSetDefault={props.setDefaultImage}
          />
        ))
      )}
      <div style={sectionTitle}>{t("customImagesTitle")}</div>
      {customImages.length === 0 ? <p style={hint}>{t("none")}</p> : (
        customImages.map((image) => (
          <ImageItem
            key={image.imageId}
            t={t}
            image={image}
            busy={state.busy}
            defaultImage={state.defaultImage}
            onRemove={props.removeImage}
            onRebuild={props.rebuildImage}
            onSetDefault={props.setDefaultImage}
          />
        ))
      )}
      <ImageBuildModal
        t={t}
        images={state.images}
        open={buildOpen}
        imageId={imageId}
        parent={parent}
        packages={packages}
        onImageId={setImageId}
        onParent={setParent}
        onPackages={setPackages}
        onClose={() => setBuildOpen(false)}
        onBuild={() => {
          props.buildImage(imageId.trim(), parent.trim(), packages);
          setImageId("");
          setParent("");
          setPackages([]);
          setBuildOpen(false);
        }}
      />
      <Modal
        open={defaultOpen}
        onClose={() => setDefaultOpen(false)}
        title={t("setDefaultImageTitle")}
        closeLabel={t("cancel")}
        footer={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDefaultOpen(false)}
            >
              {t("cancel")}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={defaultImage === ""}
              onClick={() => {
                props.setDefaultImage(defaultImage);
                setDefaultOpen(false);
              }}
            >
              {t("setDefaultImage")}
            </Button>
          </>
        }
      >
        <select
          style={imageSelect}
          value={defaultImage}
          onChange={(event) => setDefaultImage(event.target.value)}
        >
          {defaultCandidates.length === 0 ? <option value="">{t("none")}</option> : null}
          {defaultCandidates.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <p style={hint}>{t("defaultImageHint")}</p>
      </Modal>
      <CachesSection
        t={t}
        caches={state.caches}
        busy={state.busy}
        onClean={props.cleanCaches}
      />
      <VolumesSection
        t={t}
        volumes={state.volumes}
        busy={state.busy}
        writable={state.writable}
        onCreate={props.createVolume}
        onRemove={props.removeVolume}
      />
      <SecretsSection
        t={t}
        secrets={state.secrets}
        busy={state.busy}
        writable={state.writable}
        onCreate={props.createSecret}
        onRemove={props.removeSecret}
        onSet={props.setSecret}
      />
      <div style={sectionTitle}>{t("configTitle")}</div>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "8px",
          padding: "8px 0",
        }}
      >
        <label
          htmlFor={projectsRootId}
          style={{
            fontSize: "13px",
            color: "var(--dsw-alias-label-secondary)",
            minWidth: "110px",
          }}
        >
          {t("projectsRoot")}
        </label>
        <Input
          id={projectsRootId}
          value={state.projectsRoot}
          disabled
          style={{ width: "200px" }}
        />
      </div>
      <ConfigField
        t={t}
        label={t("socketsRoot")}
        value={state.socketsRootDraft}
        current={state.socketsRoot}
        writable={state.writable}
        onChange={props.editSocketsRoot}
        onSave={props.saveSocketsRoot}
        onDiscard={props.discardSocketsRoot}
      />
      <DefaultEnvironmentSection
        t={t}
        env={state.containerEnv}
        busy={state.busy}
        writable={state.writable}
        onSave={props.saveContainerEnv}
        onSync={props.syncDefaultEnv}
      />
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          gap: "8px",
        }}
      >
        <div style={{ ...sectionTitle, flex: 1 }}>{t("versionsTitle")}</div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void copyVersions()}
        >
          {copyState === "copied"
            ? t("copied")
            : copyState === "failed"
            ? t("copyFailed")
            : t("copyVersions")}
        </Button>
      </div>
      <div
        style={{
          ...hint,
          display: "flex",
          flexDirection: "column",
          gap: "2px",
          margin: 0,
        }}
      >
        <span>
          <span style={versionLabel}>{t("dsh")}</span>
          {state.dshVersion
            ? (
              ` ${state.dshVersion}`
            )
            : (
              <>
                {" "}
                <span
                  style={{ color: "var(--dsw-alias-state-error-primary)" }}
                >
                  {t("versionUnknown")}
                </span>
              </>
            )}
        </span>
        <span>
          <span style={versionLabel}>{t("cardTitle")}</span>
          {state.version ? ` ${state.version}` : ""}
          {state.commit ? ` · ${state.commit}` : ""}
        </span>
        <span>
          <span style={versionLabel}>{t("orchestrator")}</span>
          {state.orchestratorVersion
            ? (
              ` ${state.orchestratorVersion}`
            )
            : (
              <>
                {" "}
                <span
                  style={{ color: "var(--dsw-alias-state-error-primary)" }}
                >
                  {t("versionUnknown")}
                </span>
              </>
            )}
        </span>
      </div>
      <div style={footerRow}>
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
