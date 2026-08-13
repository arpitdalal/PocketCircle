import { LIMITS, parseProfileUpdate } from "@pocketcircle/domain";
import { type FormEvent, useState } from "react";
import { href, Link, Navigate } from "react-router";
import { Splash } from "~/components/splash.js";
import { Button } from "~/components/ui/button.js";
import { Field, FieldError, FieldLabel } from "~/components/ui/field.js";
import { Input } from "~/components/ui/input.js";
import { useCompleteOnboarding } from "~/lib/data.js";
import { useAppSession } from "~/lib/session.js";

/**
 * `/onboarding` serves two gated states (ADR 0017, USR-1):
 *  - bootstrap: Google session exists but the PocketCircle User row has not
 *    propagated yet → brief splash while the auth trigger runs.
 *  - product onboarding: the User exists but has not confirmed their profile →
 *    the confirm/edit Display Name form.
 */
export default function OnboardingRoute() {
  const session = useAppSession();

  if (session.state === "loading") {
    return <Splash />;
  }
  if (session.state === "bootstrap") {
    return <Splash label="Setting up your account…" />;
  }
  if (session.state !== "ready") {
    return <Navigate to="/signin" replace />;
  }
  if (session.user.onboardingComplete) {
    return <Navigate to="/" replace />;
  }
  return <OnboardingForm user={session.user} />;
}

function OnboardingForm({ user }: { user: { email: string; displayName: string } }) {
  const completeOnboarding = useCompleteOnboarding();
  // react-doctor-disable-next-line react-doctor/no-derived-useState -- editable form field seeded ONCE from the prop; the box is then user-owned. Onboarding shows for a single user whose displayName can't change underneath the open form, so there's no stale-prop case to re-sync.
  const [displayName, setDisplayName] = useState(user.displayName);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const parsed = parseProfileUpdate({ displayName });
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }

    setSubmitting(true);
    try {
      await completeOnboarding({ displayName: parsed.value.displayName });
    } catch (caught) {
      console.error("completeOnboarding failed", caught);
      setError("Couldn't finish setup. Please try again.");
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-[60dvh] max-w-md flex-col justify-center space-y-6 px-4 py-8">
      <div className="space-y-2 text-center">
        <h1 className="font-display text-2xl font-semibold tracking-tight">Welcome</h1>
        <p className="text-sm text-muted-foreground">
          Confirm how your name appears in Circles before you get started.
        </p>
      </div>

      <form
        onSubmit={onSubmit}
        className="space-y-5 rounded-xl border border-border bg-card p-5 shadow-sm"
      >
        <Field>
          <FieldLabel htmlFor="onboarding-display-name">Display name</FieldLabel>
          <Input
            id="onboarding-display-name"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            maxLength={LIMITS.displayNameMax}
            autoComplete="name"
            required
          />
        </Field>

        <Field>
          <FieldLabel htmlFor="onboarding-email">Google account email</FieldLabel>
          <Input id="onboarding-email" value={user.email} readOnly className="opacity-80" />
        </Field>

        {error ? <FieldError>{error}</FieldError> : null}

        <p className="text-sm text-muted-foreground">
          PocketCircle collects limited feature-usage analytics to improve the product. Transaction
          amounts, titles, notes, names, and other free text are never included. You can opt out
          anytime in Settings → Privacy.{" "}
          <Link
            to={href("/privacy")}
            className="underline underline-offset-2 transition-colors hover:text-foreground"
          >
            Privacy Policy
          </Link>
        </p>

        <Button type="submit" className="w-full" disabled={submitting}>
          {submitting ? "Continuing…" : "Continue"}
        </Button>
      </form>
    </div>
  );
}
