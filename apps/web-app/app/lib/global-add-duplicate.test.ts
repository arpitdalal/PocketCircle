import { describe, expect, it } from "vitest";
import { deriveDuplicatePrefill } from "./global-add-duplicate.js";

/**
 * Pure Duplicate prefill + warning derivation (issue #299): active/Archived
 * sources, Archived source Circle, same/different destination, Type overrides,
 * selectable vs omitted Categories, current vs inactive Paid By, and today's
 * Transaction Date.
 */

const TODAY = new Date(2026, 7, 25); // 2026-08-25

const SOURCE = {
  type: "expense" as const,
  title: "Weekly shop",
  note: "Milk and eggs",
  amountMinorUnits: 1250,
  categories: [{ id: "cat-groceries" }, { id: "cat-gone" }],
  paidBy: { id: "mem-alex" },
};

describe("deriveDuplicatePrefill", () => {
  it("copies Title, Note, and today's Date for every usable source", () => {
    const result = deriveDuplicatePrefill({
      source: SOURCE,
      sourceCircleArchived: false,
      destinationCircleId: "c1",
      sourceCircleId: "c1",
      type: "expense",
      selectableCategories: [
        { id: "cat-groceries", status: "active" },
        { id: "cat-gone", status: "archived" },
      ],
      currentMembers: [{ id: "mem-alex" }, { id: "mem-you" }],
      selfMemberId: "mem-you",
      today: TODAY,
    });
    expect(result.values.title).toBe("Weekly shop");
    expect(result.values.note).toBe("Milk and eggs");
    expect(result.values.date).toBe("2026-08-25");
  });

  it("copies Amount, selectable Categories, and current Paid By when Circles match", () => {
    const result = deriveDuplicatePrefill({
      source: SOURCE,
      sourceCircleArchived: false,
      destinationCircleId: "c1",
      sourceCircleId: "c1",
      type: "expense",
      selectableCategories: [
        { id: "cat-groceries", status: "active" },
        { id: "cat-gone", status: "archived" },
      ],
      currentMembers: [{ id: "mem-alex" }, { id: "mem-you" }],
      selfMemberId: "mem-you",
      today: TODAY,
    });
    expect(result.values.amount).toBe("12.50");
    expect(result.values.categoryIds).toEqual(["cat-groceries"]);
    expect(result.values.paidByMemberId).toBe("mem-alex");
    expect(result.warnings.categoryIds).toBe("categories_omitted");
    expect(result.warnings.paidByMemberId).toBeUndefined();
    expect(result.archivedSourceWithoutDestination).toBe(false);
  });

  it("omits Categories and retains Amount + Paid By when explicit Type differs", () => {
    const result = deriveDuplicatePrefill({
      source: SOURCE,
      sourceCircleArchived: false,
      destinationCircleId: "c1",
      sourceCircleId: "c1",
      type: "income",
      selectableCategories: [{ id: "cat-salary", status: "active" }],
      currentMembers: [{ id: "mem-alex" }, { id: "mem-you" }],
      selfMemberId: "mem-you",
      today: TODAY,
    });
    expect(result.values.amount).toBe("12.50");
    expect(result.values.categoryIds).toEqual([]);
    expect(result.values.paidByMemberId).toBe("mem-alex");
    expect(result.warnings.categoryIds).toBeUndefined();
  });

  it("leaves scoped fields empty when destination differs from source Circle", () => {
    const result = deriveDuplicatePrefill({
      source: SOURCE,
      sourceCircleArchived: false,
      destinationCircleId: "c2",
      sourceCircleId: "c1",
      type: "expense",
      selectableCategories: [{ id: "cat-other", status: "active" }],
      currentMembers: [{ id: "mem-you" }],
      selfMemberId: "mem-you",
      today: TODAY,
    });
    expect(result.values).toMatchObject({
      title: "Weekly shop",
      note: "Milk and eggs",
      amount: "",
      categoryIds: [],
      paidByMemberId: "",
    });
    expect(result.warnings).toEqual({});
  });

  it("leaves scoped fields empty when destination is absent", () => {
    const result = deriveDuplicatePrefill({
      source: SOURCE,
      sourceCircleArchived: false,
      destinationCircleId: null,
      sourceCircleId: "c1",
      type: "expense",
      selectableCategories: [],
      currentMembers: [],
      selfMemberId: "",
      today: TODAY,
    });
    expect(result.values.amount).toBe("");
    expect(result.values.categoryIds).toEqual([]);
    expect(result.archivedSourceWithoutDestination).toBe(false);
  });

  it("for an Archived source Circle, copies only portable fields and flags the explanation", () => {
    const result = deriveDuplicatePrefill({
      source: SOURCE,
      sourceCircleArchived: true,
      destinationCircleId: null,
      sourceCircleId: "c1",
      type: "expense",
      selectableCategories: [],
      currentMembers: [],
      selfMemberId: "",
      today: TODAY,
    });
    expect(result.values).toEqual({
      title: "Weekly shop",
      note: "Milk and eggs",
      date: "2026-08-25",
      amount: "",
      categoryIds: [],
      paidByMemberId: "",
    });
    expect(result.archivedSourceWithoutDestination).toBe(true);
    expect(result.warnings).toEqual({});
  });

  it("does not copy scoped fields from an Archived source Circle even if a destination is set", () => {
    // Destination should never be the archived source; if somehow present, still
    // treat archived source as non-writable scoped context.
    const result = deriveDuplicatePrefill({
      source: SOURCE,
      sourceCircleArchived: true,
      destinationCircleId: "c1",
      sourceCircleId: "c1",
      type: "expense",
      selectableCategories: [{ id: "cat-groceries", status: "active" }],
      currentMembers: [{ id: "mem-alex" }],
      selfMemberId: "mem-you",
      today: TODAY,
    });
    expect(result.values.amount).toBe("");
    expect(result.values.categoryIds).toEqual([]);
  });

  it("substitutes Paid By to the current User when the source payer is not current", () => {
    const result = deriveDuplicatePrefill({
      source: SOURCE,
      sourceCircleArchived: false,
      destinationCircleId: "c1",
      sourceCircleId: "c1",
      type: "expense",
      selectableCategories: [{ id: "cat-groceries", status: "active" }],
      currentMembers: [{ id: "mem-you" }],
      selfMemberId: "mem-you",
      today: TODAY,
    });
    expect(result.values.paidByMemberId).toBe("mem-you");
    expect(result.warnings.paidByMemberId).toBe("paid_by_substituted");
  });

  it("copies an empty Note as empty string", () => {
    const result = deriveDuplicatePrefill({
      source: { ...SOURCE, note: undefined },
      sourceCircleArchived: false,
      destinationCircleId: null,
      sourceCircleId: "c1",
      type: "expense",
      selectableCategories: [],
      currentMembers: [],
      selfMemberId: "",
      today: TODAY,
    });
    expect(result.values.note).toBe("");
  });

  it("does not warn when every source Category remains selectable", () => {
    const result = deriveDuplicatePrefill({
      source: { ...SOURCE, categories: [{ id: "cat-groceries" }] },
      sourceCircleArchived: false,
      destinationCircleId: "c1",
      sourceCircleId: "c1",
      type: "expense",
      selectableCategories: [{ id: "cat-groceries", status: "active" }],
      currentMembers: [{ id: "mem-alex" }],
      selfMemberId: "mem-you",
      today: TODAY,
    });
    expect(result.warnings).toEqual({});
  });
});
