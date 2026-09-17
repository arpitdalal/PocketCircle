import { CheckIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { Button } from "~/components/ui/button.js";
import { buttonVariants } from "~/components/ui/button-variants.js";
import { ModalDialog } from "~/components/ui/dialog.js";
import { track } from "~/lib/analytics.js";
import { categoryNewHref } from "~/lib/categories-filter-url.js";
import { circlePath } from "~/lib/circle-path.js";
import { type ReadyActivationChecklist, useSkipActivationChecklist } from "~/lib/data.js";
import { globalAddHref } from "~/lib/global-add-url.js";
import { useReturnToOrigin, withReturnTo } from "~/lib/return-to-url.js";
import { cn } from "~/lib/utils.js";

/**
 * Presentation of the skippable User-level Activation Checklist (ADR 0030, GH-273),
 * shared by the Home card (`activation-checklist.tsx`, below `lg`) and the desktop
 * sidebar flyout (`activation-checklist-launcher.tsx`, `lg` and above) so item rules,
 * CTAs, return-to URLs, skip behavior, and the Circle picker exist once (issue #351).
 *
 * Hosts supply their own heading/progress nodes — a labelled `<section>` on Home, the
 * popover's `Title` / `Description` in the flyout — and an optional `onActivate` the
 * flyout uses to close itself the moment an action starts navigating or hands off to
 * the modal Circle picker.
 */

export const ACTIVATION_TITLE = "Get started";

export function activationProgressText(checklist: ReadyActivationChecklist) {
  return `${checklist.completedCount} of ${checklist.total} complete`;
}

const ITEMS = [
  {
    id: "transaction",
    title: "Record your first Transaction",
    hint: "You can create a Category while adding it.",
  },
  {
    id: "category",
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

/**
 * Invitation rows stay `pending` after expiresAt; Convex will not re-run the
 * checklist query on the wall clock alone. Local timer flips pending → invite CTA.
 */
function usePendingInvitationActive(expiresAt: number | null) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (expiresAt === null) {
      return;
    }
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) {
      return;
    }
    const timer = window.setTimeout(() => setNow(Date.now()), remaining);
    return () => window.clearTimeout(timer);
  }, [expiresAt]);

  return expiresAt !== null && expiresAt > now;
}

function sharedMemberStateForUi(checklist: ReadyActivationChecklist, pendingActive: boolean) {
  if (checklist.sharedMemberState === "complete") {
    return "complete" as const;
  }
  if (checklist.sharedMemberState === "pending" && pendingActive) {
    return "pending" as const;
  }
  return "not_started" as const;
}

function isComplete(
  checklist: ReadyActivationChecklist,
  id: (typeof ITEMS)[number]["id"],
  pendingActive: boolean,
) {
  if (id === "transaction") return checklist.transactionComplete;
  if (id === "category") return checklist.categoryComplete;
  if (id === "regularCircle") return checklist.regularCircleComplete;
  return sharedMemberStateForUi(checklist, pendingActive) === "complete";
}

/** Every checklist CTA is the same outline link that may close a hosting flyout. */
function ctaLinkProps(to: string, onActivate: (() => void) | undefined) {
  return {
    to,
    onClick: onActivate,
    className: buttonVariants({ variant: "outline", size: "sm" }),
  };
}

function CreateCircleFallback({ origin, onActivate }: { origin: string; onActivate?: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <p className="text-sm text-muted-foreground">Create a Circle or finish setup first.</p>
      <Link {...ctaLinkProps(withReturnTo("/circles/new", origin), onActivate)}>Create circle</Link>
    </div>
  );
}

function MemberCta({
  checklist,
  origin,
  pendingActive,
  onActivate,
}: {
  checklist: ReadyActivationChecklist;
  origin: string;
  pendingActive: boolean;
  onActivate?: () => void;
}) {
  const sharedMemberState = sharedMemberStateForUi(checklist, pendingActive);
  if (sharedMemberState === "complete") {
    return null;
  }
  if (sharedMemberState === "pending") {
    return <p className="text-sm text-muted-foreground">Invitation pending</p>;
  }
  const { memberCta } = checklist;
  if (memberCta.kind === "members") {
    return (
      <Link
        {...ctaLinkProps(
          withReturnTo(circlePath(memberCta.circleRef, "members"), origin),
          onActivate,
        )}
      >
        Invite a member
      </Link>
    );
  }
  if (memberCta.kind === "setup") {
    return (
      <Link
        {...ctaLinkProps(
          withReturnTo(circlePath(memberCta.circleRef, "setup"), origin),
          onActivate,
        )}
      >
        Finish setup
      </Link>
    );
  }
  return <p className="text-sm text-muted-foreground">Create a shared Circle first.</p>;
}

