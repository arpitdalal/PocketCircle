import { currentMonth } from "@pocketcircle/domain";
import { CheckIcon } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { Button } from "~/components/ui/button.js";
import { buttonVariants } from "~/components/ui/button-variants.js";
import { track } from "~/lib/analytics.js";
import { categoryNewHref } from "~/lib/categories-filter-url.js";
import { circlePath } from "~/lib/circle-path.js";
import {
  type Circle,
  type ReadyActivationChecklist,
  useActivationChecklist,
  useSkipActivationChecklist,
} from "~/lib/data.js";
import { transactionNewHref } from "~/lib/ledger-url.js";
import { useReturnToOrigin, withReturnTo } from "~/lib/return-to-url.js";
import { cn } from "~/lib/utils.js";

const ITEMS = [
  {
    id: "personalTransaction",
    title: "Record your first Transaction",
    hint: "You can create a Category while adding it.",
  },
  {
    id: "personalCategory",
    title: "Create a Category",
  },
  {
    id: "regularCircle",
    title: "Create a shared Circle",
  },
  {
    id: "sharedMember",
    title: "Add another Member",
  },
] as const;

function isComplete(checklist: ReadyActivationChecklist, id: (typeof ITEMS)[number]["id"]) {
  if (id === "personalTransaction") return checklist.personalTransactionComplete;
  if (id === "personalCategory") return checklist.personalCategoryComplete;
  if (id === "regularCircle") return checklist.regularCircleComplete;
  return checklist.sharedMemberState === "complete";
}

function MemberCta({ checklist, origin }: { checklist: ReadyActivationChecklist; origin: string }) {
  if (checklist.sharedMemberState === "complete") {
    return null;
  }
  if (checklist.sharedMemberState === "pending") {
    return <p className="text-sm text-muted-foreground">Invitation pending</p>;
  }
  const { memberCta } = checklist;
  if (memberCta.kind === "members") {
    return (
      <Link
        to={withReturnTo(circlePath(memberCta.circleRef, "members"), origin)}
        className={buttonVariants({ variant: "outline", size: "sm" })}
      >
        Invite a member
      </Link>
    );
  }
  if (memberCta.kind === "setup") {
    return (
      <Link
        to={withReturnTo(circlePath(memberCta.circleRef, "setup"), origin)}
        className={buttonVariants({ variant: "outline", size: "sm" })}
      >
        Finish setup
      </Link>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      <p className="text-sm text-muted-foreground">Create a shared Circle first.</p>
      <Link
        to={withReturnTo("/circles/new", origin)}
        className={buttonVariants({ variant: "outline", size: "sm" })}
      >
        Create circle
      </Link>
    </div>
  );
}

function ItemActions({
  id,
  checklist,
  circle,
  month,
  origin,
}: {
  id: (typeof ITEMS)[number]["id"];
  checklist: ReadyActivationChecklist;
  circle: Circle;
  month: string;
  origin: string;
}) {
  if (isComplete(checklist, id)) {
    return null;
  }
  if (id === "personalTransaction") {
    return (
      <div className="flex flex-wrap gap-2">
        <Link
          to={withReturnTo(transactionNewHref(circle, { type: "expense", month }), origin)}
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          Add expense
        </Link>
        <Link
          to={withReturnTo(transactionNewHref(circle, { type: "income", month }), origin)}
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          Add income
        </Link>
      </div>
    );
  }
  if (id === "personalCategory") {
    return (
      <Link
        to={withReturnTo(categoryNewHref(circle, { type: "expense" }), origin)}
        className={buttonVariants({ variant: "outline", size: "sm" })}
      >
        New category
      </Link>
    );
  }
  if (id === "regularCircle") {
    return (
      <Link
        to={withReturnTo("/circles/new", origin)}
        className={buttonVariants({ variant: "outline", size: "sm" })}
      >
        Create circle
      </Link>
    );
  }
  return <MemberCta checklist={checklist} origin={origin} />;
}

/**
 * Skippable User-level Activation Checklist (ADR 0030). Mounted only on the Personal
 * Circle Dashboard. Never a route or write gate. Skip persists then hides; it does
 * not fabricate completion.
 */
export function ActivationChecklist({ circle }: { circle: Circle }) {
  const origin = useReturnToOrigin();
  const month = currentMonth(new Date());
  const checklist = useActivationChecklist(true);
  const skipChecklist = useSkipActivationChecklist();
  const [skipError, setSkipError] = useState(false);
  const [skipping, setSkipping] = useState(false);

  if (checklist === undefined || checklist.status !== "ready" || !checklist.visible) {
    return null;
  }

  const onSkip = async () => {
    setSkipError(false);
    setSkipping(true);
    try {
      const result = await skipChecklist({});
      if (result.completedCount <= 3) {
        track("activation_checklist_skipped", { completedCount: result.completedCount });
      }
    } catch {
      setSkipError(true);
    } finally {
      setSkipping(false);
    }
  };

  return (
    <section
      aria-labelledby="activation-heading"
      className="rounded-xl border border-border bg-card p-4 shadow-sm sm:p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3
            id="activation-heading"
            className="font-display text-base font-semibold tracking-tight"
          >
            Get started
          </h3>
          <p className="mt-0.5 text-sm text-muted-foreground">
            {checklist.completedCount} of {checklist.total} complete
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={skipping}
          onClick={() => void onSkip()}
        >
          Skip onboarding
        </Button>
      </div>

      {skipError ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          Couldn’t skip onboarding. Try again.
        </p>
      ) : null}

      <ol className="mt-4 space-y-2">
        {ITEMS.map((item) => {
          const complete = isComplete(checklist, item.id);
          const current = checklist.firstIncomplete === item.id;
          return (
            <li
              key={item.id}
              aria-current={current ? "step" : undefined}
              className={cn(
                "rounded-lg border px-3 py-3",
                complete && "border-transparent bg-muted/40 text-muted-foreground",
                !complete && !current && "border-border bg-background",
                current && "border-ring bg-muted/20 ring-2 ring-ring/50",
              )}
            >
              <div className="flex items-start gap-2">
                {complete ? (
                  <CheckIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
                ) : (
                  <span
                    aria-hidden
                    className="mt-0.5 size-4 shrink-0 rounded-full border border-current"
                  />
                )}
                <div className="min-w-0 flex-1 space-y-2">
                  <p className="text-sm font-medium text-foreground">
                    {item.title}
                    {complete ? <span className="sr-only">, complete</span> : null}
                  </p>
                  {"hint" in item && !complete ? (
                    <p className="text-sm text-muted-foreground">{item.hint}</p>
                  ) : null}
                  <ItemActions
                    id={item.id}
                    checklist={checklist}
                    circle={circle}
                    month={month}
                    origin={origin}
                  />
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
