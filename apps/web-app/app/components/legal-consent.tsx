import { APEX_ORIGIN } from "@pocketcircle/domain";

/**
 * The sentence every surface that starts a sign-in carries, and the two policies
 * it points at.
 *
 * Both links name the apex in full. The policies are the marketing Site's
 * documents and this is the product app, ADR 0035 moves the app to its own
 * subdomain, and a relative `/terms` would resolve against whichever origin served
 * the page — which is right here only until the cutover and wrong on the app's own
 * copy of this sentence afterwards. Naming the origin is the decision, and there
 * are two sign-in surfaces that have to make it, so it is made here once.
 */
export function LegalConsent() {
  return (
    <p className="text-xs text-muted-foreground">
      By continuing you agree to our{" "}
      <a
        href={`${APEX_ORIGIN}/terms`}
        className="underline underline-offset-2 transition-colors hover:text-foreground"
      >
        Terms
      </a>{" "}
      and{" "}
      <a
        href={`${APEX_ORIGIN}/privacy`}
        className="underline underline-offset-2 transition-colors hover:text-foreground"
      >
        Privacy Policy
      </a>
      .
    </p>
  );
}
