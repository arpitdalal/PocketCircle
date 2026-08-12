import { buildRef } from "@pocketcircle/domain";
import { describe, expect, it } from "vitest";
import { parseCategoryRef } from "./refs.js";

describe("parseCategoryRef", () => {
  it("returns null for an empty ref", () => {
    expect(parseCategoryRef(undefined)).toBeNull();
    expect(parseCategoryRef("")).toBeNull();
  });

  it("parses a slug-id category ref", () => {
    expect(parseCategoryRef(buildRef("Groceries", "cat1"))).toEqual({
      id: "cat1",
      slug: "groceries",
    });
  });

  it("returns null when the id segment fails validation", () => {
    expect(parseCategoryRef("groceries-!")).toBeNull();
  });
});
