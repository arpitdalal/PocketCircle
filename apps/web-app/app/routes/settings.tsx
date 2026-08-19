import { LIMITS, parseProfileUpdate } from "@pocketcircle/domain";
import { type FormEvent, useState } from "react";
import { href, Link } from "react-router";
import { Button } from "~/components/ui/button.js";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "~/components/ui/field.js";
import { Input } from "~/components/ui/input.js";
import { Switch } from "~/components/ui/switch.js";
import {
  revertPendingAnalyticsEnabled,
  setAnalyticsEnabled as setClientAnalyticsEnabled,
} from "~/lib/analytics.js";
import { requestAccountDeletion } from "~/lib/auth-client.js";
import {
  type AccountDeletionBlocker,
  useAccountDeletionBlockers,
  useSetAnalyticsEnabled,
  useUpdateProfile,
} from "~/lib/data.js";
import { mutationErrorMessageForUser } from "~/lib/mutation-user-message.js";
import { type SessionUser, useAppSession } from "~/lib/session.js";
import { useSnackbar } from "~/lib/snackbar.js";

/** Exact confirmation phrase for Account Deletion (USR-3); case-sensitive UI friction. */
const DELETE_ACCOUNT_PHRASE = "DELETE MY ACCOUNT";

/** Settings shell. App Version aids support diagnosis (PRD story 90); Privacy hosts
 * the product-analytics opt-out (ADR 0013). */
export default function Settings() {
  const session = useAppSession();

  if (session.state !== "ready") {
    return null;
  }

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <h1 className="font-display text-2xl font-semibold tracking-tight">Settings</h1>

      <section className="space-y-4">
        <h2 className="text-sm font-medium text-muted-foreground">Profile</h2>
        <ProfileSettingsForm key={session.user.id} user={session.user} />
      </section>

      <section className="space-y-4">
        <h2 className="text-sm font-medium text-muted-foreground">Privacy</h2>
        <PrivacySettingsForm
          key={`privacy-${session.user.id}-${String(session.user.analyticsEnabled)}`}
          user={session.user}
        />
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-medium text-muted-foreground">About</h2>
        <p className="text-sm text-muted-foreground">
          <Link to="/whats-new" className="underline-offset-4 hover:underline">
            App version {__APP_VERSION__}
          </Link>
        </p>
      </section>

      <section className="space-y-4">
        <h2 className="text-sm font-medium text-muted-foreground">Danger zone</h2>
        <DangerZoneCard />
      </section>
    </div>
  );
}

function blockerLink(blocker: AccountDeletionBlocker) {
  if (blocker.action === "transfer") {
    return {
      to: href("/circles/:circleRef/members", { circleRef: blocker.ref }),
      label: `Transfer ownership of ${blocker.name}`,
    };
  }
  return {
    to: href("/circles/:circleRef/settings", { circleRef: blocker.ref }),
    label: `Archive ${blocker.name}`,
  };
}

