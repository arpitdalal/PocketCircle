import { parseNotificationLinkPath } from "@pocketcircle/domain";
import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import {
  internalMutation,
  type MutationCtx,
  mutation,
  type QueryCtx,
  query,
} from "./_generated/server.js";
import { getCurrentUserOrNull, requireCurrentUser } from "./auth.js";
import { type AuthorizedCircle, resolveCircleAccessForUser } from "./guard.js";

/** Badge cap — scan at most CAP+1 unread rows so the UI can render `99+`. */
export const UNREAD_COUNT_CAP = 99;

/** List page size for Unread and All (infinite scroll). */
export const NOTIFICATION_BATCH_SIZE = 20;

/** Unread rows patched per mark-all-read mutation (Convex write-budget chunk). */
export const MARK_ALL_READ_CHUNK_SIZE = 200;

const NOT_FOUND = "Notification not found";

/** Ref id segments are shape-parsed here; `ctx.db.normalizeId` is the authoritative gate. */
const acceptRefIdSegment = () => true;

type CircleAccessLookup = (circleId: Id<"circles">) => Promise<AuthorizedCircle | null>;

/**
 * Batched link resolver for a single notification list page. Memoizes circle
 * access (and in-flight lookups) so rows sharing a Circle reuse one membership read.
 */
export function createNotificationLinkResolver(ctx: QueryCtx, user: Doc<"users">) {
  const circleAccessById = new Map<Id<"circles">, Promise<AuthorizedCircle | null>>();

  const circleAccess: CircleAccessLookup = (circleId) => {
    let pending = circleAccessById.get(circleId);
    if (!pending) {
      pending = resolveCircleAccessForUser(ctx, circleId, user);
      circleAccessById.set(circleId, pending);
    }
    return pending;
  };

  return {
    resolve(link: string | undefined) {
      return resolveNotificationLinkWithAccess(ctx, link, circleAccess);
    },
  };
}

async function resolveNotificationLinkWithAccess(
  ctx: QueryCtx,
  link: string | undefined,
  circleAccess: CircleAccessLookup,
): Promise<string | undefined> {
  if (!link) {
    return undefined;
  }

  const parsed = parseNotificationLinkPath(link, acceptRefIdSegment);
  if (!parsed) {
    return undefined;
  }

  const circleId = ctx.db.normalizeId("circles", parsed.circleId);
  if (!circleId) {
    return undefined;
  }

  const access = await circleAccess(circleId);
  if (!access) {
    return undefined;
  }

  if (parsed.kind === "circle") {
    return link;
  }

  if (parsed.kind === "transaction") {
    const objectId = ctx.db.normalizeId("transactions", parsed.objectId ?? "");
    if (!objectId) {
      return undefined;
    }
    const transaction = await ctx.db.get(objectId);
    if (!transaction || transaction.circleId !== circleId) {
      return undefined;
    }
    return link;
  }

  const categoryId = ctx.db.normalizeId("categories", parsed.objectId ?? "");
  if (!categoryId) {
    return undefined;
  }
  const category = await ctx.db.get(categoryId);
  if (!category || category.circleId !== circleId) {
    return undefined;
  }
  return link;
}

/**
 * Re-resolves a stored notification link at read time (NTF-1). Returns the link
 * when the caller still has Circle access and the referenced object exists in that
 * Circle; otherwise `undefined` (text-only, indistinguishable from never-linked).
 */
export async function resolveNotificationLink(
  ctx: QueryCtx,
  link: string | undefined,
): Promise<string | undefined> {
  if (!link) {
    return undefined;
  }
  const user = await getCurrentUserOrNull(ctx);
  if (!user) {
    return undefined;
  }
  return createNotificationLinkResolver(ctx, user).resolve(link);
}

async function toNotificationView(
  row: Doc<"notifications">,
  linkResolver: ReturnType<typeof createNotificationLinkResolver>,
) {
  const link = await linkResolver.resolve(row.link);
  return {
    id: row._id,
    type: row.type,
    title: row.title,
    body: row.body,
    link,
    read: row.read,
    createdAt: row.createdAt,
  };
}

