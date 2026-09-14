// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { ContainerRow, CreateContainerModal } from "./container-card-row.js";
import { ConfirmButton, containerStateDot } from "./container-card-shared.js";
import { greyId, hint, wsBody } from "./container-card-styles.js";
import {
  type ContainerCreateConfig,
  type ContainerView,
  type ImageView,
  type MountInput,
  type WorkspaceView,
} from "./container-card-controller.js";
import { type ContainerPluginKey } from "./locales.js";
import { Button, DisclosureRow, StateDot } from "@deepseek-ai/dsh-client-ui-primitives";
import { type ReactNode, useState } from "react";

export function WorkspaceSection(props: {
  t: (key: ContainerPluginKey) => string;
  workspace: WorkspaceView;
  containers: readonly ContainerView[];
  images: readonly ImageView[];
  volumes: readonly { name: string }[];
  secrets: readonly { name: string }[];
  busy: boolean;
  defaultImage: string;
  onRemove: (workspace: string) => void;
  onRemoveWorkspace: (workspace: string) => void;
  onRecreate: (
    workspace: string,
    image: string,
    env?: Record<string, string>,
  ) => void;
  onCreate: (workspace: WorkspaceView, config?: ContainerCreateConfig) => void;
  onStartContainer: (
    workspace: WorkspaceView,
    container: string,
    config?: ContainerCreateConfig,
  ) => void;
  onAddContainerMount: (
    workspace: string,
    container: string,
    mount: MountInput,
  ) => void;
  onRemoveContainerMount: (
    workspace: string,
    container: string,
    mount: MountInput,
  ) => void;
  onAddContainerSecret: (workspace: string, envVar: string, secret: string) => void;
  onRemoveContainerSecret: (workspace: string, envVar: string) => void;
}): ReactNode {
  const {
    t,
    workspace,
    containers,
    images,
    volumes,
    secrets,
    busy,
    defaultImage,
    onRemove,
    onRemoveWorkspace,
    onRecreate,
    onCreate,
    onStartContainer,
    onAddContainerMount,
    onRemoveContainerMount,
    onAddContainerSecret,
    onRemoveContainerSecret,
  } = props;
  const [open, setOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState<"default" | "named" | null>(null);
  const hasContainer = containers.length > 0;
  return (
    <DisclosureRow
      icon={
        hasContainer ? (
          <StateDot state={containerStateDot(containers[0]?.status ?? "")} />
        ) : (
          <span />
        )
      }
      title={workspace.projectName}
      open={open}
      expandable
      onToggle={() => setOpen(!open)}
    >
      <div style={wsBody}>
        <code style={greyId}>{workspace.workspaceSlug}</code>
        {!hasContainer ? (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <p style={{ ...hint, margin: 0 }}>{t("noContainers")}</p>
            <div>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => setCreateOpen("default")}
              >
                {t("createContainer")}
              </Button>
            </div>
          </div>
        ) : (
          <>
            {containers.map((container) => (
              <ContainerRow
                key={container.containerName}
                t={t}
                container={container}
                images={images}
                volumes={volumes}
                secrets={secrets}
                busy={busy}
                onRemove={onRemove}
                onRecreate={onRecreate}
                onAddContainerMount={onAddContainerMount}
                onRemoveContainerMount={onRemoveContainerMount}
                onAddContainerSecret={onAddContainerSecret}
                onRemoveContainerSecret={onRemoveContainerSecret}
              />
            ))}
            <div>
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => setCreateOpen("named")}
              >
                {t("addContainer")}
              </Button>
            </div>
          </>
        )}
        <div>
          <ConfirmButton
            t={t}
            label={t("removePod")}
            title={t("confirmTitle")}
            description={t("confirmRemovePod")}
            disabled={busy}
            onConfirm={() => onRemoveWorkspace(workspace.workspaceSlug)}
          />
        </div>
      </div>
      <CreateContainerModal
        t={t}
        workspace={workspace}
        images={images}
        volumes={volumes}
        secrets={secrets}
        busy={busy}
        defaultImage={defaultImage}
        named={createOpen === "named"}
        existing={containers.map((container) => container.containerName)}
        open={createOpen !== null}
        onClose={() => setCreateOpen(null)}
        onCreate={(container, config) => {
          if (createOpen === "named") {
            onStartContainer(workspace, container, config);
          } else {
            onCreate(workspace, config);
          }
          setCreateOpen(null);
        }}
      />
    </DisclosureRow>
  );
}
