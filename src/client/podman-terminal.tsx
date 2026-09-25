// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// The Podman terminal tab's body: target pickers (workspace, container, shell)
// over the settings card's live snapshot, and one xterm screen bound to the
// host's terminal stream. Closing the tab only detaches; the host retains the
// shell, and reopening the same tab reattaches and replays a snapshot.
import { FitAddon } from "@xterm/addon-fit";
import { type ITheme, Terminal } from "@xterm/xterm";
import xtermCss from "@xterm/xterm/css/xterm.css";
import { Button } from "@deepseek-ai/dsh-client-ui-primitives";
import type { InjectFace, PropsLocale, PropsRuntime } from "@deepseek-ai/dsh-client-ui-slots";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ContainerView, WorkspaceView } from "./card-protocol.js";
import type { ContainerCardFace } from "./container-card-controller.js";
import { imageSelect } from "./container-card-styles.js";
import { NS } from "./locales.js";
import type { PodmanTerminalParams } from "./terminal-tab.js";
import type { TerminalFrame, TerminalShellView } from "./terminal-protocol.js";
import { containerOptions } from "./terminal-targets.js";
import {
  base64ToBytes,
  bytesToBase64,
  fetchTerminalShells,
  openTerminalStream,
  sendTerminalControl,
} from "./terminal-transport.js";
import type {} from "@deepseek-ai/dsh-client-ui-sidebar-right/client";

// One TextEncoder serves every keystroke: the type is stateless for our use.
const TEXT_ENCODER = new TextEncoder();

// The xterm stylesheet is imported as text (the build's `.css` loader) and
// injected once, under this attribute, so a plugin reload cannot duplicate it.
const XTERM_STYLE_ATTRIBUTE = "data-dsh-podman-xterm";
const XTERM_CLASS = "dsh-podman-xterm";
const XTERM_STYLES = `
.${XTERM_CLASS}, .${XTERM_CLASS} .xterm { height: 100%; }
.${XTERM_CLASS} .xterm-viewport { background: var(--dsw-alias-bg-layer-2); }
`;
let xtermStylesInstalled = false;

function installXtermStyles(): void {
  if (xtermStylesInstalled || typeof document === "undefined") return;
  xtermStylesInstalled = true;
  if (document.head.querySelector(`style[${XTERM_STYLE_ATTRIBUTE}]`) !== null) {
    return;
  }
  const tag = document.createElement("style");
  tag.setAttribute(XTERM_STYLE_ATTRIBUTE, "");
  tag.textContent = `${xtermCss}\n${XTERM_STYLES}`;
  document.head.appendChild(tag);
}

// The screen follows the app theme through its CSS variables, read once at
// mount (a live theme change is a future concern; the harness's own terminal
// re-reads them through the theme service).
function readTerminalTheme(): ITheme {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string): string => {
    const value = style.getPropertyValue(name).trim();
    return value === "" ? fallback : value;
  };
  const foreground = read("--dsw-alias-label-primary", "#e6e8ee");
  return {
    background: read("--dsw-alias-bg-layer-2", "#17191d"),
    foreground,
    cursor: read("--dsw-alias-brand-primary", foreground),
    selectionBackground: read(
      "--dsw-alias-label-secondary",
      "rgba(126, 146, 184, 0.4)",
    ),
  };
}

// `ui-session`, a harness client plugin the product always loads, merges these
// two members into every session-scope slot's props. It is not a dependency of
// this package, so its declaration merge is absent here; declaring the share
// we consume (optionally, so the registration's composed-props check still
// holds) keeps the body honest about what the runtime hands it.
interface PodmanSessionState {
  readonly header?: { readonly cwd?: string } | undefined;
}
interface SessionStandardShare {
  /** Selector over the current Session's state. */
  readonly useSession?: <T>(selector: (state: PodmanSessionState) => T) => T;
}

// A stable stand-in keeps the selector-hook call unconditional even if the
// type-level share is missing; the runtime binding always supplies the real
// hook, so this branch never runs in the product.
const noSession = (
  _selector: (state: PodmanSessionState) => unknown,
): undefined => undefined;

/** Everything the tab body is given: framework shares plus the injected card face. */
export interface PodmanTerminalInjected extends ContainerCardFace {
  /** Owning session, injected by the session-scope registration. */
  readonly sessionId: string;
}

export type PodmanTerminalProps =
  & PropsRuntime<"sidebar.right.pane.tab">
  & PropsLocale<typeof NS>
  & InjectFace<PodmanTerminalInjected>
  & SessionStandardShare;

type ShellsState =
  | { readonly phase: "loading" }
  | { readonly phase: "ready"; readonly shells: readonly TerminalShellView[] }
  | { readonly phase: "failed"; readonly message: string };

type TerminalStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "connecting" }
  | { readonly kind: "running" }
  | { readonly kind: "exited"; readonly code: number | null }
  | { readonly kind: "detached" }
  | { readonly kind: "error"; readonly message: string };

/** The workspace's project name, when `cwd` is `<projectsRoot>/<projectName>/…`. */
function projectNameFromCwd(
  cwd: string | undefined,
  projectsRoot: string,
): string | undefined {
  if (cwd === undefined || cwd === "" || projectsRoot === "") return undefined;
  const prefix = projectsRoot.endsWith("/") ? projectsRoot : `${projectsRoot}/`;
  if (!cwd.startsWith(prefix)) return undefined;
  const name = cwd.slice(prefix.length).split("/")[0] ?? "";
  return name === "" ? undefined : name;
}

/** The session's workspace when the cwd names one, else the first workspace. */
function defaultWorkspace(
  workspaces: readonly WorkspaceView[],
  cwd: string | undefined,
  projectsRoot: string,
): string | undefined {
  const fromCwd = projectNameFromCwd(cwd, projectsRoot);
  if (
    fromCwd !== undefined &&
    workspaces.some((workspace) => workspace.projectName === fromCwd)
  ) {
    return fromCwd;
  }
  return workspaces[0]?.projectName;
}

/** The workspace/container pickers shared by the body and the guide card. */
interface TerminalTargetFieldsProps {
  readonly workspaces: readonly WorkspaceView[];
  readonly containers: readonly ContainerView[];
  readonly workspace: string | undefined;
  readonly container: string | undefined;
  readonly disabled: boolean;
  readonly workspaceLabel: string;
  readonly containerLabel: string;
  readonly defaultLabel: string;
  readonly onWorkspace: (workspace: string) => void;
  readonly onContainer: (container: string) => void;
}

export function TerminalTargetFields(
  props: TerminalTargetFieldsProps,
): ReactNode {
  const selected = props.workspaces.find((workspace) => workspace.projectName === props.workspace);
  return (
    <>
      <select
        style={imageSelect}
        aria-label={props.workspaceLabel}
        value={props.workspace ?? ""}
        disabled={props.disabled || props.workspaces.length === 0}
        onChange={(event) => {
          props.onWorkspace(event.target.value);
        }}
      >
        {props.workspaces.length === 0 && <option value="">{props.workspaceLabel}</option>}
        {props.workspaces.map((workspace) => (
          <option key={workspace.projectName} value={workspace.projectName}>
            {workspace.projectName}
          </option>
        ))}
      </select>
      <select
        style={imageSelect}
        aria-label={props.containerLabel}
        value={props.container ?? ""}
        disabled={props.disabled || props.workspace === undefined}
        onChange={(event) => {
          props.onContainer(event.target.value);
        }}
      >
        <option value="">{props.defaultLabel}</option>
        {containerOptions(props.containers, selected?.workspaceSlug).map((name) => (
          <option key={name} value={name}>{name}</option>
        ))}
      </select>
    </>
  );
}

