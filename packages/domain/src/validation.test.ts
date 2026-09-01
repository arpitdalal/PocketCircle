import { describe, expect, it } from "vitest";
import { COLOR_PALETTE, colorLabel, PERSONAL_CIRCLE_COLOR_ID } from "./color.js";
import { MAX_AMOUNT_MINOR } from "./money.js";
import {
  canonicalEmail,
  categoryInputSchema,
  circleInputSchema,
  circleSettingsUpdateSchema,
  isTransactionType,
  LIMITS,
  normalizeDisplayName,
  parseCircleSettingsUpdate,
  parseProfileUpdate,
  toMutationArgs,
  transactionCreateSchema,
  transactionFormSchema,
  transactionUpdateSchema,
} from "./validation.js";

describe("canonicalEmail", () => {
  it("leaves non-string preprocess input for schema validation", () => {
    expect(canonicalEmail(42)).toBe(42);
    expect(canonicalEmail("  Ada@Example.COM ")).toBe("ada@example.com");
  });
});

describe("parseProfileUpdate (USR-1 profile edit contract)", () => {
  it("accepts and trims a display name", () => {
    expect(parseProfileUpdate({ displayName: "  Ada  " })).toEqual({
      ok: true,
      value: { displayName: "Ada" },
    });
  });

  it("rejects an empty name with a stable error message", () => {
    expect(parseProfileUpdate({ displayName: "" })).toEqual({
      ok: false,
      error: "Name is required",
    });
  });

  it("rejects a whitespace-only name", () => {
    expect(parseProfileUpdate({ displayName: "   " }).ok).toBe(false);
  });
});

describe("normalizeDisplayName", () => {
  it("does not split a provider-seeded Unicode character at the length bound", () => {
    expect(normalizeDisplayName(`${"x".repeat(LIMITS.displayNameMax - 1)}😀`)).toBe(
      "x".repeat(LIMITS.displayNameMax - 1),
    );
  });
});

/**
 * The shared category form contract (ADR 0010). These assertions are the
 * first line of defense for CAT-1's invariants — name trimming/length, the
 * type enum, and the required palette color — but never the only one: Convex
 * re-validates the same input server-side (ADR 0015).
 */
describe("categoryInputSchema", () => {
  const valid = { name: "Groceries", type: "expense", color: "green" } as const;

  it("accepts a well-formed expense category", () => {
    expect(categoryInputSchema.parse(valid)).toEqual(valid);
  });

  it("accepts a well-formed income category", () => {
    const input = { name: "Salary", type: "income", color: "teal" } as const;
    expect(categoryInputSchema.parse(input)).toEqual(input);
  });

  it("trims surrounding whitespace from the name", () => {
    expect(categoryInputSchema.parse({ ...valid, name: "  Gas  " }).name).toBe("Gas");
  });

  it("rejects an empty name", () => {
    expect(categoryInputSchema.safeParse({ ...valid, name: "" }).success).toBe(false);
  });

  it("rejects a whitespace-only name", () => {
    expect(categoryInputSchema.safeParse({ ...valid, name: "   " }).success).toBe(false);
  });

  it("accepts a name at the max length", () => {
    const name = "x".repeat(LIMITS.categoryNameMax);
    expect(categoryInputSchema.parse({ ...valid, name }).name).toBe(name);
  });

  it("rejects a name one character over the max length", () => {
    const name = "x".repeat(LIMITS.categoryNameMax + 1);
    expect(categoryInputSchema.safeParse({ ...valid, name }).success).toBe(false);
  });

  it("rejects an unsupported transaction type", () => {
    expect(categoryInputSchema.safeParse({ ...valid, type: "transfer" }).success).toBe(false);
  });

  it("rejects a missing color", () => {
    expect(categoryInputSchema.safeParse({ name: "Gas", type: "expense" }).success).toBe(false);
  });

  it("rejects a color outside the palette", () => {
    expect(categoryInputSchema.safeParse({ ...valid, color: "chartreuse" }).success).toBe(false);
  });

  it("accepts every palette color id", () => {
    for (const color of COLOR_PALETTE) {
      expect(categoryInputSchema.safeParse({ ...valid, color: color.id }).success).toBe(true);
    }
  });
});

