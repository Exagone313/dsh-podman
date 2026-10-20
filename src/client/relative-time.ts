// SPDX-FileCopyrightText: 2026 Elouan Martinet <exa@elou.world>
//
// SPDX-License-Identifier: MIT

// A relative creation time in the reader's own language. The exact instant
// stays available beside it — a container field copies it, a build time keeps
// it as a title tooltip — so this never has to be precise: it names the moment
// the way a person would ("5 seconds ago", "5 minutes ago", "yesterday").

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

// Constructing a formatter is the expensive part, so the ones already built are
// kept per locale. A locale the runtime refuses falls back to its default,
// which is also what an empty locale asks for.
const formatters = new Map<string, Intl.RelativeTimeFormat>();

function formatter(locale: string): Intl.RelativeTimeFormat | undefined {
  const cached = formatters.get(locale);
  if (cached !== undefined) return cached;
  let created: Intl.RelativeTimeFormat | undefined;
  try {
    created = new Intl.RelativeTimeFormat(locale === "" ? undefined : locale, {
      numeric: "auto",
    });
  } catch {
    try {
      created = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
    } catch {
      // A runtime without Intl.RelativeTimeFormat at all: the caller shows the
      // raw timestamp rather than a guessed label.
      created = undefined;
    }
  }
  if (created !== undefined) formatters.set(locale, created);
  return created;
}

/**
 * The relative creation time of a container, e.g. "1 second ago", "5 minutes
 * ago" or "yesterday". A stamp the browser cannot read, and a runtime without
 * {@link Intl.RelativeTimeFormat}, both fall back to the raw value.
 *
 * @param createdAt - the container's timestamp, as the snapshot reported it.
 * @param locale - the plugin's active locale; "" asks for the runtime default.
 * @param now - the current instant, injected for pure rendering.
 */
export function relativeTimeLabel(
  createdAt: string,
  locale: string,
  now: number = Date.now(),
): string {
  const at = Date.parse(createdAt);
  if (Number.isNaN(at)) return createdAt;
  const format = formatter(locale);
  if (format === undefined) return createdAt;
  // A clock ahead of this browser must not read as a future creation.
  const elapsed = Math.max(0, now - at);
  // A moment ago is counted in seconds, so a fresh creation reads "1 second
  // ago" rather than "today"; the exact instant still sits beside it.
  if (elapsed < MINUTE) {
    return format.format(-Math.max(1, Math.floor(elapsed / 1000)), "second");
  }
  if (elapsed < HOUR) {
    return format.format(-Math.floor(elapsed / MINUTE), "minute");
  }
  if (elapsed < DAY) return format.format(-Math.floor(elapsed / HOUR), "hour");
  if (elapsed < MONTH) return format.format(-Math.floor(elapsed / DAY), "day");
  if (elapsed < YEAR) {
    return format.format(-Math.floor(elapsed / MONTH), "month");
  }
  return format.format(-Math.floor(elapsed / YEAR), "year");
}
