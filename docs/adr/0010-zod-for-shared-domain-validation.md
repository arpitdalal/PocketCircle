# Zod for shared domain validation

PocketCircle uses Zod in `packages/domain` for shared form-facing validation schemas and pure domain constants, while Convex functions still validate inputs at the backend boundary with Convex validators. This keeps client and shared helper validation reusable without weakening server-side enforcement.
