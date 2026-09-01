import { z } from "zod";
import { isValidCircleSettingsColorId, isValidColorId } from "./color.js";
import { isSupportedCurrency } from "./currency.js";
import { isValidPlainDate } from "./date.js";
import { type AmountParseError, isValidMinorUnits, parseAmountToMinorUnits } from "./money.js";
import { circleSetupAnswersSchema } from "./setup.js";

/**
 * Shared form-facing validation. These Zod schemas (ADR 0010) are reused by the
 * web app and any future client. Convex functions still re-validate inputs at
 * the backend boundary with Convex validators — these never replace server-side
 * enforcement (ADR 0015).
 */
export const TRANSACTION_TYPES = ["expense", "income"] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export function isTransactionType(value: string): value is TransactionType {
  return TRANSACTION_TYPES.some((type) => type === value);
}

const NAME_MAX = 60;

export const LIMITS = {
  circleNameMax: NAME_MAX,
  /** User display name (USR-1); same bound as circle names today, distinct concept. */
  displayNameMax: NAME_MAX,
  emailMax: 254,
  categoryNameMax: 40,
  transactionTitleMax: 120,
  transactionNoteMax: 1_000,
  feedbackMessageMax: 4_000,
  maxCategoriesPerTransaction: 10,
} as const;

export const FEEDBACK_TYPES = ["bug", "feature", "currency"] as const;
export type FeedbackType = (typeof FEEDBACK_TYPES)[number];

export function isFeedbackType(value: string): value is FeedbackType {
  return FEEDBACK_TYPES.some((type) => type === value);
}

/** Server-facing feedback input (FBK-1). */
export const feedbackInputSchema = z.object({
  type: z.enum(FEEDBACK_TYPES),
  message: z
    .string()
    .trim()
    .min(1, "Message is required")
    .max(LIMITS.feedbackMessageMax, "Message is too long"),
});
export type FeedbackInput = z.infer<typeof feedbackInputSchema>;

export type FeedbackInputParseResult =
  | { ok: true; value: FeedbackInput }
  | { ok: false; error: string };

/** Shared feedback parse contract for client forms and Convex mutations (FBK-1). */
export function parseFeedbackInput(input: {
  type: string;
  message: string;
}): FeedbackInputParseResult {
  const parsed = feedbackInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid feedback",
    };
  }
  return { ok: true, value: parsed.data };
}

/** Server-facing feedback submission including build metadata (FBK-1). */
export const feedbackSubmissionSchema = feedbackInputSchema.extend({
  appVersion: z.string().trim().min(1, "App version is required"),
});
export type FeedbackSubmission = z.infer<typeof feedbackSubmissionSchema>;

/** Convex mutation boundary — validates raw type and app version. */
export function parseFeedbackSubmission(input: {
  type: string;
  message: string;
  appVersion: string;
}) {
  const parsed = feedbackSubmissionSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false as const,
      error: parsed.error.issues[0]?.message ?? "Invalid feedback",
    };
  }
  return { ok: true as const, value: parsed.data };
}

const colorId = z.string().refine(isValidColorId, { message: "Unsupported color" });

/** Server-facing profile edit input (USR-1). */
export const profileUpdateSchema = z.object({
  displayName: z.string().trim().min(1, "Name is required").max(LIMITS.displayNameMax),
});
export type ProfileUpdateInput = z.infer<typeof profileUpdateSchema>;

/** Canonical email for storage and comparison: trim + lowercase. */
export function canonicalEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Server-and-client-shared invite email input (MEM-2). Parsed `email` is canonical `emailLower`. */
export const inviteEmailSchema = z.object({
  email: z.preprocess(
    canonicalEmail,
    z.string().email("Enter a valid email address").max(LIMITS.emailMax, "Email is too long"),
  ),
});
export type InviteEmailInput = z.infer<typeof inviteEmailSchema>;

export type ProfileUpdateParseResult =
  | { ok: true; value: ProfileUpdateInput }
  | { ok: false; error: string };

/** Shared profile-edit parse contract for client forms and Convex mutations (USR-1). */
export function parseProfileUpdate(input: { displayName: string }): ProfileUpdateParseResult {
  const parsed = profileUpdateSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid display name",
    };
  }
  return { ok: true, value: parsed.data };
}

export const circleInputSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(LIMITS.circleNameMax),
  currency: z.string().refine(isSupportedCurrency, { message: "Unsupported currency" }),
  color: colorId,
  mark: z.string().trim().min(1).max(2),
});
export type CircleInput = z.infer<typeof circleInputSchema>;

export const categoryInputSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(LIMITS.categoryNameMax),
  type: z.enum(TRANSACTION_TYPES),
  color: colorId,
});
/**
 * Form-bound Category create values — Standard Schema *input* of
 * {@link categoryInputSchema}. Distinct from {@link CategoryInput} (output)
 * because `colorId`'s type-predicate refine keeps Color as `string` on the way
 * in and narrows to a palette id on the way out; TanStack Form's values must
 * match the input side to use this schema as an `onSubmit` validator (ADR 0020).
 */
