import { describe, expect, it } from "vitest";
import { filterOptionsQueryEnabled } from "./ledger.js";

describe("filterOptionsQueryEnabled", () => {
  const empty = { categories: [], recordedBy: [], paidBy: [] };

  it("is true when the filter panel is open", () => {
    expect(filterOptionsQueryEnabled(true, empty)).toBe(true);
  });

  it("is false when the panel is closed and no id filters are applied", () => {
    expect(filterOptionsQueryEnabled(false, empty)).toBe(false);
  });

  it("stays true when URL has category or member ids (scrub needs options)", () => {
    expect(filterOptionsQueryEnabled(false, { ...empty, categories: ["c1"] })).toBe(true);
    expect(filterOptionsQueryEnabled(false, { ...empty, recordedBy: ["m1"] })).toBe(true);
    expect(filterOptionsQueryEnabled(false, { ...empty, paidBy: ["m2"] })).toBe(true);
  });
});
