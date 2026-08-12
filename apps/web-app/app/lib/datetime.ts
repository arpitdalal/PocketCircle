import { type PlainMonth, plainMonthParts } from "@pocketcircle/domain";
import { viewerLocale } from "./locale.js";

/**
 * "YYYY-MM" months are plain calendar buckets with no timezone (domain/date.ts), so
 * they are labelled by formatting their first day pinned to UTC — a local-zone Date
 * would let a negative offset slide the label into the previous month. The viewer
 * locale drives the month name's language (ADR 0021: explicit locale, never ambient).
 * Parsing goes through the domain's `plainMonthParts` (no tuple casts); a malformed
 * month surfaces as Intl's "Invalid Date" label rather than a wrong month.
 */
const monthLabelFormatter = new Intl.DateTimeFormat(viewerLocale(), {
  timeZone: "UTC",
  month: "long",
  year: "numeric",
});
const monthTickFormatter = new Intl.DateTimeFormat(viewerLocale(), {
  timeZone: "UTC",
  month: "short",
});

function formatUtcMonth(month: PlainMonth, formatter: Intl.DateTimeFormat) {
  const { year, month: monthIndex } = plainMonthParts(month);
  return formatter.format(new Date(Date.UTC(year, monthIndex - 1, 1)));
}

/** Full month label, e.g. "June 2026" — list headings, table rows, tooltips. */
export function formatMonthLabel(month: PlainMonth) {
  return formatUtcMonth(month, monthLabelFormatter);
}

/** Compact month label, e.g. "Jun" — chart axis ticks where space is tight. */
export function formatMonthTick(month: PlainMonth) {
  return formatUtcMonth(month, monthTickFormatter);
}

/**
 * Formats an Audit Metadata / Transaction History timestamp (TXN-4).
 *
 * Audit timestamps are stored as epoch millis — an absolute instant with NO captured
 * offset (domain/date.ts: operational timestamps are epoch millis). The Audit Metadata
 * glossary requires they display with their stored offset and explicitly NOT converted
 * to the viewer's timezone. With no offset stored, the faithful behavior is to render in
 * a single FIXED reference zone (UTC) for every viewer, so the displayed wall-clock never
 * shifts with the reader's location — the `timeZone: "UTC"` below pins it, and the
 * `timeZoneName` makes the zone explicit so the value is never mistaken for local time.
 *
 * (A true per-write offset would need a schema change to capture it at write time, which
 * is out of scope for this read-only detail slice and would require an ADR to reshape the
 * audited tables — see the PR notes. Until then UTC is the honest, deterministic choice.)
 *
 * The viewer LOCALE still applies — it only governs language/format of the parts (month
 * name, digit grouping), never the zone — mirroring the explicit-locale rule money
 * formatting follows (ADR 0021); a non-browser context falls back to a fixed locale.
 */
const auditTimestampFormatter = new Intl.DateTimeFormat(viewerLocale(), {
  timeZone: "UTC",
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZoneName: "short",
});

export function formatAuditTimestamp(epochMillis: number): string {
  return auditTimestampFormatter.format(new Date(epochMillis));
}