export type CategoryFormValues = z.input<typeof categoryInputSchema>;
export type CategoryInput = z.infer<typeof categoryInputSchema>;

/**
 * Server-facing edit-Category input (ADR 0010), the CAT-2 counterpart to
 * {@link categoryInputSchema}. Both fields are optional: an absent field means
 * "leave it unchanged", and each present field is validated by the SAME rule as on
 * create so the two entry points can't drift. `type` is deliberately absent — a
 * Category's type is immutable (Expense and Income Categories never convert; a
 * Transaction Type Change clears Categories instead).
 */
export const categoryUpdateSchema = z.object({
  name: categoryInputSchema.shape.name.optional(),
  color: colorId.optional(),
});
export type CategoryUpdateInput = z.infer<typeof categoryUpdateSchema>;

/**
 * Server-facing Circle Settings input (CS-2), parallel to {@link categoryUpdateSchema}.
 * Both fields are optional: an absent field means "leave it unchanged", and each present
 * field is validated by the same rule as on create/setup so the entry points can't drift.
 * Personal Circles may also select the reserved iris color; regular Circles may not.
 */
export const circleSettingsUpdateSchema = z.object({
  color: colorId.optional(),
  setupAnswers: circleSetupAnswersSchema.optional(),
});
export type CircleSettingsUpdateInput = z.infer<typeof circleSettingsUpdateSchema>;

/** Kind-aware CS-2 parse — iris is valid only for Personal Circles. */
export function parseCircleSettingsUpdate(
  input: { color?: string; setupAnswers?: z.input<typeof circleSetupAnswersSchema> },
  kind: "personal" | "regular",
) {
  const colorForKind = z
    .string()
    .refine((id) => isValidCircleSettingsColorId(id, kind), { message: "Unsupported color" })
    .optional();

  return z
    .object({
      color: colorForKind,
      setupAnswers: circleSetupAnswersSchema.optional(),
    })
    .parse(input);
}

/**
 * The Transaction fields shared by the form schema and the server-facing create
 * schema. Factoring them here keeps the two entry points (form: amount as a
 * string; backend: amount already parsed to minor units) from drifting on title
 * length, note bounds, the type enum, the date format, or the ≥1 / no-duplicate
 * Category rule (PRD stories 50–52).
 */
const transactionFields = {
  type: z.enum(TRANSACTION_TYPES),
  title: z.string().trim().min(1, "Title is required").max(LIMITS.transactionTitleMax),
  note: z.string().trim().max(LIMITS.transactionNoteMax).optional(),
  date: z.string().refine(isValidPlainDate, { message: "Invalid date" }),
  categoryIds: z
    .array(z.string())
    .min(1, "Pick at least one category")
    .max(LIMITS.maxCategoriesPerTransaction)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "Duplicate categories are not allowed",
    }),
} as const;

/**
 * The amount field as entered in the form: a major-unit string that must parse to
 * positive integer minor units. Kept as its own schema (no transform) so the form
 * can validate it per-field on blur and surface the precise failure (empty vs zero
 * vs over-precision) on the `amount` path — see {@link transactionFieldSchemas}.
 * The major→minor conversion itself happens later, explicitly, in
 * {@link toMutationArgs}; validation and transformation stay separate seams (ADR 0020).
 */
const amountField = z.string().superRefine((value, ctx) => {
  const parsed = parseAmountToMinorUnits(value);
  if (!parsed.ok) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: amountErrorMessage(parsed.error) });
  }
});

/**
 * The note field as entered in the form: always a (possibly empty) string, since a
 * controlled textarea is never absent. Distinct from the entity's optional note
 * ({@link transactionFields}) so the form schema's shape matches the form's values
 * exactly — an empty note is dropped later by {@link toMutationArgs}, not modeled as
 * `undefined` here.
 */
const noteField = z.string().trim().max(LIMITS.transactionNoteMax);

/**
 * Transaction input as entered in the form — a PURE validation schema with no
 * transform (ADR 0020). It validates the shape the form binds to (amount as a
 * major-unit string, `paidByMemberId` as an opaque member id or "" for self); it
 * does not reshape into mutation args. Per-field slices ({@link transactionFieldSchemas})
 * drive on-blur validation, this whole schema is the submit-time gate, and
 * {@link toMutationArgs} performs the form→server transform separately.
 */
export const transactionFormSchema = z.object({
  ...transactionFields,
  note: noteField,
  amount: amountField,
  paidByMemberId: z.string(),
});
export type TransactionFormValues = z.infer<typeof transactionFormSchema>;

/**
 * Per-field validation slices, so the form (web today, native later) can validate
 * a single field on blur and feed the resulting Standard-Schema issues straight to
 * a `FieldError` without re-deriving rules. They are the same constraints
 * {@link transactionFormSchema} enforces at submit, never a drifting copy.
 */
