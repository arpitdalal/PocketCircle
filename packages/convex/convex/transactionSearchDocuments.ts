import { transactionSearchText } from "@pocketcircle/domain";
import type { Doc, Id } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";

function categorySlotInsert(categoryIds: Id<"categories">[]) {
  return {
    ...(categoryIds[0] ? { categoryId0: categoryIds[0] } : {}),
    ...(categoryIds[1] ? { categoryId1: categoryIds[1] } : {}),
    ...(categoryIds[2] ? { categoryId2: categoryIds[2] } : {}),
    ...(categoryIds[3] ? { categoryId3: categoryIds[3] } : {}),
    ...(categoryIds[4] ? { categoryId4: categoryIds[4] } : {}),
    ...(categoryIds[5] ? { categoryId5: categoryIds[5] } : {}),
    ...(categoryIds[6] ? { categoryId6: categoryIds[6] } : {}),
    ...(categoryIds[7] ? { categoryId7: categoryIds[7] } : {}),
    ...(categoryIds[8] ? { categoryId8: categoryIds[8] } : {}),
    ...(categoryIds[9] ? { categoryId9: categoryIds[9] } : {}),
  };
}

function categorySlotPatch(categoryIds: Id<"categories">[]) {
  return {
    categoryId0: categoryIds[0],
    categoryId1: categoryIds[1],
    categoryId2: categoryIds[2],
    categoryId3: categoryIds[3],
    categoryId4: categoryIds[4],
    categoryId5: categoryIds[5],
    categoryId6: categoryIds[6],
    categoryId7: categoryIds[7],
    categoryId8: categoryIds[8],
    categoryId9: categoryIds[9],
  };
}

async function categoryIdsForTransaction(ctx: MutationCtx, transactionId: Id<"transactions">) {
  const links = await ctx.db
    .query("transactionCategories")
    .withIndex("by_transaction", (q) => q.eq("transactionId", transactionId))
    .collect();
  return links.map((link) => link.categoryId);
}

function projection(txn: Doc<"transactions">, categoryIds: Id<"categories">[]) {
  return {
    transactionId: txn._id,
    circleId: txn.circleId,
    searchText: transactionSearchText({ title: txn.title, note: txn.note }),
    type: txn.type,
    status: txn.status,
    recordedByMemberId: txn.recordedByMemberId,
    paidByMemberId: txn.paidByMemberId,
    ...categorySlotPatch(categoryIds),
    date: txn.date,
    amountMinorUnits: txn.amountMinorUnits,
  };
}

function changedProjectionFields(
  existing: Doc<"transactionSearchDocuments">,
  next: ReturnType<typeof projection>,
) {
  const patch: Partial<Doc<"transactionSearchDocuments">> = {};
  if (existing.transactionId !== next.transactionId) patch.transactionId = next.transactionId;
  if (existing.circleId !== next.circleId) patch.circleId = next.circleId;
  if (existing.searchText !== next.searchText) patch.searchText = next.searchText;
  if (existing.type !== next.type) patch.type = next.type;
  if (existing.status !== next.status) patch.status = next.status;
  if (existing.recordedByMemberId !== next.recordedByMemberId) {
    patch.recordedByMemberId = next.recordedByMemberId;
  }
  if (existing.paidByMemberId !== next.paidByMemberId) {
    patch.paidByMemberId = next.paidByMemberId;
  }
  if (existing.categoryId0 !== next.categoryId0) patch.categoryId0 = next.categoryId0;
  if (existing.categoryId1 !== next.categoryId1) patch.categoryId1 = next.categoryId1;
  if (existing.categoryId2 !== next.categoryId2) patch.categoryId2 = next.categoryId2;
  if (existing.categoryId3 !== next.categoryId3) patch.categoryId3 = next.categoryId3;
  if (existing.categoryId4 !== next.categoryId4) patch.categoryId4 = next.categoryId4;
  if (existing.categoryId5 !== next.categoryId5) patch.categoryId5 = next.categoryId5;
  if (existing.categoryId6 !== next.categoryId6) patch.categoryId6 = next.categoryId6;
  if (existing.categoryId7 !== next.categoryId7) patch.categoryId7 = next.categoryId7;
  if (existing.categoryId8 !== next.categoryId8) patch.categoryId8 = next.categoryId8;
  if (existing.categoryId9 !== next.categoryId9) patch.categoryId9 = next.categoryId9;
  if (existing.date !== next.date) patch.date = next.date;
  if (existing.amountMinorUnits !== next.amountMinorUnits) {
    patch.amountMinorUnits = next.amountMinorUnits;
  }
  return patch;
}

export async function syncTransactionSearchDocument(
  ctx: MutationCtx,
  txn: Doc<"transactions">,
  opts: { categoryIds?: Id<"categories">[] } = {},
) {
  const categoryIds = opts.categoryIds ?? (await categoryIdsForTransaction(ctx, txn._id));
  const next = projection(txn, categoryIds);
  const existing = await ctx.db
    .query("transactionSearchDocuments")
    .withIndex("by_transaction", (q) => q.eq("transactionId", txn._id))
    .unique();
  if (existing) {
    const patch = changedProjectionFields(existing, next);
    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(existing._id, patch);
    }
    return;
  }
  await ctx.db.insert("transactionSearchDocuments", {
    transactionId: next.transactionId,
    circleId: next.circleId,
    searchText: next.searchText,
    type: next.type,
    status: next.status,
    recordedByMemberId: next.recordedByMemberId,
    paidByMemberId: next.paidByMemberId,
    ...categorySlotInsert(categoryIds),
    date: next.date,
    amountMinorUnits: next.amountMinorUnits,
  });
}
