import { describe, expect, it } from "vitest";
import {
  MUTATION_ERRORS,
  mutationErrorData,
  mutationErrorDataSchema,
  mutationErrorMessageForCode,
} from "./mutation-errors.js";

describe("mutation-errors", () => {
  it("accepts every catalog code in mutationErrorDataSchema", () => {
    for (const error of Object.values(MUTATION_ERRORS)) {
      const parsed = mutationErrorDataSchema.safeParse(mutationErrorData(error));
      expect(parsed.success, error.code).toBe(true);
      if (parsed.success) {
        expect(parsed.data.code).toBe(error.code);
      }
    }
  });

  it("rejects unknown codes", () => {
    expect(mutationErrorDataSchema.safeParse({ code: "category.notFound" }).success).toBe(false);
  });

  it("maps catalog codes to shared messages", () => {
    for (const error of Object.values(MUTATION_ERRORS)) {
      expect(mutationErrorMessageForCode(error.code)).toBe(error.message);
    }
    expect(mutationErrorMessageForCode("category.notFound")).toBe(null);
  });

  it("defines the generic Circle setup incomplete error", () => {
    expect(MUTATION_ERRORS.circleSetupIncomplete).toEqual({
      code: "circle.setupIncomplete",
      message: "Finish setting up this Circle before continuing",
    });
    expect(MUTATION_ERRORS).not.toHaveProperty("inviteSetupIncomplete");
  });
});
