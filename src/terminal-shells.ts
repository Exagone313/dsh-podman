// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// Shell discovery inside one container. The candidate list carries names only:
// where a shell lives is answered by the container's own PATH (including the
// deployment's PATH additions), /etc/shells, and $SHELL, so a shell installed
// anywhere the container can see it is found without hardcoded locations.

import { fsError, runExec } from "./guest-rpc.js";
import { type TerminalShellView } from "./client/terminal-protocol.js";
import { type WorkspaceBinding } from "./workspace-binding.js";

// Names looked up on the container's PATH, ordered most capable first so the
// picker offers — and preselects — the best shell the container has. The first
// five mirror the harness's own candidate order; the minimal POSIX shells come
// last, with `sh` final because /bin/sh is usually a symlink to one of them.
export const SHELL_CANDIDATES = [
  "zsh",
  "bash",
  "fish",
  "pwsh",
  "powershell",
  "nu",
  "ksh",
  "mksh",
  "dash",
  "ash",
  "sh",
] as const;

// POSIX `command -v`, not bash's `type -P`: the probe must not require a shell
// it is still looking for, and it runs under /bin/sh in every image we build.
const PROBE_SCRIPT = [
  'for name in "$@"; do',
  '  path=$(command -v -- "$name" 2>/dev/null) || continue',
  '  case $path in /*) [ -x "$path" ] && printf "%s\\t%s\\n" "$name" "$path" ;; esac',
  "done",
  'for candidate in "$SHELL"; do',
  '  case $candidate in /*) [ -x "$candidate" ] && printf "%s\\t%s\\n" "${candidate##*/}" "$candidate" ;; esac',
  "done",
  "if [ -f /etc/shells ]; then",
  "  while IFS= read -r candidate; do",
  '    case $candidate in ""|\#*) continue ;; esac',
  '    case $candidate in /*) [ -x "$candidate" ] && printf "%s\\t%s\\n" "${candidate##*/}" "$candidate" ;; esac',
  "  done < /etc/shells",
  "fi",
].join("\n");

const PROBE_TIMEOUT_MS = 10_000;
const PROBE_MAX_BYTES = 64 * 1024;

// One ordered list drives both the probe and the result order, so the two can
// never disagree.
const SHELL_RANK = new Map<string, number>(
  SHELL_CANDIDATES.map((name, index) => [name, index]),
);

function rank(name: string): number {
  return SHELL_RANK.get(name) ?? SHELL_CANDIDATES.length;
}

/**
 * Discover the shells one container really provides.
 * @param binding - guest connection for the target container.
 * @param cwd - an absolute path already mounted in that container.
 * @param signal - cancellation of the probe.
 * @returns each shell's requested name and resolved absolute path, most capable first.
 */
export async function discoverShells(
  binding: WorkspaceBinding,
  cwd: string,
  signal?: AbortSignal,
): Promise<TerminalShellView[]> {
  const result = await runExec(
    binding,
    ["/bin/sh", "-c", PROBE_SCRIPT, "sh", ...SHELL_CANDIDATES],
    cwd,
    undefined,
    PROBE_TIMEOUT_MS,
    undefined,
    { signal, maxBytes: PROBE_MAX_BYTES },
  );
  // The probe prints PATH hits first, then $SHELL and /etc/shells, so keeping
  // the first path per candidate name prefers the PATH answer and drops both
  // symlinked duplicates (/bin/sh vs /usr/bin/sh) and anything /etc/shells
  // lists that is not one of our candidate names (rbash, git-shell, …).
  const candidates = new Set<string>(SHELL_CANDIDATES);
  const byName = new Map<string, string>();
  for (const line of result.stdout.split("\n")) {
    const [rawName, rawPath] = line.split("\t");
    const name = (rawName ?? "").trim();
    const path = (rawPath ?? "").trim();
    if (name === "" || !path.startsWith("/")) continue;
    if (!candidates.has(name)) continue;
    if (!byName.has(name)) byName.set(name, path);
  }
  return [...byName]
    .map(([name, path]) => ({ name, path }))
    .sort((left, right) =>
      rank(left.name) - rank(right.name) ||
      left.name.localeCompare(right.name)
    );
}

/**
 * Require one shell to still exist in the container, so a client cannot ask for
 * an arbitrary executable and a shell that vanished since the picker loaded is
 * refused instead of spawned.
 * @param binding - guest connection for the target container.
 * @param cwd - an absolute path already mounted in that container.
 * @param path - the absolute shell path the client selected.
 * @param signal - cancellation of the probe.
 * @returns the verified shell.
 */
export async function requireShell(
  binding: WorkspaceBinding,
  cwd: string,
  path: string,
  signal?: AbortSignal,
): Promise<TerminalShellView> {
  const shells = await discoverShells(binding, cwd, signal);
  const match = shells.find((shell) => shell.path === path);
  if (match === undefined) {
    throw fsError(
      "FS_IO_ERROR",
      `shell ${JSON.stringify(path)} is not available in this container`,
    );
  }
  return match;
}
