// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { type PortConfig } from "./container-card-config.js";
import { COMPACT_DIALOG_CLASS } from "./container-card-dialog-styles.js";
import { Field, PortRow } from "./container-card-shared.js";
import { hint, imageSelect } from "./container-card-styles.js";
import { ROW_LIST_CLASS } from "./container-card-table-styles.js";
import type { Translate } from "./locales.js";
import { Button, Input, Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import { type ReactNode, useId, useState } from "react";

// The container-port range a published port may name, and the host-port range
// the gateway binds from (it never binds a privileged port).
const MIN_PORT = 1;
const MAX_PORT = 65535;
const MIN_HOST_PORT = 1024;
const MAX_HOST_PORT = 65535;

// The one transport the gateway implements today; the wire carries a protocol,
// so the dialog names the field even while tcp is the only choice.
const PROTOCOLS = ["tcp"];

function parsePort(value: string): number | undefined {
  if (!/^[0-9]+$/.test(value)) return undefined;
  const port = Number(value);
  return port >= MIN_PORT && port <= MAX_PORT ? port : undefined;
}

function parseHostPort(value: string): number | undefined {
  if (!/^[0-9]+$/.test(value)) return undefined;
  const port = Number(value);
  return port >= MIN_HOST_PORT && port <= MAX_HOST_PORT ? port : undefined;
}

// PortsEditor edits the draft list of ports a container should publish. Each
// listed port renders as the shared port row — Container port, Host port,
// Protocol, the same labels and slots as the container block — and the one
// Publish port button opens a small dialog for the port and its protocol: a
// staged addition only reaches the gateway when the footer action applies the
// draft, so the editor never dials the host itself. The orchestrator stays
// the only boundary: an out-of-range value is refused here so the common mistake
// never leaves the browser, and everything else (a taken host port, a stopped
// container, a missing gateway) comes back as the card's notice.
export function PortsEditor(props: {
  t: Translate;
  ports: readonly PortConfig[];
  busy: boolean;
  enabled: boolean;
  canPublish: boolean;
  // True only when the snapshot knows the gateway is missing or incompatible;
  // an unknown state (an orchestrator predating the status RPC) must not block
  // publishing, whose own error is the honest answer.
  gatewayUnavailable: boolean;
  onChange: (ports: PortConfig[]) => void;
}): ReactNode {
  const {
    t,
    ports,
    busy,
    enabled,
    canPublish,
    gatewayUnavailable,
    onChange,
  } = props;
  const [open, setOpen] = useState(false);
  const [port, setPort] = useState("");
  const [hostPort, setHostPort] = useState("");
  const [protocol, setProtocol] = useState(PROTOCOLS[0]);
  const portId = useId();
  const hostPortId = useId();
  const protocolId = useId();
  const containerPort = parsePort(port);
  // An empty suggestion asks the gateway for a free host port; a filled one must
  // be in range before the addition is staged.
  const suggested = hostPort === "" ? undefined : parseHostPort(hostPort);
  const hostPortInvalid = hostPort !== "" && suggested === undefined;
  const duplicate = containerPort !== undefined &&
    ports.some((published) =>
      published.port === containerPort && published.protocol === protocol
    );
  const canAdd = canPublish && !busy && containerPort !== undefined &&
    !hostPortInvalid && !duplicate;
  const openDialog = (): void => {
    setPort("");
    setHostPort("");
    setProtocol(PROTOCOLS[0]);
    setOpen(true);
  };
  const add = (): void => {
    if (!canAdd || containerPort === undefined) return;
    onChange([
      ...ports,
      {
        port: containerPort,
        protocol,
        endpoint: "",
        suggestedHostPort: suggested ?? 0,
        hostPort: 0,
      },
    ]);
    setOpen(false);
  };
  const remove = (target: PortConfig): void => {
    onChange(
      ports.filter((published) =>
        published.port !== target.port ||
        published.protocol !== target.protocol
      ),
    );
  };
  const rowStyle: React.CSSProperties = {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "8px",
  };
  // The editor's own column carries the shared list marker, so its rows are
  // separated once they stack exactly like the block's; the wrapper holds the
  // whole editor, so the group's own gap between the rows and the controls
  // below them stays unchanged.
  return (
    <div
      className={ROW_LIST_CLASS}
      style={{ display: "flex", flexDirection: "column", gap: "8px" }}
    >
      {ports.map((published) => (
        <PortRow
          key={`${published.protocol}/${published.port}`}
          t={t}
          mode="edit"
          port={published.port}
          protocol={published.protocol}
          hostPort={published.hostPort}
          suggestedHostPort={published.suggestedHostPort}
          pending={published.endpoint === ""}
          disabled={busy}
          onRemove={() => remove(published)}
          removeLabel={published.endpoint === ""
            ? t("remove")
            : t("unpublishPort")}
        />
      ))}
      {canPublish || !enabled
        ? null
        : (
          <p style={{ ...hint, paddingTop: "8px" }}>
            {gatewayUnavailable
              ? t("publishNeedsGateway")
              : t("containerNotRunning")}
          </p>
        )}
      <div style={rowStyle}>
        <Button
          variant="outline"
          size="sm"
          disabled={!canPublish || busy}
          onClick={openDialog}
        >
          {t("publishPort")}
        </Button>
      </div>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={t("publishPort")}
        closeLabel={t("cancel")}
        className={COMPACT_DIALOG_CLASS}
        footer={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setOpen(false)}
            >
              {t("cancel")}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={!canAdd}
              onClick={add}
            >
              {t("publishPort")}
            </Button>
          </>
        }
      >
        <div
          style={{ display: "flex", flexDirection: "column", gap: "12px" }}
        >
          <Field label={t("containerPort")} htmlFor={portId}>
            <Input
              id={portId}
              type="number"
              min={MIN_PORT}
              max={MAX_PORT}
              value={port}
              disabled={!canPublish || busy}
              autoFocus
              onChange={(event) => setPort(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") add();
              }}
            />
            {port !== "" && containerPort === undefined
              ? (
                <p style={{ ...hint, margin: 0 }} role="alert">
                  {t("invalidPort")}
                </p>
              )
              : null}
            {duplicate
              ? (
                <p style={{ ...hint, margin: 0 }} role="alert">
                  {t("portDuplicate")}
                </p>
              )
              : null}
          </Field>
          <Field label={t("hostPortOptional")} htmlFor={hostPortId}>
            <Input
              id={hostPortId}
              type="number"
              min={MIN_HOST_PORT}
              max={MAX_HOST_PORT}
              value={hostPort}
              disabled={!canPublish || busy}
              onChange={(event) => setHostPort(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") add();
              }}
            />
            {hostPortInvalid
              ? (
                <p style={{ ...hint, margin: 0 }} role="alert">
                  {t("invalidHostPort")}
                </p>
              )
              : null}
          </Field>
          <Field label={t("protocol")} htmlFor={protocolId}>
            <select
              id={protocolId}
              style={imageSelect}
              value={protocol}
              disabled={!canPublish || busy}
              onChange={(event) => setProtocol(event.target.value)}
            >
              {PROTOCOLS.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {candidate}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </Modal>
    </div>
  );
}
