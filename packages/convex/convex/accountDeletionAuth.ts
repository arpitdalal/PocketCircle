import { z } from "zod";

/** Better Auth user fields we need for Account Deletion (mapped app userId). */
export const betterAuthMappedUserSchema = z.object({
  email: z.string().min(1),
  userId: z.string().min(1),
  name: z.string().optional(),
});

export function parseBetterAuthMappedUser(user: unknown) {
  return betterAuthMappedUserSchema.parse(user);
}
