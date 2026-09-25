// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// The browser-facing terminal routes. They are served below the harness API
// path, so the carrier applies its Host/Origin fence and browser authentication
// before any handler runs; the handlers themselves only speak the terminal
// protocol declared in client/terminal-protocol.ts.

import {
  TERMINAL_PATH,
  TERMINAL_RETAINED_PATH,
  TERMINAL_SHELLS_PATH,
  type TerminalControl,
  type TerminalFrame,
  type TerminalOpenQuery,
} from "./client/terminal-protocol.js";
import { discoverShells } from "./terminal-shells.js";
import { type TerminalSessions } from "./terminal-sessions.js";
import { type WorkspaceResolver } from "./workspace-binding.js";

const MIN_COLS = 2;
const MAX_COLS = 500;
const MIN_ROWS = 1;
const MAX_ROWS = 200;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function integer(raw: string | null, min: number, max: number): number | undefined {
  if (raw === null || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) return undefined;
  return value;
}

// The workspace's mirrored path under the projects root, or the session's own
// working directory when the request names no workspace.
function workspaceCwd(
  ctx: any,
  workspaceRegistry: any,
  projectsRoot: string,
  projectName: string,
  sessionId: string,
): string | undefined {
  const list = workspaceRegistry?.list?.() ?? [];
  if (projectName !== "") {
    for (const workspace of list) {
      const path = String(workspace.path ?? "");
      const name = path.startsWith(`${projectsRoot}/`) ? path.slice(projectsRoot.length + 1) : path;
      if (name === projectName) return path;
    }
    return undefined;
  }
  const cwd = ctx?.get?.("sessions")?.get?.(sessionId)?.header?.cwd;
  return typeof cwd === "string" && cwd !== "" ? cwd : undefined;
}

function controlOf(body: any): TerminalControl | undefined {
  if (typeof body?.terminalId !== "string" || body.terminalId === "") return undefined;
  const terminalId = body.terminalId;
  switch (body.kind) {
    case "input":
      return typeof body.data === "string"
        ? { terminalId, kind: "input", data: body.data }
        : undefined;
    case "resize": {
      const cols = integer(String(body.cols ?? ""), MIN_COLS, MAX_COLS);
      const rows = integer(String(body.rows ?? ""), MIN_ROWS, MAX_ROWS);
      return cols === undefined || rows === undefined
        ? undefined
        : { terminalId, kind: "resize", cols, rows };
    }
    case "rename":
      return typeof body.title === "string" && body.title.trim() !== ""
        ? { terminalId, kind: "rename", title: body.title.trim().slice(0, 120) }
        : undefined;
    case "close":
      return { terminalId, kind: "close" };
    default:
      return undefined;
  }
}

async function bindingFor(
  resolver: WorkspaceResolver,
  cwd: string,
  container: string,
  signal: AbortSignal,
) {
  return container === "" || container === "default"
    ? await resolver.resolveForPath(cwd, cwd, signal)
    : await resolver.containerBinding(cwd, container, signal);
}