export const transactionFieldSchemas = {
  title: transactionFields.title,
  amount: amountField,
  date: transactionFields.date,
  categoryIds: transactionFields.categoryIds,
  note: noteField,
} as const;

/**
 * Mutation args produced from validated form values. Generic over the caller's id
 * types so a branded `Id<"categories">` / `Id<"members">` flows through unchanged —
 * the web/native seam passes branded ids in and gets branded ids out, with no cast,
 * while this module stays free of any Convex import.
 */
export interface TransactionMutationArgs<CategoryId extends string, MemberId extends string> {
  type: TransactionType;
  title: string;
  note?: string;
  amountMinorUnits: number;
  date: string;
  categoryIds: CategoryId[];
  paidByMemberId?: MemberId;
}

/**
 * Transforms validated form values into create-Transaction mutation args (ADR 0020):
 * parses the major-unit amount to minor units, drops an empty note, and collapses a
 * Paid By that equals the caller's own Member to `undefined` so the server defaults
 * it to Recorded By (PRD story 36). Expects values that already passed
 * {@link transactionFormSchema}; it re-parses the amount defensively and throws on a
 * value that somehow didn't.
 */
export function toMutationArgs<CategoryId extends string, MemberId extends string>(
  values: {
    type: TransactionType;
    title: string;
    note?: string;
    amount: string;
    date: string;
    categoryIds: readonly CategoryId[];
    paidByMemberId: MemberId | "";
  },
  selfMemberId: MemberId | "",
): TransactionMutationArgs<CategoryId, MemberId> {
  const parsed = parseAmountToMinorUnits(values.amount);
  if (!parsed.ok) {
    throw new Error(amountErrorMessage(parsed.error));
  }

  const trimmedNote = values.note?.trim();
  const note = trimmedNote && trimmedNote.length > 0 ? trimmedNote : undefined;

  // "" means the form never picked anyone, so fall back to self; then omit a Paid By
  // that is self so the server applies its own default rather than us pinning it.
  const effective = values.paidByMemberId || selfMemberId;
  const paidByMemberId = effective && effective !== selfMemberId ? effective : undefined;

  return {
    type: values.type,
    title: values.title,
    ...(note ? { note } : {}),
    amountMinorUnits: parsed.minorUnits,
    date: values.date,
    categoryIds: [...values.categoryIds],
    ...(paidByMemberId ? { paidByMemberId } : {}),
  };
}

/**
 * Server-facing create-Transaction input (ADR 0010). The amount has already been
 * parsed to positive integer minor units at the client boundary, so this schema
 * re-asserts it is a valid minor-unit integer (`isValidMinorUnits`) rather than
 * re-parsing a string; `paidByMemberId` is optional because the handler defaults
 * it to the Recorded By Member. Convex re-validates id/shape at its own boundary
 * (ADR 0015); this enforces the cross-field invariants Convex validators can't.
 */
export const transactionCreateSchema = z.object({
  ...transactionFields,
  amountMinorUnits: z
    .number()
    .refine(isValidMinorUnits, { message: "Amount must be a positive value within range" }),
  paidByMemberId: z.string().optional(),
});
export type TransactionCreateInput = z.infer<typeof transactionCreateSchema>;

/**
 * Server-facing edit-Transaction input (ADR 0010), the TXN-2 counterpart to
 * {@link transactionCreateSchema}. Every field is optional: an absent field means
 * "leave it unchanged", and each present field is validated by the SAME rule as on
 * create (title/note bounds, the date format, the ≥1 / no-duplicate Category rule,
 * the minor-unit amount) so the two entry points can't drift. A present `note` of
 * `""` is the explicit "clear the note" signal — distinct from omitting it.
 *
 * Two cross-field invariants this schema deliberately does NOT encode, because they
 * need state it can't see and so live in the handler (ADR 0015): that a Transaction
 * Type Change must arrive WITH ≥1 active Category of the new type (the schema has no
 * current type to compare against), and that a newly-added Category must be active
 * while an already-attached archived one may stay (the schema has no current
 * attachments). Both are enforced server-side against the loaded Transaction.
 */
export const transactionUpdateSchema = z.object({
  type: z.enum(TRANSACTION_TYPES).optional(),
  title: transactionFields.title.optional(),
  note: transactionFields.note,
  date: transactionFields.date.optional(),
  amountMinorUnits: z
    .number()
    .refine(isValidMinorUnits, { message: "Amount must be a positive value within range" })
    .optional(),
  categoryIds: transactionFields.categoryIds.optional(),
  paidByMemberId: z.string().optional(),
});
export type TransactionUpdateInput = z.infer<typeof transactionUpdateSchema>;

function amountErrorMessage(error: AmountParseError): string {
  switch (error) {
    case "empty":
      return "Amount is required";
    case "not-a-number":
      return "Amount must be a number";
    case "negative":
      return "Amount must be positive";
    case "zero":
      return "Amount must be greater than zero";
    case "too-many-decimals":
      return "Amount supports at most two decimals";
    case "too-large":
      return "Amount is too large";
    default:
      return "Invalid amount";
  }
}
