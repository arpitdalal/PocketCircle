import { SPEND_CIRCLE_SUPPORT_EMAIL } from "@spend-circle/domain";
import type { ReactNode } from "react";
import { href, Link } from "react-router";

export function LegalDocument({
  title,
  summary,
  effectiveDate,
  children,
}: {
  title: string;
  summary: string;
  effectiveDate: string;
  children: ReactNode;
}) {
  return (
    <article className="space-y-8 rounded-xl border border-border bg-card/60 p-6 text-sm leading-6 text-muted-foreground shadow-xl backdrop-blur-sm sm:p-8">
      <header className="space-y-3 border-b border-border pb-6">
        <p className="text-xs font-medium uppercase tracking-[0.16em] text-primary">
          Effective {effectiveDate}
        </p>
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
            href={`mailto:${SPEND_CIRCLE_SUPPORT_EMAIL}`}
            className="font-medium text-primary underline underline-offset-4"
          >
            {SPEND_CIRCLE_SUPPORT_EMAIL}
          </a>
          .
        </p>
        <Link
          to={href("/signin")}
          className="inline-block font-medium text-primary underline underline-offset-4"
        >
          Back to sign in
        </Link>
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