/** Paginated Notification Center list: Unread (`unreadOnly`) or All, newest `_creationTime` first. */
export const listNotifications = query({
  args: {
    unreadOnly: v.boolean(),
    paginationOpts: paginationOptsValidator,
  },
  handler: async (ctx, args) => {
    const user = await requireCurrentUser(ctx);
    const indexed = args.unreadOnly
      ? ctx.db
          .query("notifications")
          .withIndex("by_user_and_read", (q) => q.eq("userId", user._id).eq("read", false))
      : ctx.db.query("notifications").withIndex("by_user", (q) => q.eq("userId", user._id));
    const result = await indexed.order("desc").paginate(args.paginationOpts);
    const linkResolver = createNotificationLinkResolver(ctx, user);
    const page = await Promise.all(result.page.map((row) => toNotificationView(row, linkResolver)));
    return { ...result, page };
  },
});

/** Unread count for the header badge, capped so the scan stays bounded. */
export const getUnreadCount = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireCurrentUser(ctx);
    const unread = await ctx.db
      .query("notifications")
      .withIndex("by_user_and_read", (q) => q.eq("userId", user._id).eq("read", false))
      .take(UNREAD_COUNT_CAP + 1);
    return {
      count: Math.min(unread.length, UNREAD_COUNT_CAP),
      hasMore: unread.length > UNREAD_COUNT_CAP,
    };
  },
});

/** Marks one notification read for the current User; no-op when already read. */
export const markNotificationRead = mutation({
  args: {
    notificationId: v.id("notifications"),
  },
  handler: async (ctx, args) => {
    const user = await requireCurrentUser(ctx);
    const row = await ctx.db.get(args.notificationId);
    if (!row || row.userId !== user._id) {
      throw new Error(NOT_FOUND);
    }
    if (!row.read) {
      await ctx.db.patch(args.notificationId, { read: true });
    }
  },
});

/**
 * Marks every notification that was unread at click time. Newer inserts (higher
 * `_creationTime` than the watermark) stay unread. Chunks of
 * {@link MARK_ALL_READ_CHUNK_SIZE} continue via {@link continueMarkAllRead}.
 */
export const markAllRead = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireCurrentUser(ctx);
    const newestUnread = await ctx.db
      .query("notifications")
      .withIndex("by_user_and_read", (q) => q.eq("userId", user._id).eq("read", false))
      .order("desc")
      .take(1);
    const watermark = newestUnread[0];
    if (!watermark) {
      return;
    }
    await drainMarkAllReadAndContinue(ctx, user._id, watermark._creationTime);
  },
});

/** Scheduler continuation for {@link markAllRead}. No end-user auth. */
export const continueMarkAllRead = internalMutation({
  args: {
    userId: v.id("users"),
    createdBefore: v.number(),
  },
  handler: async (ctx, args) => {
    const user = await ctx.db.get(args.userId);
    if (!user) {
      return;
    }
    await drainMarkAllReadAndContinue(ctx, args.userId, args.createdBefore);
  },
});

async function drainMarkAllReadChunk(ctx: MutationCtx, userId: Id<"users">, createdBefore: number) {
  const unread = await ctx.db
    .query("notifications")
    .withIndex("by_user_and_read", (q) => q.eq("userId", userId).eq("read", false))
    .order("asc")
    .take(MARK_ALL_READ_CHUNK_SIZE);

  let patched = 0;
  for (const row of unread) {
    if (row._creationTime > createdBefore) {
      break;
    }
    await ctx.db.patch(row._id, { read: true });
    patched += 1;
  }
  return patched;
}

async function drainMarkAllReadAndContinue(
  ctx: MutationCtx,
  userId: Id<"users">,
  createdBefore: number,
) {
  const patched = await drainMarkAllReadChunk(ctx, userId, createdBefore);
  if (patched !== MARK_ALL_READ_CHUNK_SIZE) {
    return;
  }
  await ctx.scheduler.runAfter(0, internal.notifications.continueMarkAllRead, {
    userId,
    createdBefore,
  });
}
