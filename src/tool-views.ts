// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

import { TOOL_UI } from "./tool-schemas.js";

// The command tools render as terminal cards; every other tool gets a generic
// card with its UI title. Views are recomputed on each delivery and never
// persisted (see the harness tool-presentation contract).
export function toolCallView(name: string, args: any): unknown {
  if (name === "container_bash" || name === "container_exec") {
    const command =
      name === "container_bash"
        ? String(args?.command ?? "")
        : Array.isArray(args?.argv)
          ? args.argv.map((item: unknown) => String(item)).join(" ")
          : "";
    return {
      card: "terminal",
      title: command,
      ...(typeof args?.description === "string" && args.description !== ""
        ? { description: args.description }
        : {}),
    };
  }
  const ui = TOOL_UI[name];
  if (ui === undefined) return undefined;
  return { card: "generic", title: ui.title, kind: ui.kind };
}

export function toolResultView(
  name: string,
  _args: any,
  result: any,
): unknown {
  if (result?.isError) return undefined;
  if (name !== "container_bash" && name !== "container_exec") return undefined;
  const text = (result?.content ?? [])
    .filter((block: any) => block?.type === "text")
    .map((block: any) => block.text)
    .join("");
  let data: any;
  try {
    data = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (data === null || typeof data !== "object") return undefined;
  const output = [data.stdout, data.stderr]
    .filter((value: unknown) => typeof value === "string" && value !== "")
    .join("");
  return {
    card: "terminal",
    output,
    ...(data.signal
      ? { signal: String(data.signal) }
      : { exitCode: Number(data.exitCode ?? 0) }),
  };
}