function DangerZoneCard() {
  const { blockers, status, loadMore } = useAccountDeletionBlockers();
  const [phrase, setPhrase] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [emailSent, setEmailSent] = useState(false);

  if (status === "LoadingFirstPage") {
    return (
      <div className="space-y-4 rounded-xl border border-destructive/30 bg-card p-5 shadow-sm">
        <p className="text-sm text-muted-foreground">
          Checking whether your account can be deleted…
        </p>
      </div>
    );
  }

  if (blockers.length > 0) {
    return (
      <div className="space-y-4 rounded-xl border border-destructive/30 bg-card p-5 shadow-sm">
        <div className="space-y-1">
          <h3 className="text-sm font-medium">Delete account</h3>
          <p className="text-sm text-muted-foreground">
            Resolve these Circles before you can delete your account.
          </p>
        </div>
        <ul className="space-y-2">
          {blockers.map((blocker) => {
            const link = blockerLink(blocker);
            return (
              <li key={blocker.circleId}>
                <Link
                  to={link.to}
                  className="text-sm font-medium text-primary underline-offset-4 hover:underline"
                >
                  {link.label}
                </Link>
              </li>
            );
          })}
        </ul>
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
      </div>
    );
  }

  if (emailSent) {
    return (
      <div className="space-y-4 rounded-xl border border-destructive/30 bg-card p-5 shadow-sm">
        <div className="space-y-1">
          <h3 className="text-sm font-medium">Delete account</h3>
          <p className="text-sm text-muted-foreground">
            Check your email for a link to confirm account deletion. Your account stays usable until
            you open that link.
          </p>
        </div>
      </div>
    );
  }

  const phraseMatches = phrase === DELETE_ACCOUNT_PHRASE;
  const canSubmit = phraseMatches && !submitting;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) {
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await requestAccountDeletion();
      setEmailSent(true);
    } catch (caught) {
      setError(
        mutationErrorMessageForUser(caught, "Couldn't start account deletion. Please try again."),
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-4 rounded-xl border border-destructive/30 bg-card p-5 shadow-sm"
    >
      <div className="space-y-1">
        <h3 className="text-sm font-medium">Delete account</h3>
        <p className="text-sm text-muted-foreground">
          Permanently deletes your login and profile. Circle history for other Members is kept. This
          cannot be undone.
        </p>
      </div>

      {/* Account Export belongs in this Danger zone once designed; omit the panel until then. */}
      <Field>
        <FieldLabel htmlFor="settings-delete-phrase">
          Type {DELETE_ACCOUNT_PHRASE} to confirm
        </FieldLabel>
        <Input
          id="settings-delete-phrase"
          value={phrase}
          onChange={(event) => setPhrase(event.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
        <FieldDescription>Must match exactly, including capitalization.</FieldDescription>
      </Field>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <Button type="submit" variant="destructive" disabled={!canSubmit}>
        {submitting ? "Sending…" : "Delete my account"}
      </Button>
    </form>
  );
}

function ProfileSettingsForm({ user }: { user: SessionUser }) {
  const updateProfile = useUpdateProfile();
  const { show } = useSnackbar();
  // react-doctor-disable-next-line react-doctor/no-derived-useState -- editable form field seeded ONCE from the prop; reset-on-user-change is already handled by `key={session.user.id}` at the call site (line 27), which remounts this form so useState re-initializes.
  const [displayName, setDisplayName] = useState(user.displayName);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const trimmedDisplayName = displayName.trim();
  const canSave = trimmedDisplayName.length > 0 && !submitting;

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
      await updateProfile({ displayName: parsed.value.displayName });
      show("Profile updated.");
    } catch (caught) {
      console.error("updateProfile failed", caught);
      setError("Couldn't update your profile. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      className="space-y-4 rounded-xl border border-border bg-card p-5 shadow-sm"
    >
      <Field>
        <FieldLabel htmlFor="settings-display-name">Display name</FieldLabel>
        <Input
          id="settings-display-name"
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          maxLength={LIMITS.displayNameMax}
          autoComplete="name"
          required
        />
      </Field>

      <Field>
        <FieldLabel htmlFor="settings-email">Google account email</FieldLabel>
        <Input id="settings-email" value={user.email} readOnly className="opacity-80" />
      </Field>

      {error ? <FieldError>{error}</FieldError> : null}

      <Button type="submit" disabled={!canSave}>
        {submitting ? "Saving…" : "Save profile"}
      </Button>
    </form>
  );
}

function PrivacySettingsForm({ user }: { user: SessionUser }) {
  const setAnalyticsEnabled = useSetAnalyticsEnabled();
  const { show } = useSnackbar();
  const [enabled, setEnabled] = useState(user.analyticsEnabled);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onToggle(nextEnabled: boolean) {
    if (submitting) {
      return;
    }

    setError(null);
    setEnabled(nextEnabled);
    setClientAnalyticsEnabled(nextEnabled);
    setSubmitting(true);
    try {
      await setAnalyticsEnabled({ enabled: nextEnabled });
      show("Privacy preference updated.");
    } catch (caught) {
      console.error("setAnalyticsEnabled failed", caught);
      setEnabled(user.analyticsEnabled);
      revertPendingAnalyticsEnabled(user.analyticsEnabled);
      setError("Couldn't update your privacy preference. Please try again.");
    }
    setSubmitting(false);
  }

  return (
    <div className="space-y-4 rounded-xl border border-border bg-card p-5 shadow-sm">
      <Field orientation="horizontal">
        <Switch
          id="settings-analytics-enabled"
          checked={enabled}
          disabled={submitting}
          aria-labelledby="settings-analytics-enabled-label"
          onClick={() => void onToggle(!enabled)}
        />
        <FieldContent>
          <FieldLabel id="settings-analytics-enabled-label" htmlFor="settings-analytics-enabled">
            Share product analytics
          </FieldLabel>
          <FieldDescription>
            On by default for new accounts. PocketCircle shares only coarse feature-usage events
            with PostHog—not transaction amounts, titles, notes, names, or other free text. Turn
            this off anytime. Operational error monitoring (Sentry) stays on regardless.
          </FieldDescription>
        </FieldContent>
      </Field>

      {error ? <FieldError>{error}</FieldError> : null}
    </div>
  );
}