async function handleOpen(
  request: Request,
  ctx: any,
  resolver: WorkspaceResolver,
  sessions: TerminalSessions,
  workspaceRegistry: any,
): Promise<Response> {
  const url = new URL(request.url);
  let options: TerminalOpenQuery & { cwd: string; reopen: boolean; signal: AbortSignal };
  try {
    const sessionId = url.searchParams.get("sessionId") ?? "";
    const tabId = url.searchParams.get("tabId") ?? "";
    const workspace = url.searchParams.get("workspace") ?? "";
    const container = url.searchParams.get("container") ?? "";
    const shell = url.searchParams.get("shell") ?? "";
    const cols = integer(url.searchParams.get("cols"), MIN_COLS, MAX_COLS);
    const rows = integer(url.searchParams.get("rows"), MIN_ROWS, MAX_ROWS);
    if (sessionId === "" || tabId === "" || shell === "" || !shell.startsWith("/")) {
      throw new Error("sessionId, tabId and an absolute shell are required");
    }
    if (cols === undefined || rows === undefined) {
      throw new Error(`cols must be ${MIN_COLS}..${MAX_COLS} and rows ${MIN_ROWS}..${MAX_ROWS}`);
    }
    const cwd = workspaceCwd(
      ctx,
      workspaceRegistry,
      resolver.getConfig().projectsRoot,
      workspace,
      sessionId,
    );
    if (cwd === undefined) {
      throw new Error(`unknown workspace ${JSON.stringify(workspace)}`);
    }
    options = {
      sessionId,
      tabId,
      workspace,
      cwd,
      container,
      shell,
      cols,
      rows,
      reopen: url.searchParams.get("reopen") === "1",
      signal: request.signal,
    };
  } catch (error) {
    return json(400, { error: message(error) });
  }
  let prepared;
  try {
    prepared = await sessions.prepare(options);
  } catch (error) {
    return json(400, { error: message(error) });
  }
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (frame: TerminalFrame): void => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
        } catch {
          // The consumer is gone; the request signal releases the attachment.
        }
      };
      const detach = sessions.listen(
        prepared.terminalId,
        write,
        request.signal,
        prepared.snapshot,
      );
      request.signal.addEventListener("abort", () => {
        detach();
        try {
          controller.close();
        } catch {
          // Already closed by the consumer.
        }
      }, { once: true });
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "application/x-ndjson",
      "cache-control": "no-store",
    },
  });
}

async function handleControl(
  request: Request,
  sessions: TerminalSessions,
): Promise<Response> {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return json(400, { error: "invalid terminal control" });
  }
  const control = controlOf(body);
  if (control === undefined) return json(400, { error: "unknown terminal control" });
  return sessions.control(control)
    ? json(200, { ok: true })
    : json(404, { error: "unknown terminal" });
}

async function handleShells(
  request: Request,
  ctx: any,
  resolver: WorkspaceResolver,
  workspaceRegistry: any,
): Promise<Response> {
  const url = new URL(request.url);
  const workspace = url.searchParams.get("workspace") ?? "";
  const container = url.searchParams.get("container") ?? "";
  const sessionId = url.searchParams.get("sessionId") ?? "";
  const cwd = workspaceCwd(
    ctx,
    workspaceRegistry,
    resolver.getConfig().projectsRoot,
    workspace,
    sessionId,
  );
  if (cwd === undefined) {
    return json(400, { error: `unknown workspace ${JSON.stringify(workspace)}` });
  }
  try {
    const binding = await bindingFor(resolver, cwd, container, request.signal);
    return json(200, { shells: await discoverShells(binding, cwd, request.signal) });
  } catch (error) {
    return json(502, { error: message(error) });
  }
}

function handleRetained(request: Request, sessions: TerminalSessions): Response {
  const sessionId = new URL(request.url).searchParams.get("sessionId") ?? "";
  if (sessionId === "") return json(400, { error: "sessionId is required" });
  return json(200, { terminals: sessions.retained(sessionId) });
}

/**
 * Register the terminal routes on the connection service.
 * @param ctx - plugin host context carrying the connection service.
 * @param resolver - workspace/container resolver.
 * @param sessions - live terminal registry.
 * @param workspaceRegistry - the harness workspace registry, when present.
 */
export function registerTerminalRoutes(
  ctx: any,
  resolver: WorkspaceResolver,
  sessions: TerminalSessions,
  workspaceRegistry?: any,
): void {
  ctx.inject(["connection"], (connectionCtx: any) => {
    connectionCtx.connection.fetch.register({
      path: TERMINAL_PATH,
      methods: ["GET", "POST"],
      requestBody: "buffered",
      fetch: (request: Request) =>
        request.method === "POST"
          ? handleControl(request, sessions)
          : handleOpen(request, ctx, resolver, sessions, workspaceRegistry),
    });
    connectionCtx.connection.fetch.register({
      path: TERMINAL_SHELLS_PATH,
      methods: ["GET"],
      requestBody: "buffered",
      fetch: (request: Request) => handleShells(request, ctx, resolver, workspaceRegistry),
    });
    connectionCtx.connection.fetch.register({
      path: TERMINAL_RETAINED_PATH,
      methods: ["GET"],
      requestBody: "buffered",
      fetch: (request: Request) => handleRetained(request, sessions),
    });
  });
}
