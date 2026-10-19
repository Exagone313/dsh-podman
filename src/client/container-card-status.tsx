// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// The Status tab: one table naming every component the card knows about — the
// harness, this plugin and the two daemons it talks to — with the state each
// one reports, its version and its commit, and the button that copies the lines
// for a bug report. The State column carries the runtime state and, beside it,
// the version comparison: a component the plugin runs alongside reads "ready"
// plus "different versions", one the plugin cannot talk to reads "incompatible".
// The reload that re-reads the snapshot sits at the bottom of the page, below
// the tabs, so it stays reachable from every tab.

import { CardGroup } from "./container-card-group.js";
import {
  countLabel,
  StatusChip,
  type StatusTone,
  Subsection,
} from "./container-card-shared.js";
import {
  TABLE_CARD_CLASS,
  TABLE_CLASS,
} from "./container-card-table-styles.js";
import { missingValue } from "./container-card-styles.js";
import { type CardState } from "./container-card-controller.js";
import { type ContainerPluginKey, type Translate } from "./locales.js";
import { Button, writeClipboard } from "@deepseek-ai/dsh-client-ui-primitives";
import { type ReactNode, useEffect, useRef, useState } from "react";

// One cell of the version table: the landed body scale, while the responsive
// stylesheet owns its padding and the hairlines between rows.
const versionCell: React.CSSProperties = {
  fontSize: "13px",
  lineHeight: "20px",
  color: "var(--dsw-alias-label-primary)",
};

// A commit is an opaque hash, so it reads in the mono face and one step down
// from the component it belongs to.
const versionCommit: React.CSSProperties = {
  ...versionCell,
  color: "var(--dsw-alias-label-secondary)",
  fontFamily: "var(--dsw-alias-font-mono, ui-monospace, monospace)",
};

// A state chip and the divergence chip beside it, on one wrapping line.
const stateLine: React.CSSProperties = {
  display: "inline-flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "6px",
};

// The table is spaced off the section title above it.
const versionTable: React.CSSProperties = {
  marginTop: "12px",
};

// A version divergence: the words and the tone that name how a component's
// version compares with the plugin's own.
interface VersionNote {
  tone: StatusTone;
  label: ContainerPluginKey;
}

// One component's row: its runtime state, the divergence chip that belongs
// beside it, its version and its commit. A component with no runtime of its own
// (this plugin) carries no state chip, and a component whose state already reads
// "incompatible" needs no second chip saying the same thing.
interface ComponentRow {
  key: string;
  component: string;
  state?: { tone: StatusTone; label: ContainerPluginKey };
  versionNote?: VersionNote;
  version: string;
  commit: string;
}

// The chip a version comparison earns: a compatible difference is a warning, a
// major mismatch an error, and an exact match no chip at all.
function versionNote(
  state: CardState["versionState"],
): VersionNote | undefined {
  if (state === "major-mismatch") {
    return { tone: "error", label: "versionIncompatible" };
  }
  if (state === "minor-mismatch") {
    return { tone: "warn", label: "versionCompatibleDifferent" };
  }
  return undefined;
}

