import { MUTATION_ERRORS, mutationErrorData } from "@pocketcircle/domain";
import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";
import { mutationErrorCode, mutationErrorMessageForUser } from "./mutation-user-message.js";

describe("mutationErrorMessageForUser", () => {
  it("maps known ConvexError codes to shared messages", () => {
    expect(
      mutationErrorMessageForUser(
        new ConvexError(mutationErrorData(MUTATION_ERRORS.circleArchived)),
        "fallback",
      ),
    ).toBe(MUTATION_ERRORS.circleArchived.message);
    expect(
      mutationErrorMessageForUser(
        new ConvexError(mutationErrorData(MUTATION_ERRORS.categoryNameDuplicate)),
        "fallback",
      ),
    ).toBe(MUTATION_ERRORS.categoryNameDuplicate.message);
  });

  it("returns known ConvexError codes", () => {
    expect(
      mutationErrorCode(new ConvexError(mutationErrorData(MUTATION_ERRORS.categoryNameDuplicate))),
    ).toBe(MUTATION_ERRORS.categoryNameDuplicate.code);
  });

  it("maps plain Errors and unlisted ConvexErrors to the fallback", () => {
    expect(mutationErrorMessageForUser(new Error("Server Error"), "fallback")).toBe("fallback");
    expect(
      mutationErrorMessageForUser(new ConvexError({ code: "category.notFound" }), "fallback"),
    ).toBe("fallback");
    expect(
      mutationErrorMessageForUser(
        new ConvexError(MUTATION_ERRORS.categoryNameDuplicate.message),
        "fallback",
      ),
    ).toBe("fallback");
  });

  it("ignores malformed ConvexError data", () => {
    expect(mutationErrorCode(new ConvexError(MUTATION_ERRORS.circleArchived.message))).toBe(null);
    expect(
      mutationErrorCode(
        new ConvexError({
          code: MUTATION_ERRORS.circleArchived.code,
          message: MUTATION_ERRORS.circleArchived.message,
        }),
      ),
    ).toBe(MUTATION_ERRORS.circleArchived.code);
    expect(
      mutationErrorCode(
        new ConvexError({
          message: MUTATION_ERRORS.circleArchived.message,
        }),
      ),
    ).toBe(null);
  });
});
