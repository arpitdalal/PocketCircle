import { APP_ORIGIN, POCKETCIRCLE_LEGAL_EMAIL } from "@pocketcircle/domain";
import type { ReactNode } from "react";

/**
 * The chrome around a long-form public document: the effective date, the summary,
 * and the way back into the product.
 *
 * Both destinations are named in full rather than resolved against the origin
 * this component happens to be served from. The legal mailbox is derived from the
 * apex host and sign-in belongs to the app origin, and ADR 0035 moves the app to
 * its own subdomain — at which point a relative `/signin` here would resolve
 * against the app and be right by accident, while a relative one on the apex's own
 * copy of this document would not. Writing the origin is the decision; this is
 * where it is made once, for every document the product still renders.
 *
 * These components stay because the apex is still the app until the cutover
 * (#410, #411), and a cited `/privacy` has to keep resolving throughout. The
 * marketing Site publishes its own copy of the same documents at the same paths
 * (`apps/site/*.html`), and `routes/legal-documents.test.tsx` is what holds the two
 * to the same copy.
 */
export function LegalDocument({
  title,
  summary,
  effectiveDate,
  dateLabel = "Effective",
  children,
}: {
  title: string;
  summary: string;
  effectiveDate?: string;
  dateLabel?: string;
  children: ReactNode;
}) {
  return (
    <article className="space-y-8 rounded-xl border border-border bg-card/60 p-6 text-sm leading-6 text-muted-foreground shadow-xl backdrop-blur-sm sm:p-8">
      <header className="space-y-3 border-b border-border pb-6">
        {effectiveDate ? (
          <p className="text-xs font-medium uppercase tracking-[0.16em] text-primary">
            {dateLabel} {effectiveDate}
          </p>
        ) : null}
        <h1 className="font-display text-3xl font-semibold tracking-tight text-foreground">
          {title}
        </h1>
        <p>{summary}</p>
      </header>

      <div className="space-y-8">{children}</div>

      <footer className="space-y-3 border-t border-border pt-6">
        <p>
          Questions? Email{" "}
          <a
            href={`mailto:${POCKETCIRCLE_LEGAL_EMAIL}`}
            className="font-medium text-primary underline underline-offset-4"
          >
            {POCKETCIRCLE_LEGAL_EMAIL}
          </a>
          .
        </p>
        <a
          href={`${APP_ORIGIN}/signin`}
          className="inline-block font-medium text-primary underline underline-offset-4"
        >
          Back to sign in
        </a>
      </footer>
    </article>
  );
}

export function LegalSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="font-display text-xl font-semibold tracking-tight text-foreground">{title}</h2>
      {children}
    </section>
  );
}

export function LegalList({ children }: { children: ReactNode }) {
  return <ul className="list-disc space-y-2 pl-5 marker:text-primary">{children}</ul>;
}
