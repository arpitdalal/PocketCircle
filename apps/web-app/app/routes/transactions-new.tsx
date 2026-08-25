import { buildRef, currentMonth, type TransactionType } from "@pocketcircle/domain";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { Splash } from "~/components/splash.js";
import {
  TransactionFormBody,
  type TransactionFormResult,
} from "~/components/transaction-form/index.js";
import { useTransactionForm } from "~/components/transaction-form/use-transaction-form.js";
import { buttonVariants } from "~/components/ui/button-variants.js";
import { ModalDialog } from "~/components/ui/dialog.js";
import { Segmented } from "~/components/ui/segmented.js";
import { type Circle, useMyCircles } from "~/lib/data.js";
import {
  destinationInvalidation,
  isDestinationInvalidationError,
  isEligibleDestination,
  requiresCircleSwitchConfirmation,
  requiresTypeChangeConfirmation,
  SWITCH_RESTORED_TOAST,
} from "~/lib/global-add-transitions.js";
import {
  canonicalGlobalAddUrl,
  parseGlobalAddParams,
  readGlobalAddParams,
} from "~/lib/global-add-url.js";
import { transactionDetailHref } from "~/lib/ledger-url.js";
import { withReturnTo } from "~/lib/return-to-url.js";
import { useSnackbar } from "~/lib/snackbar.js";

/** Aggregate-safe analytics context for every ordinary Global Add create (#298). */
const GLOBAL_ADD_ANALYTICS = { surface: "global", method: "manual" } as const;

const TYPE_OPTIONS: { label: string; value: TransactionType }[] = [
  { label: "Expense", value: "expense" },
  { label: "Income", value: "income" },
];

/**
 * Global Add — the protected top-level `/transactions/new` route (issue #298).
 * An ordinary Transaction can start anywhere: Home's persistent action and the
 * Activation Checklist land here with their exact origin as `returnTo`, pick
 * Circle + Type in Step 1, then fill the SHARED Transaction form (Step 2). The
 * Circle-scoped create route keeps its fixed Circle and navigation contract;
 * only this page owns global URL state (issue #290).
 *
 * URL ownership: `type`, `circle`, and `returnTo` live in the query,
 * canonicalized with replace navigation. Draft fields live ONLY in form
 * memory; the form mounts once per page visit and never remounts on URL
 * changes — portable values survive, scoped values reset per the decided
 * contract.
 *
 * Reconciliation model (React Compiler-friendly): the URL is the REQUEST.
 * `appliedId` is what the form currently uses, settled during render — the
 * sanctioned adjust-state-during-render pattern — whenever the request is
 * resolvable AND either needs no confirmation or matches an acceptance in the
 * `confirmed` ledger. A data-loss-prone request therefore raises its dialog by
 * pure derivation; accepting is an event, cancelling restores the applied URL.
 * Effects synchronize only external systems: router URL canonicalization, the
 * shared controller's field mutations on transition edges, toasts, and
 * focus/scroll — no setState in any effect body.
 */
