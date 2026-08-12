import { mutationErrorDataSchema, mutationErrorMessageForCode } from "@pocketcircle/domain";
import { ConvexError } from "convex/values";

/**
 * Convex redacts plain server errors to a generic "Server Error" in production;
 * ConvexError data survives. User-facing mutation errors therefore cross the
 * boundary as stable codes, and the client maps known codes to shared copy.
 */
export function mutationErrorCode(error: unknown) {
  if (!(error instanceof ConvexError)) {
    return null;
  }

  const parsed = mutationErrorDataSchema.safeParse(error.data);
  return parsed.success ? parsed.data.code : null;
}

export function mutationErrorMessageForUser(error: unknown, fallback: string) {
  const code = mutationErrorCode(error);
  return code ? (mutationErrorMessageForCode(code) ?? fallback) : fallback;
}