describe("circleInputSchema", () => {
  const valid = { name: "Trip", currency: "USD", color: "teal", mark: "T" } as const;

  it("accepts every palette color id", () => {
    for (const color of COLOR_PALETTE) {
      expect(circleInputSchema.safeParse({ ...valid, color: color.id }).success).toBe(true);
    }
  });

  it("rejects the reserved Personal Circle color id", () => {
    expect(circleInputSchema.safeParse({ ...valid, color: PERSONAL_CIRCLE_COLOR_ID }).success).toBe(
      false,
    );
  });
});

describe("circleSettingsUpdateSchema (server contract)", () => {
  it("accepts an empty payload (all fields optional ≡ no-op edit)", () => {
    expect(circleSettingsUpdateSchema.parse({})).toEqual({});
  });

  it("accepts a valid color and setup answers", () => {
    expect(
      circleSettingsUpdateSchema.parse({
        color: "teal",
        setupAnswers: { purpose: "residence", residenceType: "owned" },
      }),
    ).toEqual({
      color: "teal",
      setupAnswers: { purpose: "residence", residenceType: "owned" },
    });
  });

  it("rejects a color outside the palette", () => {
    expect(circleSettingsUpdateSchema.safeParse({ color: "chartreuse" }).success).toBe(false);
  });

  it("rejects iris on the palette-only schema", () => {
    expect(circleSettingsUpdateSchema.safeParse({ color: PERSONAL_CIRCLE_COLOR_ID }).success).toBe(
      false,
    );
  });

  it("rejects an invalid setup purpose", () => {
    expect(
      circleSettingsUpdateSchema.safeParse({ setupAnswers: { purpose: "vacation" } }).success,
    ).toBe(false);
  });
});

describe("parseCircleSettingsUpdate (kind-aware CS-2 contract)", () => {
  it("accepts iris for Personal Circles and rejects it for regular Circles", () => {
    expect(parseCircleSettingsUpdate({ color: PERSONAL_CIRCLE_COLOR_ID }, "personal")).toEqual({
      color: PERSONAL_CIRCLE_COLOR_ID,
    });
    expect(() =>
      parseCircleSettingsUpdate({ color: PERSONAL_CIRCLE_COLOR_ID }, "regular"),
    ).toThrow();
  });

  it("accepts palette colors for both kinds", () => {
    expect(parseCircleSettingsUpdate({ color: "teal" }, "personal")).toEqual({ color: "teal" });
    expect(parseCircleSettingsUpdate({ color: "teal" }, "regular")).toEqual({ color: "teal" });
  });
});