export default function TransactionsNew() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const circles = useMyCircles();
  const { show, showUnavailable } = useSnackbar();

  const urlState = useMemo(
    () => parseGlobalAddParams(readGlobalAddParams(searchParams)),
    [searchParams],
  );
  const returnUrl = urlState.returnTo;
  const eligibleCircles = useMemo(() => (circles ?? []).filter(isEligibleDestination), [circles]);

  // --- Session state -------------------------------------------------------
  // What the form currently uses: initialized from the deep-linked context,
  // settled toward the request during render (see below).
  const [appliedId, setAppliedId] = useState<string | null>(() => urlState.circleId);
  /** Whether a VALID destination has applied at least once this visit. Once
   * true it stays true: reactive invalidation must keep the body (with its
   * field warnings) on screen, and Back-to-bare keeps the draft visible.
   * Reload restarts — the URL owns context, never drafts. */
  const [everSelected, setEverSelected] = useState(false);
  /** Acceptance ledger for confirmed data-loss-prone requests (event-time only). */
  const [confirmed, setConfirmed] = useState<{ key: string; draft: string } | null>(null);
  /** Leaving via Cancel/success so the Splash covers the navigation. */
  const [closing, setClosing] = useState<"cancel" | "success" | null>(null);

  const appliedCircle: Circle | null =
    circles !== undefined && appliedId !== null
      ? (circles.find((circle) => circle.id === appliedId) ?? null)
      : null;
  const appliedEligible = appliedCircle !== null && isEligibleDestination(appliedCircle);

  // Success opens the new canonical Circle-scoped Transaction Detail with THIS
  // page's validated origin as its return state — REPLACING the dead create
  // URL so browser Back restores the original origin exactly (issue #290).
  const completeCreation = useCallback(
    (result: TransactionFormResult) => {
      if (!appliedCircle || result.kind !== "created") {
        return;
      }
      setClosing("success");
      navigate(
        withReturnTo(
          transactionDetailHref(appliedCircle, {
            ref: buildRef(result.submitted.title, result.transactionId),
          }),
          returnUrl,
        ),
        { replace: true },
      );
    },
    [appliedCircle, returnUrl, navigate],
  );

  // Ref bridge so the shared controller's submit-failure escape hatch can call
  // the destination-invalidation contract — assigned in an effect (not during
  // render) for the React Compiler refs rule.
  const invalidateDestinationRef = useRef<() => void>(() => {});
  /** Blocks render-phase settlement from re-applying a Circle while an
   * invalidation's URL rewrite is still in flight (submit-time: the list may
   * still show the Circle as eligible even though the mutation rejected it). */
  const [invalidating, setInvalidating] = useState(false);
  // Destination-edge cursor — declared early so invalidateDestination and the
  // edge effect share one bookkeeping cell.
  const lastEdgeRef = useRef<{ id: string | null; currency: string | null } | null>(null);

  // --- Shared form controller: mounted unconditionally for the whole visit.
  // Reads skip while no valid destination resolves; the body renders only once
  // a destination context exists (`showBody`). ---
  const controller = useTransactionForm({
    kind: "create",
    type: urlState.type,
    selectedMonth: currentMonth(new Date()),
    analytics: GLOBAL_ADD_ANALYTICS,
    circle: appliedEligible ? appliedCircle : null,
    onComplete: completeCreation,
    // Submit-time twin of the reactive invalidation edge below: the backend
    // rejected the DESTINATION itself (archived / Setup-incomplete / access
    // lost), so apply the exact same reset contract and suppress the generic
    // inline error. Any other failure keeps the draft and stays inline.
    onSubmitFailure: (error) => {
      if (!isDestinationInvalidationError(error)) {
        return false;
      }
      invalidateDestinationRef.current();
      return true;
    },
  });

  // The Circle-scoped draft as of THIS render, read synchronously from the
  // shared form store. Confirmation GATING reads it during render, and every
  // gating decision happens on a navigation-driven render — after the typed
  // edits that raised it have committed to the store — so a live snapshot is
  // exactly what the contract needs; reactive re-rendering of these values is
  // the body's job, not the gate's.

  // --- Request reconciliation (pure derivation + sanctioned render-phase
  // settlement). The URL is the request; appliedId follows it only when the
  // transition is resolvable and either needs no confirmation or was accepted
  // through the dialog. ---
  const requestedId = urlState.circleId;
  const requestedMatch =
    circles === undefined || requestedId === null
      ? undefined
      : (circles.find((circle) => circle.id === requestedId) ?? null);
  const requestedResolvable =
    !urlState.hadUnparseableCircle &&
    (requestedId === null ||
      (requestedMatch !== undefined &&
        requestedMatch !== null &&
        isEligibleDestination(requestedMatch)));

  const storeValues = controller.form.store.state.values;
  const scopedDraft = {
    amount: storeValues.amount,
    categoryIds: storeValues.categoryIds,
    paidByMemberId: storeValues.paidByMemberId,
  };

  /** Live fingerprint of the scoped draft — evaluated at decision time (render
   * comparisons AND the dialog's accept click), so a blur normalization that
   * commits between an interaction and its handler can't invalidate the
   * acceptance ledger. */
  const draftKeyOf = () => {
    const values = controller.form.store.state.values;
    return `${values.amount}|${values.categoryIds.join(",")}|${values.paidByMemberId}`;
  };
  const draftKey = draftKeyOf();
  const circleKey = `circle:${requestedId ?? ""}`;
  const typeKey = `type:${urlState.type}`;

  const circleNeedsConfirm =
    requestedId !== appliedId &&
    requestedResolvable &&
    requiresCircleSwitchConfirmation(scopedDraft);
  const circleConfirmed = confirmed?.key === circleKey && confirmed.draft === draftKey;
  // Type authority is the controller's activeType (it owns the Category read
  // and the form's type field); appliedId carries only the destination id.
  const typeNeedsConfirm =
    urlState.type !== controller.activeType && requiresTypeChangeConfirmation(scopedDraft);
  const typeConfirmed = confirmed?.key === typeKey && confirmed.draft === draftKey;

  // Circle diffs settle first so a Back/Forward spanning both never stacks two
  // dialogs; the Type diff settles on the next pass.
  const pendingConfirmKind: "circle" | "type" | null =
    circleNeedsConfirm && !circleConfirmed
      ? "circle"
      : typeNeedsConfirm && !typeConfirmed
        ? "type"
        : null;

  if (!pendingConfirmKind && requestedResolvable && requestedId !== appliedId) {
    if (invalidating) {
      // Wait for the URL to drop the rejected Circle; do not re-apply it from a
      // still-eligible listMyCircles row after submit-time destination rejection.
      if (requestedId === null) {
        setInvalidating(false);
      }
    } else {
      setAppliedId(requestedId);
      // Consume the acceptance ledger once its transition settles so a later
      // return to the same destination with the same draft fingerprint cannot
      // silently bypass confirmation.
      setConfirmed(null);
    }
  }
  if (
    confirmed?.key.startsWith("type:") &&
    urlState.type === controller.activeType &&
    !typeNeedsConfirm
  ) {
    // Type settlement happens in an effect (controller field mutations); consume
    // the ledger here in the same render-phase pattern as Circle switches.
    setConfirmed(null);
  }
  if (!everSelected && appliedEligible) {
    setEverSelected(true);
  }

  // Step 2 shows the shared form once this visit has a destination context —
  // an initial `circle` param while it resolves, or any applied selection —
  // and only the truly-unselected visit sees the explanation placeholder.
  const showBody = everSelected || requestedId !== null;

  // --- URL writers (controls; replace, never push) -------------------------
  const navigateTo = useCallback(
    (type: TransactionType, circleRef: string | undefined, returnTo: string) => {
      navigate(canonicalGlobalAddUrl({ type, circleRef, returnTo }), { replace: true });
    },
    [navigate],
  );
  /** Where cleared/failed states land: the canonical unselected shape. */
  const navigateWithoutCircle = useCallback(
    (returnTo: string) => {
      navigate(canonicalGlobalAddUrl({ type: urlState.type, returnTo }), { replace: true });
    },
    [navigate, urlState.type],
  );

  // --- Transition appliers (executed on edges by the effects below) --------
  const invalidateDestination = useCallback(() => {
    setInvalidating(true);
    const invalidation = destinationInvalidation("circle_unavailable");
    controller.clearScopedValues();
    controller.markResetWarnings(invalidation.fields, invalidation.reason);
    show(invalidation.toast);
    setAppliedId(null);
    lastEdgeRef.current = { id: null, currency: null };
    navigateWithoutCircle(returnUrl);
  }, [controller, show, navigateWithoutCircle, returnUrl]);

  useEffect(() => {
    invalidateDestinationRef.current = invalidateDestination;
  }, [invalidateDestination]);

  // --- Effects: external-system synchronization only -----------------------

  // Canonicalize the query immediately (drop unknown/duplicate params,
  // normalize Type, keep the validated origin). Compare against the Router
  // location — never `window.location` — so MemoryRouter tests and the real
  // browser agree on "already canonical". The circle param is carried
  // verbatim until resolution completes; the stale-slug effect swaps it after.
  useEffect(() => {
    const target = canonicalGlobalAddUrl({
      type: urlState.type,
      circleRef: urlState.circleRefParam ?? undefined,
      returnTo: urlState.returnTo,
    });
    const current = `${location.pathname}${location.search}`;
    if (current !== target) {
      navigate(target, { replace: true });
    }
  }, [urlState, location.pathname, location.search, navigate]);

  // Canonicalize a stale slug once its id resolves to an eligible destination
  // (replace navigation; validated origin and Type preserved).
  useEffect(() => {
    if (circles === undefined || requestedId === null) {
      return;
    }
    const match = circles.find((circle) => circle.id === requestedId);
    if (!match || !isEligibleDestination(match) || match.ref === urlState.circleRefParam) {
      return;
    }
    navigate(
      canonicalGlobalAddUrl({
        type: urlState.type,
        circleRef: match.ref,
        returnTo: urlState.returnTo,
      }),
      { replace: true },
    );
  }, [circles, requestedId, urlState.circleRefParam, urlState.returnTo, urlState.type, navigate]);

  // Type application on settled diffs: flips the Category read, clears the
  // selection (controller contract), and never runs while its dialog is open.
  useEffect(() => {
    if (pendingConfirmKind !== null || urlState.type === controller.activeType) {
      return;
    }
    controller.applyTypeChange(urlState.type);
  }, [pendingConfirmKind, urlState.type, controller.activeType, controller]);

  // Destination edge: applies the scoped-value contracts whenever the applied
  // destination CHANGES (voluntary switch / removal / first selection → plain
  // clear) or its eligibility or Currency changes underneath (reactive
  // invalidation → full reset contract; currency change → Amount only).
  useEffect(() => {
    const next = appliedEligible ? appliedCircle : null;
    const nextId = next?.id ?? null;
    const nextCurrency = next?.currency ?? null;
    const prev = lastEdgeRef.current;

    if (prev === null) {
      // First commit: adopt silently; `everSelected` derives during render.
      lastEdgeRef.current = { id: nextId, currency: nextCurrency };
      return;
    }

    if (prev.id === nextId) {
      // Same destination — watch its Currency only. Null prev currency means
      // the destination was unresolved before, so this is adoption, not loss.
      if (nextCurrency !== null && prev.currency !== null && prev.currency !== nextCurrency) {
        const hadAmount = controller.form.store.state.values.amount !== "";
        controller.clearAmount();
        if (hadAmount) {
          const invalidation = destinationInvalidation("currency_changed");
          controller.markResetWarnings(invalidation.fields, invalidation.reason);
          show(invalidation.toast);
        }
      }
      if (prev.currency !== nextCurrency) {
        lastEdgeRef.current = { id: nextId, currency: nextCurrency };
      }
      return;
    }

    lastEdgeRef.current = { id: nextId, currency: nextCurrency };

    if (prev.id !== null && nextId === null) {
      const previousCircle =
        circles === undefined ? undefined : circles.find((circle) => circle.id === prev.id);
      const previousLost =
        previousCircle !== undefined
          ? !isEligibleDestination(previousCircle)
          : circles !== undefined;
      if (previousLost) {
        // Applied destination died (archived / Setup-incomplete / gone from the
        // list) — full reset contract even if the URL already moved away.
        invalidateDestination();
        return;
      }
      // Voluntary URL removal while the previous Circle remains eligible.
      controller.clearScopedValues();
      controller.clearResetWarnings();
      return;
    }
    // Voluntary switch to another Circle or first selection: clear scoped
    // values with no warnings and no toast.
    controller.clearScopedValues();
    controller.clearResetWarnings();
  }, [appliedEligible, appliedCircle, circles, invalidateDestination, controller, show]);

  // Unresolvable requests. With an eligible applied selection behind them this
  // is a failed optimistic switch: nothing was cleared (settlement never
  // happened), so restoring the settled URL + the dedicated toast is lossless.
  // Without an eligible rollback target it is either an initial invalid
  // Circle param or destination invalidation already in flight — never the
  // restore toast (that would overwrite the real unavailable/reset message).
  useEffect(() => {
    if (
      circles === undefined ||
      pendingConfirmKind !== null ||
      requestedResolvable ||
      (!urlState.hadUnparseableCircle && urlState.circleId === null)
    ) {
      return;
    }
    if (!everSelected) {
      // An initial invalid/unparseable Circle param: no rollback target and no
      // draft to lose - strip the param, keep ordinary Global Add, generic
      // feedback only.
      if (requestedId !== null || urlState.circleId !== null) {
        navigateWithoutCircle(urlState.returnTo);
      }
      showUnavailable("circle");
      return;
    }
    if (requestedId === appliedId) {
      // The applied Circle itself went bad — the destination-edge effect owns
      // that case with the full reset contract instead.
      return;
    }
    const settled = eligibleCircles.find((circle) => circle.id === appliedId);
    if (!settled) {
      // No eligible rollback target. invalidateDestination already cleared
      // appliedId and is rewriting the URL; do not fire the restore toast on
      // top of the unavailable/reset message.
      return;
    }
    // Genuine failed switch away from a still-eligible selection.
    navigate(
      canonicalGlobalAddUrl({
        type: urlState.type,
        circleRef: settled.ref,
        returnTo: urlState.returnTo,
      }),
      { replace: true },
    );
    show(SWITCH_RESTORED_TOAST);
  }, [
    circles,
    pendingConfirmKind,
    requestedResolvable,
    requestedId,
    appliedId,
    eligibleCircles,
    everSelected,
    urlState.hadUnparseableCircle,
    urlState.circleId,
    urlState.returnTo,
    urlState.type,
    navigateWithoutCircle,
    navigate,
    show,
    showUnavailable,
  ]);

  // Choosing or switching to a valid Circle reveals Step 2 — scroll its
  // section to the top and move focus to Title (selection preserved,
  // preventScroll so focus never causes a second jump). Smooth normally,
  // instant for reduced motion. Deep links do NOT scroll-jack on mount.
  const stepTwoRef = useRef<HTMLDivElement>(null);
  const previousAppliedIdRef = useRef<string | null>(appliedId);
  useEffect(() => {
    const previous = previousAppliedIdRef.current;
    previousAppliedIdRef.current = appliedId;
    if (previous === appliedId || appliedId === null) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      const container = stepTwoRef.current;
      if (!container) {
        return;
      }
      const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      container.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
      const title = container.querySelector<HTMLInputElement>("#txn-title");
      title?.focus({ preventScroll: true });
      title?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [appliedId]);

  // --- Dialog decisions and close paths (events only) ----------------------
  const cancelConfirm = () => {
    // Lossless: the URL returns to the applied state; the complete draft —
    // including the previous Circle's scoped values — was never touched.
    const settled =
      appliedId === null ? undefined : eligibleCircles.find((c) => c.id === appliedId);
    setConfirmed(null);
    navigate(
      canonicalGlobalAddUrl({
        type: controller.activeType,
        circleRef: settled?.ref,
        returnTo: urlState.returnTo,
      }),
      { replace: true },
    );
  };
  const acceptConfirm = () => {
    if (pendingConfirmKind === null) {
      return;
    }
    // Read the fingerprint NOW — the activating click may have blurred the
    // Amount field and committed its normalized value since this rendered.
    setConfirmed({
      key: pendingConfirmKind === "circle" ? circleKey : typeKey,
      draft: draftKeyOf(),
    });
  };

  const close = () => {
    setClosing("cancel");
    navigate(returnUrl);
  };

  if (closing) {
    return <Splash label={closing === "success" ? "Opening transaction…" : "Returning…"} />;
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <header className="space-y-1">
        <h1 className="font-display text-2xl font-semibold tracking-tight">Add transaction</h1>
        <p className="text-sm text-muted-foreground">Choose where it belongs, then record it.</p>
      </header>

      <section
        aria-labelledby="global-add-context"
        className="rounded-xl border border-border bg-card p-5 shadow-sm"
      >
        <h2 id="global-add-context" className="text-sm font-semibold">
          Circle and Type
        </h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <label htmlFor="global-add-circle" className="text-sm font-medium">
              Circle
            </label>
            {circles === undefined ? (
              <p
                aria-live="polite"
                className="flex h-9 items-center rounded-md border border-border px-3 text-sm text-muted-foreground"
              >
                Loading Circles…
              </p>
            ) : eligibleCircles.length === 0 ? (
              <div className="grid gap-2 rounded-md border border-dashed border-border px-3 py-2.5">
                <p className="text-sm text-muted-foreground">
                  Create a Circle or finish setup first.
                </p>
                <Link
                  to={withReturnTo("/circles/new", returnUrl)}
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                >
                  Create circle
                </Link>
              </div>
            ) : (
              <select
                id="global-add-circle"
                value={appliedId ?? ""}
                onChange={(event) => {
                  const id = event.target.value || null;
                  const match = id === null ? undefined : eligibleCircles.find((c) => c.id === id);
                  navigateTo(urlState.type, match?.ref, urlState.returnTo);
                }}
                className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm shadow-sm outline-none transition-[border-color,box-shadow] duration-150 focus:border-ring focus:ring-2 focus:ring-ring/30"
              >
                <option value="">Choose a Circle</option>
                {eligibleCircles.map((circle) => (
                  <option key={circle.id} value={circle.id}>
                    {circle.name} · {circle.currency}
                  </option>
                ))}
              </select>
            )}
          </div>
          <Segmented
            label="Type"
            value={urlState.type}
            options={TYPE_OPTIONS}
            onChange={(next) =>
              navigateTo(next, urlState.circleRefParam ?? undefined, urlState.returnTo)
            }
          />
        </div>
      </section>

      <div ref={stepTwoRef} className="scroll-mt-24">
        {showBody ? (
          <TransactionFormBody controller={controller} onCancel={close} />
        ) : (
          <div
            aria-live="polite"
            className="rounded-xl border border-dashed border-border bg-muted/30 p-8 text-center"
          >
            <p className="text-sm font-medium">Choose a Circle to continue</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Currency, Categories, and Members depend on the destination.
            </p>
          </div>
        )}
      </div>

      <ModalDialog
        open={pendingConfirmKind !== null}
        onOpenChange={(open) => {
          if (!open) {
            cancelConfirm();
          }
        }}
        title={pendingConfirmKind === "type" ? "Change transaction type?" : "Change Circle?"}
        description={
          pendingConfirmKind === "type"
            ? "Your selected Categories belong to the current Type."
            : "Amount, Categories, and Paid By belong to the current Circle."
        }
      >
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            {pendingConfirmKind === "type"
              ? "Changing Type clears selected Categories. Everything else stays."
              : "Changing Circle clears Amount, Categories, and Paid By. Title, Note, Date, and Type stay."}
          </p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={cancelConfirm}
              className={buttonVariants({ variant: "outline" })}
            >
              Keep current
            </button>
            <button type="button" onClick={acceptConfirm} className={buttonVariants({})}>
              {pendingConfirmKind === "type" ? "Change type" : "Change Circle"}
            </button>
          </div>
        </div>
      </ModalDialog>
    </div>
  );
}