export function StatusSection(props: {
  t: Translate;
  dshVersion: string;
  version: string;
  commit: string;
  versionState: CardState["versionState"];
  orchestratorVersion: string;
  orchestratorCommit: string;
  // Whether the last snapshot reached the orchestrator, and whether any fetch
  // has settled yet: readiness is only a fact once the first answer arrives.
  orchestratorReady: boolean;
  orchestratorKnown: boolean;
  gatewayState: CardState["gatewayState"];
  gatewayVersion: string;
  gatewayCommit: string;
  gatewayVersionState: CardState["gatewayVersionState"];
}): ReactNode {
  const {
    t,
    dshVersion,
    version,
    commit,
    versionState,
    orchestratorVersion,
    orchestratorCommit,
    orchestratorReady,
    orchestratorKnown,
    gatewayState,
    gatewayVersion,
    gatewayCommit,
    gatewayVersionState,
  } = props;
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const copyResetTimer = useRef<ReturnType<typeof setTimeout>>();
  // Copies the version lines as displayed, so a user can paste them into a bug
  // report without transcribing anything.
  const copyVersions = async (): Promise<void> => {
    const lines = [
      `${t("dsh")} ${dshVersion || t("valueMissing")}`,
      `${t("cardTitle")} ${version}${commit ? ` · ${commit}` : ""}`,
      `${t("orchestrator")} ${orchestratorVersion || t("valueMissing")}${
        orchestratorCommit ? ` · ${orchestratorCommit}` : ""
      }`,
      `${t("gateway")} ${
        gatewayState === "running"
          ? `${gatewayVersion}${gatewayCommit ? ` · ${gatewayCommit}` : ""}`
          : gatewayState === "incompatible"
          ? t("gatewayIncompatible")
          : t("gatewayNotRunning")
      }`,
    ];
    setCopyState(
      (await writeClipboard(lines.join("\n"))) ? "copied" : "failed",
    );
    if (copyResetTimer.current !== undefined) {
      clearTimeout(copyResetTimer.current);
    }
    copyResetTimer.current = setTimeout(() => setCopyState("idle"), 1500);
  };
  // The reset timer is cancelled on unmount, so it cannot fire against an
  // unmounted component.
  useEffect(
    () => () => {
      if (copyResetTimer.current !== undefined) {
        clearTimeout(copyResetTimer.current);
      }
    },
    [],
  );
  // How many version lines the snapshot actually knows, so the header states a
  // real count rather than the four rows it always renders.
  const knownVersions = [
    dshVersion,
    version,
    orchestratorVersion,
    gatewayState === "running" ? gatewayVersion : "",
  ].filter((line) => line !== "").length;
  // The gateway's runtime state alone: the version comparison rides the State
  // cell beside it, except when the state already reads as the incompatibility.
  const gatewayRowState: ComponentRow["state"] = gatewayState === "running"
    ? { tone: "ok", label: "stateReady" }
    : gatewayState === "incompatible"
    ? { tone: "error", label: "versionIncompatible" }
    : gatewayState === "absent"
    ? { tone: "warn", label: "stateAbsent" }
    : { tone: "muted", label: "stateUnknown" };
  // The orchestrator's state, refined by the comparison: an orchestrator whose
  // versions are incompatible refuses every call, so its state names that rather
  // than repeating "not ready" beside a second "incompatible" chip. A compatible
  // difference leaves the state alone and rides beside it.
  const orchestratorNote = versionNote(versionState);
  const orchestratorRowState: ComponentRow["state"] = !orchestratorKnown
    ? { tone: "muted", label: "stateUnknown" }
    : !orchestratorReady
    ? orchestratorNote?.tone === "error"
      ? { tone: "error", label: "versionIncompatible" }
      : { tone: "error", label: "stateNotReady" }
    : { tone: "ok", label: "stateReady" };
  const componentRows: ComponentRow[] = [
    {
      key: "dsh",
      component: t("dsh"),
      state: dshVersion === ""
        ? { tone: "muted", label: "stateUnknown" }
        : { tone: "ok", label: "stateReady" },
      version: dshVersion,
      commit: "",
    },
    {
      key: "plugin",
      component: t("cardTitle"),
      // This plugin is not a separate daemon, so it reports no runtime state;
      // its version is the reference the other rows are compared against.
      version,
      commit,
    },
    {
      key: "orchestrator",
      component: t("orchestrator"),
      state: orchestratorRowState,
      versionNote: orchestratorRowState.label === "versionIncompatible"
        ? undefined
        : orchestratorNote,
      version: orchestratorVersion,
      commit: orchestratorCommit,
    },
    {
      key: "gateway",
      component: t("gateway"),
      state: gatewayRowState,
      versionNote: gatewayState === "running"
        ? versionNote(gatewayVersionState)
        : undefined,
      version: gatewayVersion,
      commit: gatewayCommit,
    },
  ];
  return (
    <CardGroup
      title={t("groupStatusTitle")}
      summary={countLabel(
        t,
        knownVersions,
        "countVersionOne",
        "countVersionMany",
      )}
      // The version table is always listed, so the card always has content.
      hasContent
      className={TABLE_CARD_CLASS}
    >
      <Subsection
        title={t("versionsTitle")}
        action={
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
        }
      >
        <table className={TABLE_CLASS} style={versionTable}>
          <thead>
            <tr>
              <th scope="col">{t("columnComponent")}</th>
              <th scope="col">{t("columnState")}</th>
              <th scope="col">{t("columnVersion")}</th>
              <th scope="col">{t("columnCommit")}</th>
            </tr>
          </thead>
          <tbody>
            {componentRows.map((row) => (
              <tr key={row.key}>
                <td data-label={t("columnComponent")} style={versionCell}>
                  {row.component}
                </td>
                <td data-label={t("columnState")} style={versionCell}>
                  <span style={stateLine}>
                    {row.state === undefined
                      ? <span style={missingValue}>{t("valueMissing")}</span>
                      : (
                        <StatusChip
                          tone={row.state.tone}
                          label={t(row.state.label)}
                        />
                      )}
                    {row.versionNote === undefined ? null : (
                      <StatusChip
                        tone={row.versionNote.tone}
                        label={t(row.versionNote.label)}
                      />
                    )}
                  </span>
                </td>
                <td data-label={t("columnVersion")} style={versionCell}>
                  {row.version === ""
                    ? <span style={missingValue}>{t("valueMissing")}</span>
                    : row.version}
                </td>
                <td data-label={t("columnCommit")} style={versionCommit}>
                  {row.commit === ""
                    ? <span style={missingValue}>{t("valueMissing")}</span>
                    : row.commit}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Subsection>
    </CardGroup>
  );
}
