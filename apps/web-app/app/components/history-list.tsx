import { formatMoney, money, toCurrencyCode } from "@pocketcircle/domain";
import { Button } from "~/components/ui/button.js";
import type { PaginationStatus } from "~/lib/data.js";
import { formatAuditTimestamp } from "~/lib/datetime.js";
import { viewerLocale } from "~/lib/locale.js";

/**
 * The structural shape of one immutable history event the list renders — the common
 * contract every entity History shares (Transaction History now, Category/Circle History
 * when they land). Deliberately structural (not tied to one derived view type) so the
 * shared component renders any of them: `TransactionHistoryEvent` is assignable to it,
 * and a future `CategoryHistoryEvent` of the same shape will be too. Values are already
 * frozen display-safe (ADR 0018/0021): text fields use `from`/`to`, money fields carry
 * typed `{minorUnits, currency}` — and NEVER a raw id (PRD story 80).
 */
export interface HistoryChangeLike {
  field: string;
  from?: string;
  to?: string;
  fromMoney?: { minorUnits: number; currency: string };
  toMoney?: { minorUnits: number; currency: string };
}
export interface HistoryEventLike {
  id: string;
  action: string;
  createdAt: number;
  actor: { displayName: string; image?: string } | null;
  changes: ReadonlyArray<HistoryChangeLike>;
}

/** Human labels for the audited fields (CONTEXT glossary terms). A field absent here
 * falls back to its raw key — safe, and a signal a new audited field needs a label. */
const FIELD_LABEL: Record<string, string> = {
  type: "Type",
  title: "Title",
  amount: "Amount",
  date: "Date",
  note: "Note",
  paidBy: "Paid By",
  categories: "Categories",
  // Category History fields (CAT-2).
  name: "Name",
  color: "Color",
  // Circle Settings fields (CS-2).
  currency: "Currency",
  // Circle History fields (CS-4).
  owner: "Owner",
  member: "Member",
  email: "Email",
  "setup.purpose": "Circle use",
  "setup.residenceType": "Residence type",
};

/** Human labels for the event verbs recorded by `recordEvent`. */
const ACTION_LABEL: Record<string, string> = {
  created: "created",
  edited: "edited",
  "type changed": "changed the type of",
  archived: "archived",
  restored: "restored",
  settings_changed: "updated settings",
  setup_completed: "completed setup",
  // Circle History verbs (CS-4).
  renamed: "renamed",
  "ownership transferred": "transferred ownership",
  "member invited": "invited",
  "member joined": "joined",
  "member removed": "removed",
  "member deleted": "deleted account",
  "member left": "left",
  "invitation resent": "resent invitation to",
  "invitation revoked": "revoked invitation for",
};

/** Renders one frozen value — a typed money value in the viewer locale (ADR 0021), or a
 * plain display string. `undefined` is the absent side of a change (e.g. a cleared Note
 * or a created event's missing `from`), shown as an em dash. */
function HistoryValue({
  text,
  amount,
}: {
  text: string | undefined;
  amount: { minorUnits: number; currency: string } | undefined;
}) {
  if (amount) {
    return (
      <span className="tabular-nums">
        {formatMoney(money(amount.minorUnits, toCurrencyCode(amount.currency)), viewerLocale())}
      </span>
    );
  }
  if (text == null || text === "") {
    return <span className="text-muted-foreground">—</span>;
  }
  return <span>{text}</span>;
}

/** One change line: the field label and its old → new values. A created event records
 * only a `to` (no `from`), so the arrow is shown only when a prior value exists. */
function HistoryChangeRow({ change }: { change: HistoryChangeLike }) {
  const hasFrom = change.from !== undefined || change.fromMoney !== undefined;
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 text-sm">
      <span className="text-muted-foreground">{FIELD_LABEL[change.field] ?? change.field}:</span>
      {hasFrom ? (
        <>
          <HistoryValue text={change.from} amount={change.fromMoney} />
          <span aria-hidden className="text-faint">
            →
          </span>
        </>
      ) : null}
      <HistoryValue text={change.to} amount={change.toMoney} />
    </li>
  );
}

/**
 * The shared, immutable change-history list for an entity detail surface (TXN-4; reused by
 * Category/Circle History when those views land). Renders events NEWEST-FIRST as the query
 * returns them, each headed by the acting Member's Display Name, the action verb, and the
 * stored timestamp (rendered in a fixed reference zone, never the viewer's — Audit Metadata
 * glossary), followed by its per-field old → new changes. Money renders in the viewer
 * locale from the frozen typed value; no raw IDs ever appear because the writers never
 * stored them.
 *
 * Handles all read states (README §4): a loading first page, an empty history, the
 * populated list, and a "Load more" control while the paginated query has more — so an
 * arbitrarily long audit never loads in one shot.
 */
export function HistoryList({
  events,
  status,
  loadMore,
  label = "History",
}: {
  events: HistoryEventLike[];
  status: PaginationStatus;
  loadMore: () => void;
  label?: string;
}) {
  return (
    <section aria-label={label} className="space-y-3">
      <h3 className="text-sm font-semibold">{label}</h3>
      {status === "LoadingFirstPage" ? (
        <p className="text-sm text-muted-foreground">Loading history…</p>
      ) : events.length === 0 ? (
        <p className="text-sm text-muted-foreground">No history yet.</p>
      ) : (
        <>
          <ol className="space-y-3">
            {events.map((event) => (
              <li key={event.id} className="rounded-lg border border-border bg-card p-3 shadow-sm">
                <p className="text-sm">
                  <span className="font-medium">{event.actor?.displayName ?? "System"}</span>{" "}
                  <span className="text-muted-foreground">
                    {ACTION_LABEL[event.action] ?? event.action}
                  </span>{" "}
                  <span className="text-muted-foreground">
                    ·{" "}
                    <time dateTime={new Date(event.createdAt).toISOString()}>
                      {formatAuditTimestamp(event.createdAt)}
                    </time>
                  </span>
                </p>
                {event.changes.length > 0 ? (
                  <ul className="mt-2 space-y-1">
                    {event.changes.map((change) => (
                      <HistoryChangeRow key={change.field} change={change} />
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ol>

          {status === "CanLoadMore" || status === "LoadingMore" ? (
            <Button
              type="button"
              variant="outline"
              onClick={loadMore}
              disabled={status === "LoadingMore"}
            >
              {status === "LoadingMore" ? "Loading…" : "Load more"}
            </Button>
          ) : null}
        </>
      )}
    </section>
  );
}
