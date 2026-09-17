import {
  ACTIVATION_TITLE,
  ActivationChecklistHeader,
  ActivationChecklistItems,
  activationProgressText,
} from "~/components/activation-checklist-content.js";
import { useActivationChecklistValue } from "~/components/activation-checklist-provider.js";
import { focusMainContent } from "~/components/skip-navigation.js";

/**
 * Skippable User-level Activation Checklist as a Home card (ADR 0030, GH-273).
 * Never a route or write gate.
 *
 * Hidden at `lg` and above (issue #351): the desktop sidebar launcher is the wide
 * presentation, available on every authenticated route instead of only Home. Both
 * hosts render the same shared content, so items, CTAs, picker, and skip cannot drift.
 */
export function ActivationChecklist() {
  const checklist = useActivationChecklistValue();

  if (checklist === undefined || checklist.status !== "ready" || !checklist.visible) {
    return null;
  }

  return (
    <section
      aria-labelledby="activation-heading"
      className="rounded-xl border border-border bg-card p-4 shadow-sm sm:p-5 lg:hidden"
    >
      <ActivationChecklistHeader
        // Skip removes this whole section, taking the focused Skip button with it, so
        // hand keyboard users the main landmark instead of dropping them on <body> —
        // same handoff the sidebar launcher makes.
        onSkipped={focusMainContent}
        title={
          <h2
            id="activation-heading"
            className="font-display text-base font-semibold tracking-tight"
          >
            {ACTIVATION_TITLE}
          </h2>
        }
        progress={
          <p className="mt-0.5 text-sm text-muted-foreground">
            {activationProgressText(checklist)}
          </p>
        }
      />
      <ActivationChecklistItems checklist={checklist} className="mt-4" />
    </section>
  );
}
