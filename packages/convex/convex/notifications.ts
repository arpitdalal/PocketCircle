import { parseNotificationLinkPath } from "@pocketcircle/domain";
import { v } from "convex/values";
import type { Doc, Id } from "./_generated/dataModel.js";
import { mutation, type QueryCtx, query } from "./_generated/server.js";
import { getCurrentUserOrNull, requireCurrentUser } from "./auth.js";
import { type AuthorizedCircle, resolveCircleAccessForUser } from "./guard.js";

/** Badge cap — scan at most CAP+1 unread rows so the UI can render `99+`. */
export const UNREAD_COUNT_CAP = 99;

/** Unread rows shown per open / cleared per mark-all-read batch. */
export const NOTIFICATION_BATCH_SIZE = 20;

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

/** Up to {@link NOTIFICATION_BATCH_SIZE} unread notifications, newest first. */
export const listNotifications = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireCurrentUser(ctx);
    const rows = await ctx.db
      .query("notifications")
      .withIndex("by_user_and_read", (q) => q.eq("userId", user._id).eq("read", false))
      .order("desc")
      .take(NOTIFICATION_BATCH_SIZE);

    const linkResolver = createNotificationLinkResolver(ctx, user);
    return Promise.all(rows.map((row) => toNotificationView(row, linkResolver)));
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

/** Marks the current unread batch read (same slice as {@link listNotifications}). */
export const markAllRead = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireCurrentUser(ctx);
    const unread = await ctx.db
      .query("notifications")
      .withIndex("by_user_and_read", (q) => q.eq("userId", user._id).eq("read", false))
      .order("desc")
      .take(NOTIFICATION_BATCH_SIZE);
    for (const row of unread) {
      await ctx.db.patch(row._id, { read: true });
    }
  },
});