describe("transactionFormSchema (pure form contract)", () => {
  const valid = {
    type: "expense",
    title: "Lunch",
    amount: "12.50",
    date: "2026-05-15",
    categoryIds: ["cat-1"],
    paidByMemberId: "mem-1",
    note: "",
  } as const;

  it("validates without transforming — amount stays the entered string", () => {
    const parsed = transactionFormSchema.parse(valid);
    expect(parsed.amount).toBe("12.50");
    expect(parsed.title).toBe("Lunch");
    // No transform: there is no derived amountMinorUnits on the parsed value.
    expect("amountMinorUnits" in parsed).toBe(false);
  });

  it("trims the title and note", () => {
    const parsed = transactionFormSchema.parse({
      ...valid,
      title: "  Lunch  ",
      note: "  with the team  ",
    });
    expect(parsed.title).toBe("Lunch");
    expect(parsed.note).toBe("with the team");
  });

  it("accepts an income transaction", () => {
    expect(transactionFormSchema.safeParse({ ...valid, type: "income" }).success).toBe(true);
  });

  it("accepts an empty paidByMemberId (self)", () => {
    expect(transactionFormSchema.safeParse({ ...valid, paidByMemberId: "" }).success).toBe(true);
  });

  it("rejects an empty title", () => {
    expect(transactionFormSchema.safeParse({ ...valid, title: "" }).success).toBe(false);
  });

  it("rejects a whitespace-only title", () => {
    expect(transactionFormSchema.safeParse({ ...valid, title: "   " }).success).toBe(false);
  });

  it("rejects a title over the max length", () => {
    const title = "x".repeat(LIMITS.transactionTitleMax + 1);
    expect(transactionFormSchema.safeParse({ ...valid, title }).success).toBe(false);
  });

  it("rejects a note over the max length", () => {
    const note = "x".repeat(LIMITS.transactionNoteMax + 1);
    expect(transactionFormSchema.safeParse({ ...valid, note }).success).toBe(false);
  });

  it("rejects an unsupported transaction type", () => {
    expect(transactionFormSchema.safeParse({ ...valid, type: "transfer" }).success).toBe(false);
  });

  it("surfaces the amount error message on the amount path", () => {
    const result = transactionFormSchema.safeParse({ ...valid, amount: "0" });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === "amount");
      expect(issue?.message).toBe("Amount must be greater than zero");
    }
  });

  it("rejects an invalid date format", () => {
    expect(transactionFormSchema.safeParse({ ...valid, date: "15-05-2026" }).success).toBe(false);
  });

  it("requires at least one category", () => {
    expect(transactionFormSchema.safeParse({ ...valid, categoryIds: [] }).success).toBe(false);
  });

  it("rejects duplicate categories", () => {
    expect(transactionFormSchema.safeParse({ ...valid, categoryIds: ["c", "c"] }).success).toBe(
      false,
    );
  });

  it("rejects more than the max categories", () => {
    const categoryIds = Array.from(
      { length: LIMITS.maxCategoriesPerTransaction + 1 },
      (_, i) => `c${i}`,
    );
    expect(transactionFormSchema.safeParse({ ...valid, categoryIds }).success).toBe(false);
  });
});

describe("toMutationArgs (form → mutation transform)", () => {
  const values = {
    type: "expense" as const,
    title: "Lunch",
    amount: "12.5",
    date: "2026-05-15",
    categoryIds: ["cat-1", "cat-2"],
    paidByMemberId: "mem-other",
  };

  it("parses the amount string into positive minor units", () => {
    expect(toMutationArgs(values, "mem-self").amountMinorUnits).toBe(1250);
  });

  it("preserves the category ids in order", () => {
    expect(toMutationArgs(values, "mem-self").categoryIds).toEqual(["cat-1", "cat-2"]);
  });

  it("keeps an explicit Paid By that differs from self", () => {
    expect(toMutationArgs(values, "mem-self").paidByMemberId).toBe("mem-other");
  });

  it("omits Paid By when it equals self so the server defaults it", () => {
    expect(
      toMutationArgs({ ...values, paidByMemberId: "mem-self" }, "mem-self").paidByMemberId,
    ).toBe(undefined);
  });

  it("omits Paid By when the form never picked anyone", () => {
    expect(toMutationArgs({ ...values, paidByMemberId: "" }, "mem-self").paidByMemberId).toBe(
      undefined,
    );
  });

  it("drops an empty / whitespace-only note", () => {
    expect(toMutationArgs({ ...values, note: "   " }, "mem-self").note).toBe(undefined);
    expect("note" in toMutationArgs({ ...values, note: "" }, "mem-self")).toBe(false);
  });

  it("keeps and trims a real note", () => {
    expect(toMutationArgs({ ...values, note: "  team lunch  " }, "mem-self").note).toBe(
      "team lunch",
    );
  });

  it("throws on an amount that never passed the form schema", () => {
    expect(() => toMutationArgs({ ...values, amount: "0" }, "mem-self")).toThrow(
      /greater than zero/,
    );
  });
});

