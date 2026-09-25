// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// The Podman terminal's guide card: pick a container and one of the shells that
// container really offers, then open a new terminal tab bound to that target in
// the Session's own workspace. It reads the same settings-card snapshot as the
// tab body and never asks for a workspace, because each Session has exactly one.
import { Button, PluginArtworkTerminal } from "@deepseek-ai/dsh-client-ui-primitives";
import type { InjectFace, PropsLocale, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import { type ReactNode, useEffect, useState } from "react";
import type { ContainerCardFace } from "./container-card-controller.js";
import { fieldLabel, fieldSelect, hint } from "./container-card-styles.js";
import { NS } from "./locales.js";
import { ContainerField } from "./podman-terminal.js";
import { PODMAN_TERMINAL_KIND } from "./terminal-tab.js";
import { readTerminalTarget, writeTerminalTarget } from "./terminal-preference.js";
import { containerOptions, validContainer, validShell } from "./terminal-targets.js";
import type { TerminalShellView, TerminalTargetView } from "./terminal-protocol.js";
import { fetchTerminalShells, fetchTerminalTarget } from "./terminal-transport.js";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar-right/client";

/** The card snapshot the guide reads; the tab's own actions open the terminal. */
export interface PodmanTerminalGuideInjected extends ContainerCardFace {
  /** Owning session, used by the shells route and the injection contract. */
  readonly sessionId: string;
}

export type PodmanTerminalGuideProps =
  & PropsRuntime<"sidebar.right.tab.guide.entry">
  & PropsLocale<typeof NS>
  & InjectFace<PodmanTerminalGuideInjected>;

type TargetState =
  | { readonly phase: "loading" }
  | { readonly phase: "ready"; readonly target: TerminalTargetView }
  | { readonly phase: "failed"; readonly message: string };

type ShellsState =
  | { readonly phase: "loading" }
  | { readonly phase: "ready"; readonly shells: readonly TerminalShellView[] }
  | { readonly phase: "failed"; readonly message: string };

export function PodmanTerminalGuide(
  props: PodmanTerminalGuideProps,
): ReactNode {
  const { t, sessionId } = props;
  const { tab } = props.useTabInfo();
  const state = props.useContainerCard((snapshot) => snapshot);
  // The host resolves the Session's workspace and reports it when it cannot.
  const [target, setTarget] = useState<TargetState>({ phase: "loading" });
  const workspace = target.phase === "ready" ? target.target.workspace : undefined;
  const workspaceSlug = target.phase === "ready" ? target.target.workspaceSlug : undefined;
  const unknownWorkspace = target.phase === "failed";
  const [container, setContainer] = useState<string | undefined>(undefined);
  const [shells, setShells] = useState<ShellsState>({ phase: "loading" });
  const [shell, setShell] = useState<string | undefined>(undefined);
  // The last target this browser started from the card, reused below while it
  // is still valid. Read once: the card shows it, it does not track it.
  const [stored] = useState(() => readTerminalTarget());

  useEffect(() => {
    props.reload();
  }, [props.reload]);

  useEffect(() => {
    const controller = new AbortController();
    setTarget({ phase: "loading" });
    void fetchTerminalTarget(sessionId, controller.signal).then(
      (resolved) => {
        if (!controller.signal.aborted) setTarget({ phase: "ready", target: resolved });
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

  // The empty value means the workspace's default container; the workspace
  // row's own containerName is that container's podman name, which the
  // orchestrator rejects, so it is never used as a target. The choice waits for
  // the first snapshot, otherwise the empty default would pre-empt a remembered
  // named container before the options are known.
  useEffect(() => {
    if (unknownWorkspace || workspace === undefined || container !== undefined) {
      return;
    }
    if (state.busy) return;
    setContainer(
      validContainer(stored?.container, containerOptions(state.containers, workspaceSlug)),
    );
  }, [
    unknownWorkspace,
    workspace,
    container,
    state.busy,
    state.containers,
    workspaceSlug,
    stored,
  ]);

  useEffect(() => {
    if (workspace === undefined || workspace === "" || container === undefined) {
      return;
    }
    const controller = new AbortController();
    setShells({ phase: "loading" });
    void fetchTerminalShells(
      workspace,
      container,
      sessionId,
      controller.signal,
    ).then(
      (list) => {
        if (controller.signal.aborted) return;
        setShells({ phase: "ready", shells: list });
        setShell((previous) => previous ?? validShell(stored?.shell, list) ?? list[0]?.path);
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setShells({
          phase: "failed",
          message: error instanceof Error ? error.message : String(error),
        });
      },
    );
    return () => {
      controller.abort();
    };
  }, [workspace, container, sessionId]);

  const shellList = shells.phase === "ready" ? shells.shells : [];
  const ready = !unknownWorkspace && container !== undefined && shell !== undefined &&
    shellList.length > 0;
  return (
    <div style={CARD_STYLE} data-sidebar-right-guide-entry={props.kind}>
      <div style={HEADER_STYLE}>
        <span style={ICON_STYLE} aria-hidden="true">
          <PluginArtworkTerminal size={22} />
        </span>
        <span style={TEXT_STYLE}>
          <span style={TITLE_STYLE}>{props.title}</span>
          {props.description === undefined
            ? null
            : <span style={DESCRIPTION_STYLE}>{props.description}</span>}
        </span>
      </div>
      {state.workspaces.length === 0
        ? (
          <p style={hint} role="status">
            {state.busy ? t("terminalLoading") : t("unavailable")}
          </p>
        )
        : (
          <>
            {target.phase === "failed" && <p style={hint} role="alert">{target.message}</p>}
            <div style={FIELDS_STYLE}>
              <ContainerField
                containers={state.containers}
                workspaceSlug={workspaceSlug}
                container={container}
                disabled={unknownWorkspace}
                label={t("terminalContainer")}
                defaultLabel={t("terminalDefaultContainer")}
                selectStyle={fieldSelect}
                onContainer={(value) => {
                  // The new container may not offer the current shell, so the
                  // shells effect re-picks one (remembered when still valid).
                  setContainer(value);
                  setShell(undefined);
                }}
              />
              <span style={fieldLabel}>{t("terminalShell")}</span>
              <select
                style={fieldSelect}
                aria-label={t("terminalShell")}
                value={shell ?? ""}
                disabled={unknownWorkspace || shells.phase !== "ready" ||
                  shellList.length === 0}
                onChange={(event) => {
                  setShell(event.target.value);
                }}
              >
                {shellList.length === 0
                  ? (
                    <option value="">
                      {unknownWorkspace
                        ? ""
                        : shells.phase === "loading"
                        ? t("terminalLoading")
                        : t("terminalNoShells")}
                    </option>
                  )
                  : shellList.map((entry) => (
                    <option key={entry.path} value={entry.path}>{entry.name}</option>
                  ))}
              </select>
            </div>
            {!unknownWorkspace && shells.phase === "failed" && (
              <p style={hint} role="alert">
                {t("terminalShellsFailed", { message: shells.message })}
              </p>
            )}
            {!unknownWorkspace && shells.phase === "loading" && (
              <p style={hint} role="status">{t("terminalLoading")}</p>
            )}
            {!unknownWorkspace && shells.phase === "ready" && shellList.length === 0 && (
              <p style={hint} role="status">{t("terminalNoShells")}</p>
            )}
            <div style={ACTIONS_STYLE}>
              <Button
                variant="primary"
                size="sm"
                disabled={!ready}
                onClick={() => {
                  if (container === undefined || shell === undefined) return;
                  writeTerminalTarget({ container, shell });
                  // Replace the guide tab in place, exactly like the built-in
                  // guide cards, instead of adding a second terminal tab.
                  tab.actions.openTab(PODMAN_TERMINAL_KIND, {
                    replaceTab: true,
                    params: { container, shell },
                  });
                }}
              >
                {t("terminalStart")}
              </Button>
            </div>
          </>
        )}
    </div>
  );
}

// The card mirrors the harness guide capsule skin (`GuideBody .entry`): same
// padding, radius token, border and background as the entries beside it, so the
// glyph and title line up; the column layout and the internal gaps are ours
// because this card carries controls rather than being one clickable capsule.
const CARD_STYLE: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "8px",
  boxSizing: "border-box",
  width: "100%",
  padding: "14px 20px",
  border: "0.5px solid var(--dsw-alias-border-l3)",
  borderRadius: "var(--dsl-guide-entry-radius)",
  background: "var(--dsw-alias-bg-layer-1)",
};

const HEADER_STYLE: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "14px",
  minWidth: 0,
};

const ICON_STYLE: React.CSSProperties = {
  display: "flex",
  flex: "none",
  alignItems: "center",
  justifyContent: "center",
  width: "26px",
  height: "26px",
  color: "var(--dsw-alias-label-secondary)",
};

const TEXT_STYLE: React.CSSProperties = {
  display: "flex",
  flex: 1,
  flexDirection: "column",
  gap: "2px",
  minWidth: 0,
};

const TITLE_STYLE: React.CSSProperties = {
  overflow: "hidden",
  color: "var(--dsw-alias-label-primary)",
  fontSize: "14px",
  lineHeight: 1.4,
  whiteSpace: "nowrap",
  textOverflow: "ellipsis",
};

const DESCRIPTION_STYLE: React.CSSProperties = {
  overflow: "hidden",
  color: "var(--dsw-alias-label-tertiary)",
  fontSize: "11px",
  lineHeight: 1.4,
  whiteSpace: "nowrap",
  textOverflow: "ellipsis",
};

// A label/select grid: each pair is one row, so a narrow card can never wrap a
// label away from its control, and the auto column keeps both selects aligned.
const FIELDS_STYLE: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "auto minmax(0, 1fr)",
  gap: "8px",
  alignItems: "center",
  width: "100%",
};

const ACTIONS_STYLE: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: "8px",
  alignItems: "center",
};