export function PodmanTerminal(props: PodmanTerminalProps): ReactNode {
  const { t, sessionId } = props;
  const info = props.useTabInfo();
  // The host keys retention by session + tab, so the composite keeps the two
  // unambiguous in one opaque query value.
  const tabId = `${sessionId}:${info.tab.id}`;
  const state = props.useContainerCard((snapshot) => snapshot);
  const params = info.tab.navigation.params as
    | PodmanTerminalParams
    | undefined;
  const useSession = props.useSession ?? noSession;
  const cwd = useSession((snapshot) => snapshot.header?.cwd);
  const [workspace, setWorkspace] = useState<string | undefined>(
    params?.workspace,
  );
  const [container, setContainer] = useState<string | undefined>(
    params?.container,
  );
  const [shell, setShell] = useState<string | undefined>(params?.shell);
  const [shells, setShells] = useState<ShellsState>({ phase: "loading" });
  const [status, setStatus] = useState<TerminalStatus>({ kind: "idle" });
  const [title, setTitle] = useState("");
  const [attempt, setAttempt] = useState(0);
  const node = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal>();
  const stream = useRef<AbortController>();
  const terminalId = useRef<string>();
  // False once the screen is torn down, so a late frame or an unmount cleanup
  // never touches a disposed emulator and an unmount never closes the shell.
  const alive = useRef(true);
  const reopen = useRef(false);

  // The card snapshot is the only source of workspaces/containers, and the
  // settings scope may not have loaded yet.
  useEffect(() => {
    props.reload();
  }, [props.reload]);

  // Default workspace: the session's when its cwd names one, else the first.
  useEffect(() => {
    if (workspace !== undefined || state.workspaces.length === 0) return;
    const next = defaultWorkspace(state.workspaces, cwd, state.projectsRoot);
    if (next !== undefined) setWorkspace(next);
  }, [workspace, cwd, state.workspaces, state.projectsRoot]);

  // Default container: the empty value means the workspace's default container
  // to the host. The workspace row carries that container's podman name, which
  // the orchestrator rejects, so it is never used as a target.
  useEffect(() => {
    if (workspace === undefined || container !== undefined) return;
    setContainer("");
  }, [workspace, container]);

  // The shells a container really offers; refetched whenever the target moves.
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
        setShell((previous) => previous ?? list[0]?.path);
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

  // The emulator outlives every connection; a reconnect reuses it.
  useLayoutEffect(() => {
    const element = node.current;
    if (element === null) return;
    alive.current = true;
    installXtermStyles();
    const term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      scrollback: 5000,
      theme: readTerminalTheme(),
    });
    const addon = new FitAddon();
    term.loadAddon(addon);
    term.open(element);
    terminal.current = term;
    const fit = (): void => {
      if (element.clientWidth === 0 || element.clientHeight === 0) return;
      try {
        addon.fit();
      } catch {
        // The element lost its box between measure and resize; the next
        // observer callback retries.
      }
    };
    fit();
    const input = term.onData((data) => {
      const id = terminalId.current;
      if (id === undefined) return;
      void sendTerminalControl({
        terminalId: id,
        kind: "input",
        data: bytesToBase64(TEXT_ENCODER.encode(data)),
      }).catch(() => {
        // A dead stream reports itself through a frame or the stream's error.
      });
    });
    const resize = term.onResize(({ cols, rows }) => {
      const id = terminalId.current;
      if (id === undefined) return;
      void sendTerminalControl({ terminalId: id, kind: "resize", cols, rows })
        .catch(() => {});
    });
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => {
      alive.current = false;
      stream.current?.abort();
      stream.current = undefined;
      observer.disconnect();
      input.dispose();
      resize.dispose();
      term.dispose();
      terminal.current = undefined;
    };
  }, []);

  // One attachment per target: a target change (or a reconnect) closes the old
  // shell, while an unmount only aborts and leaves the shell retained.
  useEffect(() => {
    const term = terminal.current;
    if (term === undefined) return;
    if (
      workspace === undefined || workspace === "" ||
      container === undefined ||
      shell === undefined || shell === ""
    ) {
      return;
    }
    const controller = new AbortController();
    stream.current = controller;
    const forceReopen = reopen.current;
    reopen.current = false;
    terminalId.current = undefined;
    term.reset();
    setStatus({ kind: "connecting" });
    const onFrame = (frame: TerminalFrame): void => {
      if (!alive.current) return;
      switch (frame.type) {
        case "ready":
          terminalId.current = frame.terminalId;
          if (frame.title !== "") setTitle(frame.title);
          setStatus({ kind: "running" });
          break;
        case "snapshot":
          term.write(frame.screen);
          break;
        case "data":
          term.write(base64ToBytes(frame.data));
          break;
        case "title":
          setTitle(frame.title);
          break;
        case "exit":
          terminalId.current = undefined;
          setStatus({ kind: "exited", code: frame.exitCode });
          break;
        case "error":
          setStatus({ kind: "error", message: frame.message });
          break;
        case "detached":
          setStatus({ kind: "detached" });
          break;
      }
    };
    void openTerminalStream(
      {
        sessionId,
        tabId,
        workspace,
        container,
        shell,
        cols: term.cols > 0 ? term.cols : 80,
        rows: term.rows > 0 ? term.rows : 24,
        ...(forceReopen ? { reopen: true } : {}),
      },
      onFrame,
      controller.signal,
    ).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      setStatus({
        kind: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }).finally(() => {
      if (stream.current === controller) stream.current = undefined;
    });
    return () => {
      controller.abort();
      if (stream.current === controller) stream.current = undefined;
      if (!alive.current) return;
      const id = terminalId.current;
      terminalId.current = undefined;
      if (id !== undefined) {
        void sendTerminalControl({ terminalId: id, kind: "close" }).catch(
          () => {
            // The shell may already be gone; reconnecting still works.
          },
        );
      }
    };
  }, [sessionId, tabId, workspace, container, shell, attempt]);

  // The terminal takes focus only while its tab is the visible one.
  useEffect(() => {
    if (info.tab.visible) terminal.current?.focus();
  }, [info.tab.visible]);

  const canConnect = workspace !== undefined && workspace !== "" &&
    shell !== undefined && shell !== "";
  const connect = (forceReopen: boolean): void => {
    const id = terminalId.current;
    stream.current?.abort();
    stream.current = undefined;
    terminalId.current = undefined;
    if (id !== undefined) {
      void sendTerminalControl({ terminalId: id, kind: "close" }).catch(
        () => {},
      );
    }
    terminal.current?.reset();
    reopen.current = forceReopen;
    setAttempt((value) => value + 1);
  };

  const shellList = shells.phase === "ready" ? shells.shells : [];
  let statusLabel: string | undefined;
  switch (status.kind) {
    case "connecting":
      statusLabel = t("terminalStatusConnecting");
      break;
    case "running":
      statusLabel = t("terminalStatusRunning");
      break;
    case "exited":
      statusLabel = t("terminalStatusExited", {
        code: status.code === null ? t("terminalNoExitCode") : String(status.code),
      });
      break;
    case "detached":
      statusLabel = t("terminalStatusDetached");
      break;
    case "error":
      statusLabel = status.message;
      break;
    case "idle":
      statusLabel = undefined;
      break;
  }
  const idle = status.kind === "idle";
  const ended = status.kind === "exited" || status.kind === "error";
  return (
    <section style={ROOT_STYLE} data-dsh-podman-terminal>
      <div style={TOOLBAR_STYLE}>
        <TerminalTargetFields
          workspaces={state.workspaces}
          containers={state.containers}
          workspace={workspace}
          container={container}
          disabled={state.workspaces.length === 0}
          workspaceLabel={t("terminalWorkspace")}
          containerLabel={t("terminalContainer")}
          defaultLabel={t("terminalDefaultContainer")}
          onWorkspace={(value) => {
            setWorkspace(value === "" ? undefined : value);
            setContainer(undefined);
            setShell(undefined);
          }}
          onContainer={(value) => {
            setContainer(value);
            setShell(undefined);
          }}
        />
        <select
          style={imageSelect}
          aria-label={t("terminalShell")}
          value={shell ?? ""}
          disabled={shells.phase !== "ready" || shellList.length === 0}
          onChange={(event) => {
            setShell(event.target.value);
          }}
        >
          {shellList.length === 0
            ? (
              <option value="">
                {shells.phase === "loading" ? t("terminalLoading") : t("terminalNoShells")}
              </option>
            )
            : shellList.map((entry) => (
              <option key={entry.path} value={entry.path}>{entry.name}</option>
            ))}
        </select>
        {(idle || ended) && (
          <Button
            variant="outline"
            size="sm"
            disabled={!canConnect}
            onClick={() => {
              connect(!idle);
            }}
          >
            {idle ? t("terminalConnect") : t("terminalReconnect")}
          </Button>
        )}
        {statusLabel === undefined
          ? null
          : <span style={STATUS_STYLE} role="status">{statusLabel}</span>}
        {title === "" ? null : <span style={TITLE_STYLE}>{title}</span>}
      </div>
      {state.workspaces.length === 0 && (
        <p style={ERROR_STYLE} role="status">
          {state.busy ? t("terminalLoading") : t("unavailable")}
        </p>
      )}
      {shells.phase === "failed" && (
        <p style={ERROR_STYLE} role="alert">
          {t("terminalShellsFailed", { message: shells.message })}
        </p>
      )}
      <div ref={node} className={XTERM_CLASS} style={SCREEN_STYLE} />
    </section>
  );
}

const ROOT_STYLE: React.CSSProperties = {
  display: "flex",
  flex: 1,
  flexDirection: "column",
  boxSizing: "border-box",
  height: "100%",
  minHeight: 0,
  color: "var(--dsw-alias-label-primary)",
  background: "var(--dsw-alias-bg-layer-2)",
  fontSize: "13px",
};

const TOOLBAR_STYLE: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  alignItems: "center",
  gap: "8px",
  padding: "6px 8px",
  borderBottom: "1px solid var(--dsw-alias-border-l2)",
};

const STATUS_STYLE: React.CSSProperties = {
  fontSize: "12px",
  color: "var(--dsw-alias-label-tertiary)",
};

const TITLE_STYLE: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: "hidden",
  whiteSpace: "nowrap",
  textOverflow: "ellipsis",
  fontSize: "12px",
  color: "var(--dsw-alias-label-secondary)",
};

const ERROR_STYLE: React.CSSProperties = {
  margin: 0,
  padding: "6px 10px",
  fontSize: "12px",
  color: "var(--dsw-alias-label-primary)",
  background: "var(--dsw-alias-bg-layer-3)",
};

const SCREEN_STYLE: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  minWidth: 0,
  overflow: "hidden",
};