describe("transactionCreateSchema (server contract)", () => {
  const valid = {
    type: "expense",
    title: "Lunch",
    amountMinorUnits: 1250,
    date: "2026-05-15",
    categoryIds: ["cat-1"],
  } as const;

  it("accepts a well-formed payload without an explicit paidByMemberId", () => {
    const parsed = transactionCreateSchema.parse(valid);
    expect(parsed.amountMinorUnits).toBe(1250);
    expect(parsed.paidByMemberId).toBeUndefined();
  });

  it("accepts the maximum amount and an explicit paidByMemberId", () => {
    expect(
      transactionCreateSchema.safeParse({
        ...valid,
        amountMinorUnits: MAX_AMOUNT_MINOR,
        paidByMemberId: "mem-2",
      }).success,
    ).toBe(true);
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["non-integer", 12.5],
    ["one minor unit over max", MAX_AMOUNT_MINOR + 1],
  ])("rejects a %s amount", (_label, amountMinorUnits) => {
    expect(transactionCreateSchema.safeParse({ ...valid, amountMinorUnits }).success).toBe(false);
  });

  it("rejects an invalid date", () => {
    expect(transactionCreateSchema.safeParse({ ...valid, date: "2026-13-01" }).success).toBe(false);
  });

  it("rejects zero categories and duplicates", () => {
    expect(transactionCreateSchema.safeParse({ ...valid, categoryIds: [] }).success).toBe(false);
    expect(transactionCreateSchema.safeParse({ ...valid, categoryIds: ["x", "x"] }).success).toBe(
      false,
    );
  });

  it("trims the title and treats an empty trimmed note as still valid", () => {
    const parsed = transactionCreateSchema.parse({ ...valid, title: "  Lunch  ", note: "  " });
    expect(parsed.title).toBe("Lunch");
    expect(parsed.note).toBe("");
  });
});

describe("transactionUpdateSchema (server contract)", () => {
  it("accepts an empty payload (all fields optional ≡ no-op edit)", () => {
    const parsed = transactionUpdateSchema.parse({});
    expect(parsed).toEqual({});
  });

  it("accepts a single changed field", () => {
    expect(transactionUpdateSchema.parse({ title: "  New title  " }).title).toBe("New title");
    expect(transactionUpdateSchema.parse({ amountMinorUnits: 999 }).amountMinorUnits).toBe(999);
    expect(transactionUpdateSchema.parse({ date: "2026-06-01" }).date).toBe("2026-06-01");
    expect(transactionUpdateSchema.parse({ type: "income" }).type).toBe("income");
  });

  it("treats an empty note as the explicit clear signal, not absence", () => {
    const parsed = transactionUpdateSchema.parse({ note: "   " });
    expect(parsed.note).toBe(""); // present-but-empty, distinct from undefined
    expect(transactionUpdateSchema.parse({}).note).toBeUndefined();
  });

  it("validates each present field by the same rule as create", () => {
    expect(transactionUpdateSchema.safeParse({ title: "" }).success).toBe(false);
    expect(transactionUpdateSchema.safeParse({ title: "x".repeat(121) }).success).toBe(false);
    expect(transactionUpdateSchema.safeParse({ note: "x".repeat(1001) }).success).toBe(false);
    expect(transactionUpdateSchema.safeParse({ date: "2026-13-01" }).success).toBe(false);
    expect(transactionUpdateSchema.safeParse({ amountMinorUnits: 0 }).success).toBe(false);
    expect(transactionUpdateSchema.safeParse({ amountMinorUnits: 12.5 }).success).toBe(false);
    expect(
      transactionUpdateSchema.safeParse({ amountMinorUnits: MAX_AMOUNT_MINOR + 1 }).success,
    ).toBe(false);
  });

  it("keeps the ≥1 / no-duplicate Category rule for a present categoryIds", () => {
    expect(transactionUpdateSchema.safeParse({ categoryIds: [] }).success).toBe(false);
    expect(transactionUpdateSchema.safeParse({ categoryIds: ["a", "a"] }).success).toBe(false);
    expect(transactionUpdateSchema.safeParse({ categoryIds: ["a", "b"] }).success).toBe(true);
  });
});

describe("colorLabel", () => {
  it("maps a palette id to its display name", () => {
    expect(colorLabel("blue")).toBe("Blue");
    expect(colorLabel("green")).toBe("Green");
  });

  it("falls back to the id when unknown", () => {
    expect(colorLabel("chartreuse")).toBe("chartreuse");
  });
});

describe("isTransactionType", () => {
  it("accepts supported transaction types", () => {
    expect(isTransactionType("expense")).toBe(true);
    expect(isTransactionType("income")).toBe(true);
  });

  it("rejects unknown values", () => {
    expect(isTransactionType("refund")).toBe(false);
    expect(isTransactionType("")).toBe(false);
  });
});
