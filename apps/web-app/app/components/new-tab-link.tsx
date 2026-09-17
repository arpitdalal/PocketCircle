import { ExternalLink } from "lucide-react";

/**
 * The app's one new-tab link contract (issue #351). `target="_blank"` already implies
 * `noopener` in every current engine, so `rel` here is defence in depth against an older
 * one handing the opened document a `window.opener` handle back into the app (reverse
 * tabnabbing). `noreferrer` also strips the `Referer` header, so the archive is attributed
 * as direct traffic rather than as a click from inside the app.
 *
 * Used wherever authenticated UI opens the public `/whats-new` archive, so the User's
 * current task survives closing it.
 */
export const NEW_TAB_LINK_PROPS = {
  target: "_blank",
  rel: "noopener noreferrer",
} as const;

/**
 * Visible icon plus spoken cue for a {@link NEW_TAB_LINK_PROPS} link. WCAG 3.2.5: a
 * new browsing context must be announced, and `target` alone announces nothing.
 */
export function NewTabCue() {
  return (
    <>
      <ExternalLink aria-hidden className="size-3.5 shrink-0" />
      {/* Leading comma so the cue reads as an aside rather than part of the label.
          Accessible-name computation joins sibling text with a space, so real engines
          compute "What's new , opens in a new tab" — a screen reader renders either
          spelling as the same pause. Tests match the name whitespace-tolerantly because
          jsdom's implementation joins without that space. */}
      <span className="sr-only">, opens in a new tab</span>
    </>
  );
}
