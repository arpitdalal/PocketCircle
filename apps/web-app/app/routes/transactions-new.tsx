import { buildRef, currentMonth, type TransactionType } from "@pocketcircle/domain";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { Splash } from "~/components/splash.js";
import {
  TransactionFormBody,
  type TransactionFormResult,
} from "~/components/transaction-form/index.js";
import { ARCHIVED_SOURCE_NO_DESTINATION_EXPLANATION } from "~/components/transaction-form/transaction-form-resets.js";
import { useTransactionForm } from "~/components/transaction-form/use-transaction-form.js";
import { buttonVariants } from "~/components/ui/button-variants.js";
import { ModalDialog } from "~/components/ui/dialog.js";
import { Segmented } from "~/components/ui/segmented.js";
import type { AnalyticsTransactionMethod } from "~/lib/analytics-events.js";
import { type Circle, useMyCircles, useTransactionDetail } from "~/lib/data.js";
import { deriveDuplicatePrefill } from "~/lib/global-add-duplicate.js";
import {
  classifySubmitDestinationFailure,
  destinationInvalidation,
  isEligibleDestination,
  requiresCircleSwitchConfirmation,
  requiresTypeChangeConfirmation,
  SWITCH_RESTORED_TOAST,
} from "~/lib/global-add-transitions.js";
import {
  canonicalGlobalAddUrl,
  parseGlobalAddParams,
  readGlobalAddParams,
  recoverOriginFromSourceDetailReturn,
  sourceRefsForRewrite,
} from "~/lib/global-add-url.js";
import { transactionDetailHref } from "~/lib/ledger-url.js";
import { withReturnTo } from "~/lib/return-to-url.js";
import { useSnackbar } from "~/lib/snackbar.js";

const TYPE_OPTIONS: { label: string; value: TransactionType }[] = [
  { label: "Expense", value: "expense" },
  { label: "Income", value: "income" },
];

