#!/bin/sh
# SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
#
# SPDX-License-Identifier: MIT

# Exit 0 when dsh is idle (safe to restart for an update) and non-zero while a
# session has an open turn.
set -u

home="${DSH_HOME:-${HOME:-/root}/.dsh}"
cache="$home/storages/session_projcache/sessions"
sessions="$home/sessions"

[ -d "$cache" ] || exit 0

busy=0
for lock in "$sessions"/*/*/session.lock; do
  [ -e "$lock" ] || continue
  row="$cache/$(basename "$(dirname "$lock")").json"
  [ -f "$row" ] || continue
  # A numeric openTurnStartSeq marks an open turn (null when none). The flock
  # proves the writer is alive, so a stale row left by a crash is not busy.
  grep -Eq '"openTurnStartSeq"[[:space:]]*:[[:space:]]*[0-9]' "$row" || continue
  if [ -z "$(command -v flock)" ] || ! flock -n "$lock" true 2>/dev/null; then
    busy=1
    break
  fi
done

# The projection cache is throttled, so a turn that just started may not be
# recorded yet; recent session-log activity covers that gap.
if [ "$busy" -eq 0 ]; then
  find "$sessions" -type f -name 'session.v*.jsonl*' -mmin -1 2>/dev/null | grep -q . && busy=1
fi

[ "$busy" -eq 0 ]
