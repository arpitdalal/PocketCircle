import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * PocketCircle data model. Better Auth owns its own user/session tables inside
 * the `betterAuth` component (see convex.config.ts); the app `users` table here
 * stores the PocketCircle profile keyed by the auth subject. All permission and
 * lifecycle enforcement lives in Convex functions (ADR 0015), and money is
 * stored as positive integer minor units (ADR 0009).
 */

const transactionType = v.union(v.literal("expense"), v.literal("income"));
const lifecycleStatus = v.union(v.literal("active"), v.literal("archived"));
const circleSetupAnswers = v.object({
  purpose: v.optional(
    v.union(
      v.literal("residence"),
      v.literal("trip"),
      v.literal("family"),
      v.literal("roommates"),
      v.literal("project"),
      v.literal("personal"),
      v.literal("other"),
    ),
  ),
  residenceType: v.optional(v.union(v.literal("leased"), v.literal("owned"))),
});

export default defineSchema({
  // PocketCircle User profile. The Better Auth component owns the auth user and
  // the auth-user → app-user mapping (ADR 0002); this row is created by the
  // `onCreateUser` trigger in auth.ts and resolved via `authComponent.getAuthUser`.
  users: defineTable({
    email: v.string(),
    displayName: v.string(),
    image: v.optional(v.string()),
    // Legal acceptance captured on first sign-in (ADR 0014).
    acceptedTermsVersion: v.string(),
    acceptedPrivacyVersion: v.string(),
    acceptedAt: v.number(),
    // Product-analytics preference (ADR 0013); operational monitoring is unaffected.
    analyticsEnabled: v.boolean(),
    // null until Onboarding completes; a number means the User confirmed their profile (USR-1).
    onboardingCompletedAt: v.union(v.number(), v.null()),
    // Set when the Welcome email is claimed/sent (EML-1); absent ⇒ not yet sent.
    welcomeSentAt: v.optional(v.number()),
    // Feature Announcement IDs the User acknowledged via CTA or close (#282).
    // Missing ≡ none. Allowed values are the shared domain registry.
    acknowledgedFeatureAnnouncementIds: v.optional(v.array(v.string())),
    /**
     * Stable opaque MCP principal (Worker's OAuth `userId`) for this User (#317).
     * One principal per User so Cloudflare grant replacement and coordinated
     * revoke recognize reauthorizations as the same identity. Missing until the
     * first pending MCP grant is created.
     */
    mcpPrincipalId: v.optional(v.string()),
    createdAt: v.number(),
  }).index("by_email", ["email"]),

  circles: defineTable({
    name: v.string(),
    kind: v.union(v.literal("personal"), v.literal("regular")),
    currency: v.string(),
    color: v.string(),
    mark: v.string(),
    ownerUserId: v.id("users"),
    // Immutable creating User (Activation “created a regular Circle”). Distinct from
    // mutable `ownerUserId` (transferOwnership). Always written on insert.
    creatorUserId: v.id("users"),
    status: lifecycleStatus,
    setupAnswers: v.optional(circleSetupAnswers),
    // Workflow milestone: timestamp when complete; null means incomplete regular Circle.
    setupCompletedAt: v.union(v.number(), v.null()),
    // Indexed twin of `setupCompletedAt !== null` for bounded Activation member-CTA
    // reads. Always written with `circleSetupFields`.
    setupComplete: v.boolean(),
    // Currency is locked once any Transaction exists (PRD story 9).
    currencyLocked: v.boolean(),
    // Denormalized Account Deletion readiness (USR-3 / ADR 0029): finalization
    // proves no blockers with one indexed `.first()`.
    accountDeletionBlocked: v.boolean(),
    accountDeletionBlockerAction: v.optional(v.union(v.literal("archive"), v.literal("transfer"))),
    createdAt: v.number(),
    archivedAt: v.optional(v.number()),
    // Set when the owner manually renames their Personal Circle; absent ⇒ the name
    // auto-tracks the owner's Display Name (USR-1). Personal Circles only.
    personalNameCustomizedAt: v.optional(v.number()),
  })
    .index("by_owner", ["ownerUserId"])
    .index("by_owner_and_kind", ["ownerUserId", "kind"])
    .index("by_owner_and_status", ["ownerUserId", "status"])
    .index("by_owner_and_account_deletion_blocked", ["ownerUserId", "accountDeletionBlocked"])
    // Activation Checklist member-CTA: earliest active regular Circle in a setup lane.
    .index("by_owner_kind_status_setupComplete_createdAt", [
      "ownerUserId",
      "kind",
      "status",
      "setupComplete",
      "createdAt",
    ])
    // Activation evidence: earliest regular Circle this User created (transfer-safe).
    .index("by_creatorUserId_kind_createdAt", ["creatorUserId", "kind", "createdAt"]),

  // Membership join. Exactly one row per (circleId, userId): leaving flips
  // status to "removed", rejoining reactivates the SAME row — never a duplicate
  // (the by_circle_and_user .unique() lookup depends on this). PRD stories 42–44.
  //
  // `displayName`/`image` are the per-Circle MATERIALIZED identity, not a
  // one-time snapshot (ADR 0018): in-app profile edits mirror the User's owned
  // Display Name onto ACTIVE member rows via `setUserDisplayName` (USR-1 / ADR 0024),
  // freeze them while the Member is "removed", and refresh on rejoin.
  // Paid By / Recorded By and the Member List read this materialized identity
  // (active ⇒ current, removed ⇒ frozen); the immutable history does not — it
  // keeps the name as it read when each event was written (ADR 0018).
  //
  // `deleted` is Account Deletion's Historical Member tombstone (USR-3 / ADR 0029):
  // Display Name kept, image cleared, never reconnected to a future User.
  members: defineTable({
    circleId: v.id("circles"),
    userId: v.id("users"),
    role: v.union(v.literal("owner"), v.literal("member")),
    status: v.union(v.literal("active"), v.literal("removed"), v.literal("deleted")),
    displayName: v.string(),
    image: v.optional(v.string()),
    joinedAt: v.number(),
    removedAt: v.optional(v.number()),
    deletedAt: v.optional(v.number()),
  })
    .index("by_circle", ["circleId"])
    .index("by_circle_and_status", ["circleId", "status"])
    .index("by_user", ["userId"])
    .index("by_user_and_status", ["userId", "status"])
    .index("by_circle_and_user", ["circleId", "userId"]),

  categories: defineTable({
    circleId: v.id("circles"),
    name: v.string(),
    // Lowercased name for case-insensitive uniqueness per Circle+type, including
    // archived names (PRD stories 49, 54).
    nameLower: v.string(),
    type: transactionType,
    color: v.string(),
    creatorUserId: v.id("users"),
    status: lifecycleStatus,
    createdAt: v.number(),
    archivedAt: v.optional(v.number()),
  })
    .index("by_circle", ["circleId"])
    // Activation evidence backfill: earliest Category in a Personal Circle (any
    // type). Regular-Circle history is not credited on initialize (GH-273).
    .index("by_circle_createdAt", ["circleId", "createdAt"])
    // The Category Filter's paginated reads sort on the domain `createdAt` (set
    // explicitly at create, so it can diverge from `_creationTime`) — the sort
    // key must live in the index (CAT-4). `by_circle_type_createdAt` supersedes
    // the old `by_circle_and_type` (same prefix) and serves the status=all page;
    // the status index serves the active-only / archived-only pages.
    .index("by_circle_type_createdAt", ["circleId", "type", "createdAt"])
    .index("by_circle_type_status_createdAt", ["circleId", "type", "status", "createdAt"])
    .index("by_circle_type_name", ["circleId", "type", "nameLower"]),

  transactions: defineTable({
    circleId: v.id("circles"),
    type: transactionType,
    title: v.string(),
    note: v.optional(v.string()),
    amountMinorUnits: v.number(),
    // Plain date "YYYY-MM-DD" and its "YYYY-MM" bucket; no timezone conversion
    // (PRD story 33).
    date: v.string(),
    month: v.string(),
    recordedByMemberId: v.id("members"),
    paidByMemberId: v.id("members"),
    status: lifecycleStatus,
    createdAt: v.number(),
    updatedAt: v.number(),
    archivedAt: v.optional(v.number()),
  })
    .index("by_circle", ["circleId"])
    // Activation evidence: earliest Transaction by domain createdAt.
    .index("by_circle_createdAt", ["circleId", "createdAt"])
    .index("by_circle_and_status", ["circleId", "status"])
    .index("by_circle_and_month", ["circleId", "month"])
    .index("by_circle_and_date", ["circleId", "date"])
    // Orders a Circle's Transactions of one status by Transaction Date, so the
    // active Ledger paginates date-desc (then created-at desc via _creationTime)
    // straight off the index — no in-memory sort of an unbounded set.
    .index("by_circle_status_date", ["circleId", "status", "date"])
    // Newest active Transaction by record time (Feature Announcement CTA source, #282).
    .index("by_circle_status_createdAt", ["circleId", "status", "createdAt"])
    // Ranges one Member's Transactions of one status by Transaction Date. Backs the
    // Dashboard's Paid By filter (RPT-3): the per-Member month totals/recent range
    // this index at the source instead of scanning the whole month and filtering in
    // memory, and the filter's removed-Member options test "is this removed Member
    // Paid By on any active Transaction?" with a single `.first()` lookup. Also serves
    // Search's Paid By facet (RPT-2).
    .index("by_circle_paidby_status_date", ["circleId", "paidByMemberId", "status", "date"])
    // Search's Recorded By facet needs the same bounded date/status access pattern
    // as Paid By, but keyed by creator membership instead.
    .index("by_circle_recordedby_status_date", [
      "circleId",
      "recordedByMemberId",
      "status",
      "date",
    ]),

  // Search-index projection for Transactions (GH-91). Kept in its own table so
  // adding full-text search does not require a breaking required-field migration
  // on existing Transaction rows. All write paths sync this row transactionally.
  transactionSearchDocuments: defineTable({
    transactionId: v.id("transactions"),
    circleId: v.id("circles"),
    searchText: v.string(),
    type: transactionType,
    status: lifecycleStatus,
    recordedByMemberId: v.id("members"),
    paidByMemberId: v.id("members"),
    categoryId0: v.optional(v.id("categories")),
    categoryId1: v.optional(v.id("categories")),
    categoryId2: v.optional(v.id("categories")),
    categoryId3: v.optional(v.id("categories")),
    categoryId4: v.optional(v.id("categories")),
    categoryId5: v.optional(v.id("categories")),
    categoryId6: v.optional(v.id("categories")),
    categoryId7: v.optional(v.id("categories")),
    categoryId8: v.optional(v.id("categories")),
    categoryId9: v.optional(v.id("categories")),
    date: v.string(),
    amountMinorUnits: v.number(),
  })
    .index("by_transaction", ["transactionId"])
    .index("by_circle", ["circleId"])
    .searchIndex("search_text", {
      searchField: "searchText",
      filterFields: ["circleId", "status", "type", "paidByMemberId", "recordedByMemberId"],
    }),
  // Many-to-many between Transactions and Categories (PRD story 50).
  transactionCategories: defineTable({
    circleId: v.id("circles"),
    transactionId: v.id("transactions"),
    categoryId: v.id("categories"),
    transactionDate: v.string(),
    transactionCreatedAt: v.number(),
  })
    .index("by_transaction", ["transactionId"])
    .index("by_circle", ["circleId"])
    .index("by_category", ["categoryId"])
    .index("by_category_recent", [
      "categoryId",
      "transactionDate",
      "transactionCreatedAt",
      "transactionId",
    ]),

  invitations: defineTable({
    circleId: v.id("circles"),
    emailLower: v.string(),
    // Stored hashed; the opaque token lives only in the emailed link (ADR 0016).
    tokenHash: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("accepted"),
      v.literal("revoked"),
      v.literal("expired"),
    ),
    invitedByUserId: v.id("users"),
    resendCount: v.number(),
    // Epoch-ms of each resend within rolling windows; enforces ≤3 resends/day per email.
    resendTimestamps: v.array(v.number()),
    createdAt: v.number(),
    expiresAt: v.number(),
  })
    .index("by_circle", ["circleId"])
    .index("by_circle_and_email", ["circleId", "emailLower"])
    // Bounds capacity/pending reads to live seats only: an (status, expiresAt)
    // range scan reads just unexpired pending rows (≤ the 256 cap) and never
    // touches the unbounded accepted/revoked/expired history (CIR-cap).
    .index("by_circle_status_and_expiresAt", ["circleId", "status", "expiresAt"])
    .index("by_token_hash", ["tokenHash"])
    .index("by_inviter_status_createdAt", ["invitedByUserId", "status", "createdAt"])
    .index("by_inviter_status_expiresAt", ["invitedByUserId", "status", "expiresAt"])
    .index("by_email_status_createdAt", ["emailLower", "status", "createdAt"]),

  // Append-only send log for invitation rate limits (ADR 0026).
  invitationEmailEvents: defineTable({
    invitedByUserId: v.id("users"),
    circleId: v.id("circles"),
    emailLower: v.string(),
    kind: v.union(v.literal("create"), v.literal("resend")),
    sentAt: v.number(),
  })
    .index("by_user_and_sentAt", ["invitedByUserId", "sentAt"])
    .index("by_circle_email_and_sentAt", ["circleId", "emailLower", "sentAt"])
    .index("by_circle", ["circleId"]),

  // Append-only send log for feedback rate limits (FBK-1). Stores only safe metadata.
  feedbackEmailEvents: defineTable({
    userId: v.id("users"),
    type: v.union(v.literal("bug"), v.literal("feature"), v.literal("currency")),
    sentAt: v.number(),
  }).index("by_user_and_sentAt", ["userId", "sentAt"]),

  // E2E-only (ADR 0019): last emailed invitation token per Circle+email so Playwright
  // can drive accept flows after EML-2 stopped returning plaintext tokens to clients.
  // Never written when E2E_TEST_AUTH is unset — table stays empty in production.
  e2eInvitationTokens: defineTable({
    circleId: v.id("circles"),
    emailLower: v.string(),
    invitationId: v.id("invitations"),
    token: v.string(),
    updatedAt: v.number(),
  }).index("by_circle_and_email", ["circleId", "emailLower"]),

  // E2E-only (ADR 0019): last Account Deletion verification token so Playwright
  // can complete the verified deletion flow. Never written when E2E_TEST_AUTH is unset.
  e2eAccountDeletionTokens: defineTable({
    userId: v.id("users"),
    token: v.string(),
    updatedAt: v.number(),
  }).index("by_user", ["userId"]),

  /**
   * PocketCircle-owned MCP authorization grant (#317). The Worker issues tokens;
   * Convex stores what the User approved and is the live enforcement point for
   * every future tool call. Status is pending until Worker grant linkage activates
   * it; revocation here blocks data access even before Worker token cleanup.
   *
   * `allowedCircleIds` is an authorization boundary — never auto-expanded when
   * the User joins or creates Circles. `workerCleanupStatus` supports later
   * reconciliation (#330) after Convex revoke + failed Worker cleanup.
   */
  mcpGrants: defineTable({
    userId: v.id("users"),
    /** Opaque MCP principal — Worker's OAuth `userId`; stable per PocketCircle User. */
    principalId: v.string(),
    clientId: v.string(),
    /**
     * OAuth client registration kind. Cloudflare scopes default grant replacement
     * to the same redirect URI only for CIMD clients; static/DCR clients replace
     * by User+client across redirect URIs.
     */
    clientKind: v.union(v.literal("cimd"), v.literal("static")),
    /**
     * Approved OAuth redirect URI. Part of the CIMD supersession key; stored for
     * all kinds so consent/Connections can display it.
     */
    redirectUri: v.string(),
    /** Safe display snapshot from consent time (label only, not proof of identity). */
    clientDisplaySnapshot: v.object({
      clientName: v.optional(v.string()),
      clientUri: v.optional(v.string()),
      logoUri: v.optional(v.string()),
    }),
    scopes: v.array(v.union(v.literal("pocketcircle:read"), v.literal("pocketcircle:write"))),
    allowedCircleIds: v.array(v.id("circles")),
    status: v.union(v.literal("pending"), v.literal("active"), v.literal("revoked")),
    createdAt: v.number(),
    updatedAt: v.number(),
    activatedAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
    lastUsedAt: v.optional(v.number()),
    /** Cloudflare Workers OAuth grant id — set on activation for coordinated revoke. */
    workerGrantId: v.optional(v.string()),
    workerCleanupStatus: v.union(v.literal("none"), v.literal("pending_revoke")),
  })
    .index("by_principal", ["principalId"])
    .index("by_user", ["userId"])
    .index("by_user_and_status", ["userId", "status"])
    .index("by_user_client_and_status", ["userId", "clientId", "status"])
    .index("by_user_client_redirect_and_status", ["userId", "clientId", "redirectUri", "status"])
    .index("by_client_and_status", ["clientId", "status"])
    .index("by_status", ["status"])
    .index("by_worker_grant", ["workerGrantId"])
    .index("by_worker_cleanup_status", ["workerCleanupStatus"]),

  // Durable Account Deletion cleanup state (USR-3 / ADR 0029). Deleted when done.
  accountDeletionJobs: defineTable({
    userId: v.id("users"),
    emailLower: v.string(),
    finalizedAt: v.number(),
    phase: v.string(),
    circleId: v.optional(v.id("circles")),
    circlePhase: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
    failure: v.optional(v.string()),
  })
    .index("by_user", ["userId"])
    .index("by_email_lower", ["emailLower"]),

  // User-level Activation Checklist progress (ADR 0030). One row per User: explicit
  // first-completed timestamps plus dismissal. Never derived from live entity state
  // after initialization — archiving, leaving, or deleting source data cannot reopen
  // a milestone. Bootstrap inserts the empty row; existing Users get it from the
  // authenticated initializer.
  //
  // Generic milestone fields (transactionCreatedAt, categoryCreatedAt) replace the
  // legacy Personal-specific names (GH-273). Legacy optional fields remain accepted
  // during migration; rows are normalized on read/write (earliest timestamp wins,
  // legacy cleared). New rows only write generic fields.
  userActivation: defineTable({
    userId: v.id("users"),
    initializedAt: v.number(),
    // Set after the one-shot evidence scan (bootstrap or initialize). Writers may
    // create a row without this; Home treats that as uninitialized so backfill
    // stays off the Transaction/Category/Circle/Invitation hot path.
    evidenceBackfilledAt: v.optional(v.number()),
    // --- Generic milestone fields (GH-273) ---
    transactionCreatedAt: v.optional(v.number()),
    categoryCreatedAt: v.optional(v.number()),
    regularCircleCreatedAt: v.optional(v.number()),
    sharedMemberJoinedAt: v.optional(v.number()),
    // --- Legacy fields (accepted during migration, cleared on normalization) ---
    personalTransactionCreatedAt: v.optional(v.number()),
    personalCategoryCreatedAt: v.optional(v.number()),
    dismissedAt: v.optional(v.number()),
    // Set once when the owner client observes all four milestones; prevents repeat
    // `activation_checklist_completed` analytics across reloads/tabs.
    completionEventDeliveredAt: v.optional(v.number()),
  }).index("by_user", ["userId"]),

  // Home Summary per-user Circle exclusions (GH-273). One row per (userId, circleId)
  // — absence means included. Idempotent writes; Account Deletion cleans these up.
  homeSummaryExclusions: defineTable({
    userId: v.id("users"),
    circleId: v.id("circles"),
    excludedAt: v.number(),
  })
    .index("by_user_circle", ["userId", "circleId"])
    .index("by_circle", ["circleId"]),

  notifications: defineTable({
    userId: v.id("users"),
    type: v.string(),
    title: v.string(),
    body: v.optional(v.string()),
    // Canonical in-app link target, resolved for accessibility at read time.
    link: v.optional(v.string()),
    read: v.boolean(),
    createdAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_user_and_read", ["userId", "read"]),

  // Append-only, IMMUTABLE event-as-row audit; written server-side only via the
  // history module (ADR 0015, 0018). One row per user action: the event IS the
  // row. Convex _ids are globally unique, so `entityId` (a stringified Circle /
  // Transaction / Category id) alone keys an entity's history — read by_entity
  // newest-first — and access is resolved through the entity's Circle, not a
  // denormalized column. `circleId` is an internal cascade key only (USR-3 /
  // ADR 0029) — never returned to clients or put in `changes`. `changes` is an
  // array of { field, from?, to? } of human strings formatted ONCE at write time
  // (dates plain, Members as Display Name, Categories as names); `from` is
  // absent on a "created" event, `to` on an "archived" one. Values are frozen —
  // never re-resolved — so a line always shows what was true when it was written,
  // and raw internal IDs never appear inside `changes` (PRD story 80). We rejected
  // a reference-based history that re-resolves display values at read time; see
  // ADR 0018.
  //
  // Money is the exception to the preformatted-string rule (ADR 0021): an amount
  // change freezes a SEMANTIC money value — integer `minorUnits` plus the Circle
  // `currency` at event time — in `fromMoney`/`toMoney`, NOT a formatted string.
  // History stores meaning, not presentation, so a row renders for the viewer's
  // locale at read time instead of locking the event to a server/terminal locale.
  histories: defineTable({
    entityId: v.string(),
    // Internal cascade key for bounded whole-Circle deletion (USR-3 / ADR 0029).
    circleId: v.id("circles"),
    actorMemberId: v.optional(v.id("members")), // absent ⇒ system action
    action: v.string(),
    changes: v.array(
      v.object({
        field: v.string(),
        from: v.optional(v.string()),
        to: v.optional(v.string()),
        // Typed money (ADR 0021) — used by money fields instead of from/to.
        fromMoney: v.optional(v.object({ minorUnits: v.number(), currency: v.string() })),
        toMoney: v.optional(v.object({ minorUnits: v.number(), currency: v.string() })),
      }),
    ),
    createdAt: v.number(),
  })
    .index("by_entity", ["entityId"])
    .index("by_circle", ["circleId"]),
});
