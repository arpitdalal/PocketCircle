import {
  FEEDBACK_TYPES,
  type FeedbackType,
  isFeedbackType,
  LIMITS,
  parseFeedbackInput,
} from "@pocketcircle/domain";
import { type FormEvent, useState } from "react";
import { Link } from "react-router";
import { Button } from "~/components/ui/button.js";
import { Field, FieldDescription, FieldLabel } from "~/components/ui/field.js";
import { Textarea } from "~/components/ui/textarea.js";
import { track } from "~/lib/analytics.js";
import { type Circle, useSubmitFeedback } from "~/lib/data.js";
import { mutationErrorMessageForUser } from "~/lib/mutation-user-message.js";
import type { SessionUser } from "~/lib/session.js";
import { useSnackbar } from "~/lib/snackbar.js";

const FEEDBACK_TYPE_LABELS: Record<FeedbackType, string> = {
  bug: "Bug",
  feature: "Feature request",
  currency: "Currency request",
};

const TITLE_CLASS = {
  1: "font-display text-2xl font-semibold tracking-tight",
  2: "font-display text-lg font-semibold tracking-tight",
} as const;

/**
 * Focused Feedback surface shared by `/feedback` and `/circles/:circleRef/feedback`.
 * Circle display context is optional; only the resolved internal `circleId` is
 * submitted when present. Routes own `returnTo` validation and pass `backTo`.
 */
export function FeedbackPage({
  user,
  backTo,
  circle,
  headingLevel = 1,
}: {
  user: SessionUser;
  backTo: string;
  circle?: { id: Circle["id"]; name: string };
  headingLevel?: 1 | 2;
}) {
  const Title = headingLevel === 1 ? "h1" : "h2";
  const submitFeedback = useSubmitFeedback();
  const { show } = useSnackbar();
  const [type, setType] = useState<FeedbackType>("bug");
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const trimmedMessage = message.trim();
  const canSubmit = trimmedMessage.length > 0 && !submitting;
  const remaining = LIMITS.feedbackMessageMax - message.length;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const parsed = parseFeedbackInput({ type, message });
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }

    setSubmitting(true);
    try {
      await submitFeedback({
        type: parsed.value.type,
        message: parsed.value.message,
        appVersion: __APP_VERSION__,
        ...(circle ? { circleId: circle.id } : {}),
      });
      track("feedback_submitted", { type: parsed.value.type });
      setMessage("");
      show("Thanks — your feedback was sent.");
    } catch (caught) {
      console.error("submitFeedback failed", caught);
      setError(
        mutationErrorMessageForUser(caught, "Couldn't send your feedback. Please try again."),
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <div className="space-y-3">
        <Link to={backTo} className="text-sm text-muted-foreground hover:text-foreground">
          ‹ Back
        </Link>
        <Title className={TITLE_CLASS[headingLevel]}>Send feedback</Title>
      </div>

      <form
        onSubmit={onSubmit}
        className="space-y-4 rounded-xl border border-border bg-card p-5 shadow-sm"
      >
        <Field>
          <FieldLabel htmlFor="feedback-type">Type</FieldLabel>
          <select
            id="feedback-type"
            value={type}
            onChange={(event) => {
              const next = event.target.value;
              if (isFeedbackType(next)) {
                setType(next);
              }
            }}
            className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm shadow-sm outline-none transition-[border-color,box-shadow] duration-150 focus:border-ring focus:ring-2 focus:ring-ring/30"
          >
            {FEEDBACK_TYPES.map((option) => (
              <option key={option} value={option}>
                {FEEDBACK_TYPE_LABELS[option]}
              </option>
            ))}
          </select>
        </Field>

        <Field>
          <FieldLabel htmlFor="feedback-message">Message</FieldLabel>
          <Textarea
            id="feedback-message"
            value={message}
            onChange={(event) => setMessage(event.target.value)}
            maxLength={LIMITS.feedbackMessageMax}
            rows={5}
            required
          />
          <FieldDescription>{remaining} characters remaining</FieldDescription>
        </Field>

        <div className="space-y-1 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          <p>
            <span className="font-medium text-foreground">From:</span> {user.displayName} (
            {user.email})
          </p>
          <p>
            <span className="font-medium text-foreground">App version:</span> {__APP_VERSION__}
          </p>
          <p>
            <span className="font-medium text-foreground">Circle context:</span>{" "}
            {circle?.name ?? "None"}
          </p>
        </div>

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <Button type="submit" disabled={!canSubmit}>
          {submitting ? "Sending…" : "Send feedback"}
        </Button>
      </form>
    </div>
  );
}