function ItemActions({
  id,
  checklist,
  origin,
  pendingActive,
  onPickCategoryCircle,
  onActivate,
}: {
  id: (typeof ITEMS)[number]["id"];
  checklist: ReadyActivationChecklist;
  origin: string;
  pendingActive: boolean;
  onPickCategoryCircle: () => void;
  onActivate?: () => void;
}) {
  if (isComplete(checklist, id, pendingActive)) {
    return null;
  }
  if (id === "transaction") {
    if (checklist.eligibleCircles.length === 0) {
      return <CreateCircleFallback origin={origin} onActivate={onActivate} />;
    }
    // Global Add (issue #298): the Type rides in the URL, no Circle is
    // preselected, and the EXACT origin is retained as returnTo.
    return (
      <div className="flex flex-wrap gap-2">
        <Link
          {...ctaLinkProps(withReturnTo(globalAddHref({ type: "expense" }), origin), onActivate)}
        >
          Add expense
        </Link>
        <Link
          {...ctaLinkProps(withReturnTo(globalAddHref({ type: "income" }), origin), onActivate)}
        >
          Add income
        </Link>
      </div>
    );
  }
  if (id === "category") {
    const eligible = checklist.eligibleCircles;
    const firstEligible = eligible[0];
    if (eligible.length === 0) {
      return <CreateCircleFallback origin={origin} onActivate={onActivate} />;
    }
    if (eligible.length === 1 && firstEligible) {
      return (
        <Link
          {...ctaLinkProps(
            withReturnTo(categoryNewHref(firstEligible, { type: "expense" }), origin),
            onActivate,
          )}
        >
          New category
        </Link>
      );
    }
    return (
      <Button type="button" variant="outline" size="sm" onClick={onPickCategoryCircle}>
        New category
      </Button>
    );
  }
  if (id === "regularCircle") {
    return (
      <Link {...ctaLinkProps(withReturnTo("/circles/new", origin), onActivate)}>Create circle</Link>
    );
  }
  return (
    <MemberCta
      checklist={checklist}
      origin={origin}
      pendingActive={pendingActive}
      onActivate={onActivate}
    />
  );
}

function CirclePickerDialog({
  open,
  onOpenChange,
  eligibleCircles,
  origin,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  eligibleCircles: ReadyActivationChecklist["eligibleCircles"];
  origin: string;
}) {
  const navigate = useNavigate();

  const title = "Choose a Circle for the category";

  function handleSelect(circle: ReadyActivationChecklist["eligibleCircles"][number]) {
    const target = withReturnTo(categoryNewHref(circle, { type: "expense" }), origin);
    onOpenChange(false);
    navigate(target);
  }

  return (
    <ModalDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description="Select a Circle to continue."
    >
      <ul className="space-y-1">
        {eligibleCircles.map((circle) => (
          <li key={circle.id}>
            <button
              type="button"
              className="w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => handleSelect(circle)}
            >
              <span className="font-medium">{circle.name}</span>
              <span className="ml-2 text-muted-foreground">{circle.currency}</span>
            </button>
          </li>
        ))}
      </ul>
    </ModalDialog>
  );
}

/**
 * Heading row + Skip action + skip error. `title` and `progress` are supplied by the
 * host so each surface keeps its own semantics; this owns only the layout and the
 * skip mutation. Skip persists then hides through the reactive query — it never
 * fabricates completion.
 *
 * `onSkipped` fires once the skip has persisted, before the reactive query removes the
 * host: a host whose Skip button lives inside a surface it is about to destroy uses it to
 * put focus somewhere that will still exist.
 */
export function ActivationChecklistHeader({
  title,
  progress,
  onSkipped,
}: {
  title: ReactNode;
  progress: ReactNode;
  onSkipped?: () => void;
}) {
  const skipChecklist = useSkipActivationChecklist();
  const [skipError, setSkipError] = useState(false);
  const [skipping, setSkipping] = useState(false);

  const onSkip = async () => {
    setSkipError(false);
    setSkipping(true);
    try {
      const result = await skipChecklist({});
      if (result.claimed && result.completedCount <= 3) {
        track("activation_checklist_skipped", { completedCount: result.completedCount });
      }
      onSkipped?.();
    } catch {
      setSkipError(true);
    } finally {
      setSkipping(false);
    }
  };

  return (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          {title}
          {progress}
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
          Couldn't skip onboarding. Try again.
        </p>
      ) : null}
    </>
  );
}

/**
 * The ordered checklist items with their current-step semantics, hints, and CTAs,
 * plus the eligible-Circle picker the Category action falls back to. `onActivate`
 * fires whenever an action starts a route navigation or opens that picker, so a
 * hosting flyout can close first.
 */
export function ActivationChecklistItems({
  checklist,
  onActivate,
  className,
}: {
  checklist: ReadyActivationChecklist;
  onActivate?: () => void;
  className?: string;
}) {
  const origin = useReturnToOrigin();
  const [pickerOpen, setPickerOpen] = useState(false);
  const pendingActive = usePendingInvitationActive(checklist.pendingInvitationExpiresAt);

  return (
    <>
      <ol className={cn("space-y-2", className)}>
        {ITEMS.map((item) => {
          const complete = isComplete(checklist, item.id, pendingActive);
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
                    origin={origin}
                    pendingActive={pendingActive}
                    onActivate={onActivate}
                    onPickCategoryCircle={() => {
                      onActivate?.();
                      setPickerOpen(true);
                    }}
                  />
                </div>
              </div>
            </li>
          );
        })}
      </ol>

      <CirclePickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        eligibleCircles={checklist.eligibleCircles}
        origin={origin}
      />
    </>
  );
}
