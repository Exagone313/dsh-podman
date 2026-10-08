// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { type PublishedPortView } from "./container-card-controller.js";
import { ConfirmButton } from "./container-card-shared.js";
import { greyId, hint } from "./container-card-styles.js";
import type { Translate } from "./locales.js";
import { Button, Input } from "@deepseek-ai/dsh-client-ui-primitives";
import { type ReactNode, useState } from "react";

// The pod-port range a published port may name, and the host-port range the
// gateway binds from (it never binds a privileged port).
const MIN_PORT = 1;
const MAX_PORT = 65535;
const MIN_HOST_PORT = 1024;
const MAX_HOST_PORT = 65535;

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

// PortsEditor lists what a container publishes and publishes one more. The
// orchestrator is the only boundary: an out-of-range value is refused here so
// the common mistake never leaves the browser, and everything else (a taken
// host port, a stopped container, a missing gateway) comes back as the card's
// notice.
export function PortsEditor(props: {
  t: Translate;
  ports: readonly PublishedPortView[];
  busy: boolean;
  enabled: boolean;
  canPublish: boolean;
  // True only when the snapshot knows the gateway is missing or incompatible;
  // an unknown state (an orchestrator predating the status RPC) must not block
  // publishing, whose own error is the honest answer.
  gatewayUnavailable: boolean;
  onPublish: (port: number, suggestedHostPort?: number) => void;
  onUnpublish: (port: number, protocol: string) => void;
}): ReactNode {
  const {
    t,
    ports,
    enabled,
    canPublish,
    gatewayUnavailable,
    onPublish,
    onUnpublish,
  } = props;
  const [port, setPort] = useState("");
  const [hostPort, setHostPort] = useState("");
  const podPort = parsePort(port);
  // An empty suggestion asks the gateway for a free host port; a filled one must
  // be in range before the publish leaves the browser.
  const suggested = hostPort === "" ? undefined : parseHostPort(hostPort);
  const hostPortInvalid = hostPort !== "" && suggested === undefined;
  const submit = (): void => {
    if (podPort === undefined || !canPublish || hostPortInvalid) return;
    onPublish(podPort, suggested);
    setPort("");
    setHostPort("");
  };
  const rowStyle = {
    display: "flex",
    flexWrap: "wrap" as const,
    alignItems: "center",
    gap: "8px",
  };
  return (
    <>
      {ports.length === 0 ? <p style={hint}>{t("none")}</p> : (
        ports.map((published) => (
          <div
            key={`${published.protocol}/${published.port}`}
            style={rowStyle}
          >
            <code
              style={{
                ...greyId,
                flex: 1,
                fontSize: "13px",
                color: "var(--dsw-alias-label-primary)",
              }}
            >
              {published.endpoint}
            </code>
            <ConfirmButton
              t={t}
              label={t("unpublishPort")}
              title={t("confirmTitle")}
              description={t("confirmUnpublishPort", {
                port: String(published.port),
                protocol: published.protocol,
              })}
              disabled={!enabled}
              onConfirm={() => onUnpublish(published.port, published.protocol)}
            />
          </div>
        ))
      )}
      {canPublish || !enabled
        ? null
        : (
          <p style={{ ...hint, paddingTop: "8px" }}>
            {gatewayUnavailable
              ? t("publishNeedsGateway")
              : t("containerNotRunning")}
          </p>
        )}
      <div style={{ ...rowStyle, paddingTop: "8px" }}>
        <Input
          type="number"
          min={MIN_PORT}
          max={MAX_PORT}
          value={port}
          disabled={!canPublish}
          placeholder={t("podPort")}
          onChange={(event) => setPort(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit();
          }}
          style={{ width: "140px" }}
        />
        <Input
          type="number"
          min={MIN_HOST_PORT}
          max={MAX_HOST_PORT}
          value={hostPort}
          disabled={!canPublish}
          placeholder={t("hostPortOptional")}
          onChange={(event) => setHostPort(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit();
          }}
          style={{ width: "200px" }}
        />
        <Button
          variant="outline"
          size="sm"
          disabled={!canPublish || podPort === undefined || hostPortInvalid}
          onClick={submit}
        >
          {t("publishPort")}
        </Button>
      </div>
      {port !== "" && podPort === undefined
        ? <p style={{ ...hint, margin: 0 }}>{t("invalidPort")}</p>
        : null}
      {hostPortInvalid
        ? <p style={{ ...hint, margin: 0 }}>{t("invalidHostPort")}</p>
        : null}
    </>
  );
}