/**
 * Global Add — the protected top-level `/transactions/new` route (issues #298/
 * #299). Ordinary Global Add starts from Home or the Activation Checklist;
 * Duplicate opens the same page with initialization-only `sourceCircle` /
 * `sourceTransaction` params. There is no separate Duplicate page or form mode.
 *
 * URL ownership: `type`, `circle`, optional source pair, and `returnTo` live in
 * the query, canonicalized with replace navigation. Draft fields live ONLY in
 * form memory; the form mounts once per page visit and never remounts on URL
 * changes — portable values survive, scoped values reset per the decided
 * contract. Source params remain so reload can initialize again; after one-time
 * prefill they are not a live relationship.
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
  const sourceRewrite = useMemo(
    () => sourceRefsForRewrite(urlState.sourcePair),
    [urlState.sourcePair],
  );
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
  /** Successful one-time Duplicate prefill this visit (reload restarts). */
  const [appliedPrefill, setAppliedPrefill] = useState<{
    archivedSourceWithoutDestination: boolean;
    values: ReturnType<typeof deriveDuplicatePrefill>["values"];
    warnings: ReturnType<typeof deriveDuplicatePrefill>["warnings"];
  } | null>(null);
  /** Analytics method — `duplicate` only after successful source initialization. */
  const [analyticsMethod, setAnalyticsMethod] = useState<AnalyticsTransactionMethod>("manual");
  /** Unavailable-source recovery already ran (prevents re-entry loops). */
  const [sourceRecovered, setSourceRecovered] = useState(false);

  const appliedCircle: Circle | null =
    circles !== undefined && appliedId !== null
      ? (circles.find((circle) => circle.id === appliedId) ?? null)
      : null;
  const appliedEligible = appliedCircle !== null && isEligibleDestination(appliedCircle);

  // Source Circle via Circle Visibility (`listMyCircles`) before getTransaction.
  const sourcePair = urlState.sourcePair;
  const sourceCircle =
    sourcePair.kind === "candidate" && circles !== undefined
      ? (circles.find((circle) => circle.id === sourcePair.sourceCircleId) ?? null)
      : undefined;
  const sourceTransaction = useTransactionDetail(
    sourcePair.kind === "candidate" && sourceCircle ? sourceCircle.id : undefined,
    sourcePair.kind === "candidate" && sourceCircle ? sourcePair.sourceTransactionId : undefined,
  );

  // Success opens the new canonical Circle-scoped Transaction Detail with THIS
  // page's validated origin as its return state — REPLACING the dead create
  // URL so browser Back restores the original origin exactly (issue #290).
  // Duplicate's origin is the source Detail; its Back still reaches the prior
  // Ledger / Search / Dashboard / Home (issue #299).
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

  // Ref bridges so submit-failure handlers (declared before these appliers) can
  // invoke the destination contracts — assigned in effects for the React
  // Compiler refs rule.
  const invalidateDestinationRef = useRef<() => void>(() => {});
  const applyCurrencyChangeRef = useRef<() => void>(() => {});
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
    analytics: { surface: "global", method: analyticsMethod },
    circle: appliedEligible ? appliedCircle : null,
    onComplete: completeCreation,
    // Submit-time twin of the reactive edges below: Circle loss uses the full
    // reset; Currency mismatch uses the Amount-only contract. Other failures
    // stay inline with the draft.
    onSubmitFailure: (error) => {
      const kind = classifySubmitDestinationFailure(error);
      if (kind === null) {
        return false;
      }
      if (kind === "currency_changed") {
        applyCurrencyChangeRef.current();
        return true;
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
  // dialogs; Type only confirms once Circle has already settled onto the request.
  const pendingConfirmKind: "circle" | "type" | null =
    circleNeedsConfirm && !circleConfirmed
      ? "circle"
      : typeNeedsConfirm && !typeConfirmed && requestedId === appliedId
        ? "type"
        : null;

  // After invalidateDestination, appliedId is already null and the URL rewrite
  // lands on requestedId null — those ids match, so settlement below would never
  // run. Clear the gate as soon as the URL has dropped the rejected Circle.
  // While a destination-bound write is locked (inline Category create / save),
  // do not settle URL Circle changes — Back/Forward must not move the draft
  // under an in-flight mutation.
  if (invalidating && requestedId === null) {
    setInvalidating(false);
  } else if (
    !invalidating &&
    !controller.destinationControlsLocked &&
    requestedResolvable &&
    requestedId !== appliedId &&
    (!circleNeedsConfirm || circleConfirmed)
  ) {
    // Apply immediate and confirmed Circle transitions even when a Type confirm
    // would otherwise become pending — otherwise accepting Circle opens Type
    // without settling, Type accept overwrites the ledger, and Circle loops.
    setAppliedId(requestedId);
    setConfirmed(null);
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

  /**
   * Unavailable-source recovery settlement (issue #299). When the pair is
   * unusable at parse time, or Circle Visibility / getTransaction proves the
   * source gone, settle session state during render (same sanctioned pattern as
   * appliedId). The effect below owns navigate, toast, and form clears.
   */
  const sourceKnownUnavailable =
    sourcePair.kind === "unusable" ||
    (sourcePair.kind === "candidate" &&
      circles !== undefined &&
      (sourceCircle === null || sourceTransaction === null));
  if (sourceKnownUnavailable && !sourceRecovered) {
    setSourceRecovered(true);
    setAppliedId(null);
    setAnalyticsMethod("manual");
    setAppliedPrefill(null);
  }

  /**
   * One-time Duplicate prefill derivation during render once every dependency
   * has settled. The effect below applies the draft to the form store; flags
   * settle here so effects stay free of setState.
   */
  const prefillDependenciesReady =
    sourcePair.kind === "candidate" &&
    !sourceRecovered &&
    appliedPrefill === null &&
    circles !== undefined &&
    sourceCircle != null &&
    sourceTransaction != null &&
    (!appliedEligible || controller.destinationReadsReady);
  if (prefillDependenciesReady) {
    const prefill = deriveDuplicatePrefill({
      source: sourceTransaction,
      sourceCircleArchived: sourceCircle.status === "archived",
      destinationCircleId: appliedEligible && appliedCircle ? appliedCircle.id : null,
      sourceCircleId: sourceCircle.id,
      type: urlState.type,
      selectableCategories: controller.activeCategories,
      currentMembers: controller.members,
      selfMemberId: controller.selfMemberId,
    });
    setAppliedPrefill(prefill);
    setAnalyticsMethod("duplicate");
  }

  const sourceInitialized = appliedPrefill !== null;
  const archivedSourceNoDestination = appliedPrefill?.archivedSourceWithoutDestination === true;

  // --- URL writers (controls; replace, never push) -------------------------
  const navigateTo = useCallback(
    (type: TransactionType, circleRef: string | undefined, returnTo: string) => {
      navigate(canonicalGlobalAddUrl({ type, circleRef, returnTo, ...sourceRewrite }), {
        replace: true,
      });
    },
    [navigate, sourceRewrite],
  );
  /** Where cleared/failed states land: the canonical unselected shape. */
  const navigateWithoutCircle = useCallback(
    (returnTo: string) => {
      navigate(canonicalGlobalAddUrl({ type: urlState.type, returnTo, ...sourceRewrite }), {
        replace: true,
      });
    },
    [navigate, urlState.type, sourceRewrite],
  );

  // --- Transition appliers (executed on edges by the effects below) --------
  // eslint-disable-next-line react-hooks/preserve-manual-memoization -- setInvalidating is a stable setState; listing it fights Biome exhaustive-deps
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

  /** Amount-only reset for Currency change (reactive or submit-time). */
  const applyCurrencyChange = useCallback(() => {
    const hadAmount = controller.form.store.state.values.amount !== "";
    // Skip empty Amount on the reactive edge so a post-submit required error
    // survives a no-op currency reconcile. Submit-time always had an Amount.
    if (!hadAmount) {
      return;
    }
    controller.clearAmount();
    const invalidation = destinationInvalidation("currency_changed");
    controller.markResetWarnings(invalidation.fields, invalidation.reason);
    show(invalidation.toast);
  }, [controller, show]);

  useEffect(() => {
    invalidateDestinationRef.current = invalidateDestination;
  }, [invalidateDestination]);

  useEffect(() => {
    applyCurrencyChangeRef.current = applyCurrencyChange;
  }, [applyCurrencyChange]);

  // --- Effects: external-system synchronization only -----------------------

  // Canonicalize the query immediately (drop unknown/duplicate params,
  // normalize Type, keep the validated origin and source pair). Compare against
  // the Router location — never `window.location` — so MemoryRouter tests and
  // the real browser agree on "already canonical". The circle param is carried
  // verbatim until resolution completes; the stale-slug effect swaps it after.
  useEffect(() => {
    const target = canonicalGlobalAddUrl({
      type: urlState.type,
      circleRef: urlState.circleRefParam ?? undefined,
      returnTo: urlState.returnTo,
      ...sourceRewrite,
    });
    const current = `${location.pathname}${location.search}`;
    if (current !== target) {
      navigate(target, { replace: true });
    }
  }, [urlState, sourceRewrite, location.pathname, location.search, navigate]);

  // Canonicalize a stale destination slug once its id resolves to an eligible
  // destination (replace navigation; validated origin, Type, and source pair
  // preserved).
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
        ...sourceRewrite,
      }),
      { replace: true },
    );
  }, [
    circles,
    requestedId,
    urlState.circleRefParam,
    urlState.returnTo,
    urlState.type,
    sourceRewrite,
    navigate,
  ]);

  // Canonicalize stale source refs once the source Transaction resolves
  // (initialization-only; does not alter the draft).
  useEffect(() => {
    if (sourcePair.kind !== "candidate" || !sourceCircle || !sourceTransaction || sourceRecovered) {
      return;
    }
    if (
      sourceCircle.ref === sourcePair.sourceCircleRefParam &&
      sourceTransaction.ref === sourcePair.sourceTransactionRefParam
    ) {
      return;
    }
    navigate(
      canonicalGlobalAddUrl({
        type: urlState.type,
        circleRef: urlState.circleRefParam ?? undefined,
        returnTo: urlState.returnTo,
        sourceCircleRef: sourceCircle.ref,
        sourceTransactionRef: sourceTransaction.ref,
      }),
      { replace: true },
    );
  }, [
    sourcePair,
    sourceCircle,
    sourceTransaction,
    sourceRecovered,
    urlState.type,
    urlState.circleRefParam,
    urlState.returnTo,
    navigate,
  ]);

  // Unavailable-source recovery — external systems only (navigate, toast, form
  // clear). Session flags settle during render above.
  const recoveryExternalDoneRef = useRef(false);
  useEffect(() => {
    if (!sourceRecovered || recoveryExternalDoneRef.current) {
      return;
    }
    recoveryExternalDoneRef.current = true;
    const recoveredReturn = recoverOriginFromSourceDetailReturn(urlState.returnTo);
    controller.clearScopedValues();
    controller.clearResetWarnings();
    controller.applyDraftValues({
      title: "",
      note: "",
      amount: "",
      categoryIds: [],
      paidByMemberId: "",
    });
    lastEdgeRef.current = { id: null, currency: null };
    navigate(canonicalGlobalAddUrl({ type: "expense", returnTo: recoveredReturn }), {
      replace: true,
    });
    showUnavailable("link");
  }, [sourceRecovered, controller, navigate, showUnavailable, urlState.returnTo]);

  // One-time Duplicate form apply — layout effect so values land before paint
  // (no empty-form flash after Splash). Session flags settled during render.
  const prefillFormAppliedRef = useRef(false);
  useLayoutEffect(() => {
    if (appliedPrefill === null || prefillFormAppliedRef.current) {
      return;
    }
    prefillFormAppliedRef.current = true;
    controller.applyDraftValues(appliedPrefill.values);
    controller.clearResetWarnings();
    if (appliedPrefill.warnings.categoryIds !== undefined) {
      controller.markResetWarnings(["categoryIds"], appliedPrefill.warnings.categoryIds);
    }
    if (appliedPrefill.warnings.paidByMemberId !== undefined) {
      controller.markResetWarnings(["paidByMemberId"], appliedPrefill.warnings.paidByMemberId);
    }
  }, [appliedPrefill, controller]);

  // Type application on settled diffs: flips the Category read, clears the
  // selection (controller contract), and never runs while its dialog is open,
  // while Circle is still settling / rolling back, or while a destination-bound
  // write is locked (Back/Forward must not unmount an in-flight Category create).
  useEffect(() => {
    if (
      controller.destinationControlsLocked ||
      pendingConfirmKind !== null ||
      requestedId !== appliedId ||
      urlState.type === controller.activeType
    ) {
      return;
    }
    controller.applyTypeChange(urlState.type);
  }, [
    controller.destinationControlsLocked,
    pendingConfirmKind,
    requestedId,
    appliedId,
    urlState.type,
    controller.activeType,
    controller,
  ]);

  // While locked, pin the URL to the applied destination + active Type so
  // browser history cannot drift Circle/Type under an in-flight write.
  useEffect(() => {
    if (!controller.destinationControlsLocked) {
      return;
    }
    const settled =
      appliedId === null ? undefined : eligibleCircles.find((circle) => circle.id === appliedId);
    const target = canonicalGlobalAddUrl({
      type: controller.activeType,
      circleRef: settled?.ref,
      returnTo: urlState.returnTo,
      ...sourceRewrite,
    });
    const current = `${location.pathname}${location.search}`;
    if (current !== target) {
      navigate(target, { replace: true });
    }
  }, [
    controller.destinationControlsLocked,
    controller.activeType,
    appliedId,
    eligibleCircles,
    urlState.returnTo,
    sourceRewrite,
    location.pathname,
    location.search,
    navigate,
  ]);

  // Destination edge: applies the scoped-value contracts whenever the applied
  // destination CHANGES (voluntary switch / removal / first selection → plain
  // clear) or its eligibility or Currency changes underneath (reactive
  // invalidation → full reset contract; currency change → Amount only).
  useEffect(() => {
    // A transient `useMyCircles()` reload returns undefined — do not treat that
    // as destination loss or it silently clears the draft / drops confirmations.
    if (circles === undefined) {
      return;
    }
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
        applyCurrencyChange();
      }
      if (prev.currency !== nextCurrency) {
        lastEdgeRef.current = { id: nextId, currency: nextCurrency };
      }
      return;
    }

    lastEdgeRef.current = { id: nextId, currency: nextCurrency };

    if (prev.id !== null && nextId === null) {
      const previousCircle = circles.find((circle) => circle.id === prev.id);
      const previousLost =
        previousCircle !== undefined ? !isEligibleDestination(previousCircle) : true;
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
  }, [
    appliedEligible,
    appliedCircle,
    circles,
    invalidateDestination,
    applyCurrencyChange,
    controller,
  ]);

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
      // feedback only. Unparseable values keep `circleId` null, so the raw
      // param flag is what still requires the strip.
      if (requestedId !== null || urlState.circleId !== null || urlState.hadUnparseableCircle) {
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
      if (invalidating) {
        // invalidateDestination already cleared appliedId and is rewriting the
        // URL; do not fire restore/unavailable feedback on top of that contract.
        return;
      }
      // everSelected with no eligible rollback (e.g. after removal, then
      // Back/Forward to an unavailable Circle): strip the stale param and show
      // the same generic unavailable feedback as an initial bad deep link.
      if (requestedId !== null || urlState.circleId !== null || urlState.hadUnparseableCircle) {
        navigateWithoutCircle(urlState.returnTo);
      }
      showUnavailable("circle");
      return;
    }
    // Genuine failed switch away from a still-eligible selection.
    navigate(
      canonicalGlobalAddUrl({
        type: urlState.type,
        circleRef: settled.ref,
        returnTo: urlState.returnTo,
        ...sourceRewrite,
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
    invalidating,
    urlState.hadUnparseableCircle,
    urlState.circleId,
    urlState.returnTo,
    urlState.type,
    sourceRewrite,
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
        ...sourceRewrite,
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

  // Hold behind ordinary Splash until Duplicate source resolution + prefill
  // dependencies settle (or recovery rewrites to ordinary Global Add).
  const sourcePending =
    (sourcePair.kind === "candidate" && !sourceInitialized && !sourceRecovered) ||
    (sourcePair.kind === "unusable" && !sourceRecovered);

  if (closing) {
    return <Splash label={closing === "success" ? "Opening transaction…" : "Returning…"} />;
  }

  if (sourcePending) {
    return <Splash label="Opening…" />;
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
                disabled={controller.destinationControlsLocked}
                onChange={(event) => {
                  const id = event.target.value || null;
                  const match = id === null ? undefined : eligibleCircles.find((c) => c.id === id);
                  navigateTo(urlState.type, match?.ref, urlState.returnTo);
                }}
                className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm shadow-sm outline-none transition-[border-color,box-shadow] duration-150 focus:border-ring focus:ring-2 focus:ring-ring/30 disabled:opacity-50"
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
            disabled={controller.destinationControlsLocked}
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
            {archivedSourceNoDestination ? (
              <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-900 dark:text-amber-100">
                {ARCHIVED_SOURCE_NO_DESTINATION_EXPLANATION}
              </p>
            ) : (
              <>
                <p className="text-sm font-medium">Choose a Circle to continue</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Currency, Categories, and Members depend on the destination.
                </p>
              </>
            )}
            <div className="mt-4 flex justify-center">
              <button
                type="button"
                onClick={close}
                className={buttonVariants({ variant: "ghost" })}
              >
                Cancel
              </button>
            </div>
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
