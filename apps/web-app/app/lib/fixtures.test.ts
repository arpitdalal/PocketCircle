import { describe, expect, it } from "vitest";
import {
  MOCK_CIRCLES,
  MOCK_LEDGER_CATEGORY_ANALYTICS,
  MOCK_MONTHLY_SUMMARY,
  MOCK_TRANSACTIONS,
  mockCircle,
  mockResolvedCircle,
} from "./fixtures.js";

describe("mock circle fixtures", () => {
  it("synthesizes ad-hoc mock circles as setup-complete for offline route guards", () => {
    expect(mockCircle("deep-link-id").setupComplete).toBe(true);
  });

  it("reuses MOCK_CIRCLES list entries for mock-mode route resolution", () => {
    const personal = MOCK_CIRCLES.find((circle) => circle.kind === "personal");
    expect(personal).toBeDefined();
    if (!personal) {
      return;
    }
    expect(mockResolvedCircle(personal.id)).toBe(personal);
  });

  it("falls back to a setup-complete ad-hoc circle for unknown mock ids", () => {
    const circle = mockResolvedCircle("unknown-mock-id");
    expect(circle.setupComplete).toBe(true);
    expect(circle.ref).toBe("mock-circle-unknown-mock-id");
  });
});

it("keeps the mock Ledger ranking consistent with its empty transaction list and totals", () => {
  expect(MOCK_TRANSACTIONS).toHaveLength(0);
  expect(MOCK_MONTHLY_SUMMARY.totals).toEqual({ incomeMinor: 0, expenseMinor: 0, netMinor: 0 });
  expect(MOCK_LEDGER_CATEGORY_ANALYTICS).toEqual({
    currency: MOCK_MONTHLY_SUMMARY.currency,
    rows: [],
  });
});
