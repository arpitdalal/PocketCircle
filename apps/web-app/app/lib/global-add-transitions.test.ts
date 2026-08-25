import { MUTATION_ERRORS, mutationErrorData } from "@pocketcircle/domain";
import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";
import { transactionResetWarning } from "~/components/transaction-form/transaction-form-resets.js";
import {
  destinationInvalidation,
  hasScopedDraft,
  isDestinationInvalidationError,
  isEligibleDestination,
  requiresCircleSwitchConfirmation,
  requiresTypeChangeConfirmation,
  type ScopedDraftSnapshot,
  SWITCH_RESTORED_TOAST,
} from "./global-add-transitions.js";

/**
 * Pure tests for Global Add transition and reset derivation (issue #298):
 * confirmation conditions, preservation contracts' inputs, automatic
 * invalidation reset bundles, optimistic-rollback messaging, eligibility, and
 * submit-time destination-error classification.
 */

const EMPTY_DRAFT: ScopedDraftSnapshot = { amount: "", categoryIds: [], paidByMemberId: "" };

describe("scoped draft and confirmation derivation", () => {
  it("treats an all-empty draft as no work", () => {
    expect(hasScopedDraft(EMPTY_DRAFT)).toBe(false);
  });

  it("detects work in each scoped field independently", () => {
    expect(hasScopedDraft({ ...EMPTY_DRAFT, amount: "1" })).toBe(true);
    expect(hasScopedDraft({ ...EMPTY_DRAFT, categoryIds: ["cat"] })).toBe(true);
    expect(hasScopedDraft({ ...EMPTY_DRAFT, paidByMemberId: "m2" })).toBe(true);
  });

  it("confirms a Circle switch exactly when scoped work exists", () => {
    expect(requiresCircleSwitchConfirmation(EMPTY_DRAFT)).toBe(false);
    expect(requiresCircleSwitchConfirmation({ ...EMPTY_DRAFT, amount: "12.50" })).toBe(true);
    expect(requiresCircleSwitchConfirmation({ ...EMPTY_DRAFT, paidByMemberId: "m2" })).toBe(true);
  });

  it("does not treat an implicit (empty) Paid By as explicit selection", () => {
    // The form displays and submits the current User when the value is empty,
    // so switching with only that default set must stay immediate.
    expect(requiresCircleSwitchConfirmation(EMPTY_DRAFT)).toBe(false);
  });

  it("confirms a Type change exactly when Categories are selected", () => {
    expect(requiresTypeChangeConfirmation(EMPTY_DRAFT)).toBe(false);
    expect(requiresTypeChangeConfirmation({ ...EMPTY_DRAFT, categoryIds: ["cat"] })).toBe(true);
  });
});

describe("destination eligibility", () => {
  it("accepts an active, Setup-complete Circle", () => {
    expect(isEligibleDestination({ status: "active", setupComplete: true })).toBe(true);
  });

  it.each([
    { status: "archived", setupComplete: true },
    { status: "active", setupComplete: false },
  ])("rejects $status / setupComplete=$setupComplete", ({ status, setupComplete }) => {
    expect(isEligibleDestination({ status, setupComplete })).toBe(false);
  });
});

describe("automatic invalidation reset bundles", () => {
  it("marks Amount, Categories, and Paid By for Circle invalidation with its toast", () => {
    const invalidation = destinationInvalidation("circle_unavailable");
    expect(invalidation.toast).toBe(
      "That Circle is no longer available. Circle-specific fields were cleared.",
    );
    expect(invalidation.fields).toEqual(["amount", "categoryIds", "paidByMemberId"]);
    for (const field of invalidation.fields) {
      expect(transactionResetWarning(invalidation.reason, field)).toMatch(/cleared because/i);
    }
  });

  it("marks only Amount for a Currency change with its toast", () => {
    const invalidation = destinationInvalidation("currency_changed");
    expect(invalidation.toast).toBe("The Circle's currency changed. Amount was cleared.");
    expect(invalidation.fields).toEqual(["amount"]);
    expect(transactionResetWarning(invalidation.reason, "amount")).toContain("currency");
  });

  it("restores with the dedicated switch-restored toast", () => {
    expect(SWITCH_RESTORED_TOAST).toBe(
      "Couldn't switch Circles. Your previous values were restored.",
    );
  });
});

describe("submit-time destination-error classification", () => {
  it("classifies the archived-circle guard error as destination invalidation", () => {
    expect(
      isDestinationInvalidationError(
        new ConvexError(mutationErrorData(MUTATION_ERRORS.circleArchived)),
      ),
    ).toBe(true);
  });

  it("classifies the Setup-incomplete guard error as destination invalidation", () => {
    expect(
      isDestinationInvalidationError(
        new ConvexError(mutationErrorData(MUTATION_ERRORS.circleSetupIncomplete)),
      ),
    ).toBe(true);
  });

  it("classifies the plain access-revoked throw as destination invalidation", () => {
    expect(isDestinationInvalidationError(new Error("Circle not found"))).toBe(true);
  });

  it("keeps other coded errors inline instead of resetting", () => {
    expect(
      isDestinationInvalidationError(
        new ConvexError(mutationErrorData(MUTATION_ERRORS.memberNotFound)),
      ),
    ).toBe(false);
  });

  it("keeps unknown failures inline instead of resetting", () => {
    expect(isDestinationInvalidationError(new Error("network down"))).toBe(false);
    expect(isDestinationInvalidationError(undefined)).toBe(false);
  });
});
