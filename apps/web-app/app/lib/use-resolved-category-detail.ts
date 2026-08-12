import { api } from "@pocketcircle/convex";
import { useConvexAuth, useQuery } from "convex/react";
import { useParams } from "react-router";
import { useCircle } from "~/routes/layouts/circle-layout.js";
import type { CategoryDetail } from "./data.js";
import { MOCKS } from "./env.js";
import { mockCategoryDetail } from "./fixtures.js";
import { parseCategoryRef } from "./refs.js";
import { type Resolution, useResolvedRef } from "./use-resolved-ref.js";

/**
 * The Category DETAIL object guard over the shared resolution primitive (ADR
 * 0016/0017). Reads `categoryRef`, parses it, and subscribes to `getCategory`
 * scoped to the resolved Circle — the mirror of {@link useResolvedTransactionDetail}.
 */
export function useResolvedCategoryDetail({
  fallback,
}: {
  fallback: string;
}): Resolution<CategoryDetail> {
  const circle = useCircle();
  const { categoryRef } = useParams();
  const { isAuthenticated } = useConvexAuth();

  const parsed = parseCategoryRef(categoryRef);
  const queried = useQuery(
    api.categories.getCategory,
    parsed && !MOCKS && isAuthenticated ? { circleId: circle.id, categoryId: parsed.id } : "skip",
  );
  const value = MOCKS && parsed ? mockCategoryDetail(parsed.id) : queried;

  return useResolvedRef<CategoryDetail>({
    rawRef: categoryRef,
    parsed: parsed != null,
    value,
    fallback,
  });
}
