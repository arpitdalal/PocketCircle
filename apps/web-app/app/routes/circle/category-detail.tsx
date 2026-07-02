import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import {
  CategoryLifecycleButton,
  categoryColorSwatch,
  EditCategoryForm,
} from "~/components/category-actions.js";
import { CategoryHistory } from "~/components/category-history.js";
import { Splash } from "~/components/splash.js";
import { TransactionList } from "~/components/transaction-list.js";
import { Button } from "~/components/ui/button.js";
import { buttonVariants } from "~/components/ui/button-variants.js";
import { circlePath } from "~/lib/circle-path.js";
import { type CategoryDetail, type Circle, useRecentCategoryTransactions } from "~/lib/data.js";
import { categoryTransactionSearchHref } from "~/lib/ledger-url.js";
import { parseReturnTo, RETURN_TO_PARAM } from "~/lib/return-to-url.js";
import { useResolvedCategoryDetail } from "~/lib/use-resolved-category-detail.js";
import { useCircle } from "~/routes/layouts/circle-layout.js";

/**
 * The Category DETAIL object route — `/circles/:circleRef/categories/:categoryRef`
 * (issue #240, ADR 0016/0017). The Category sibling of the Transaction Detail route:
 * resolves its target by ID, canonicalizes stale slugs, and falls back generically for
 * missing / inaccessible / wrong-Circle refs.
 */
export default function CategoryDetailRoute() {
  const circle = useCircle();
  const [searchParams] = useSearchParams();

  const returnTo = parseReturnTo(searchParams.get(RETURN_TO_PARAM), {
    fallback: circlePath(circle.ref, "categories"),
  });
  const resolution = useResolvedCategoryDetail({ fallback: returnTo });

  if (resolution.status === "pending") {
    return <Splash label="Opening category…" />;
  }

  return <CategoryDetailView circle={circle} category={resolution.value} backTo={returnTo} />;
}

function CategoryDetailView({
  circle,
  category,
  backTo,
}: {
  circle: Circle;
  category: CategoryDetail;
  backTo: string;
}) {
  const writable = circle.status === "active";
  const isArchived = category.status === "archived";
  const canEdit = writable && category.canEditFields && !isArchived;
  const canManageLifecycle = writable && category.canArchive;
  const swatch = categoryColorSwatch(category.color);
  const recent = useRecentCategoryTransactions(circle.id, category.id);
  const [editing, setEditing] = useState(false);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link to={backTo} className="text-sm text-muted-foreground hover:text-foreground">
          ‹ Back
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          {canEdit && !editing ? (
            <Button
              type="button"
              variant="outline"
              size="default"
              onClick={() => setEditing(true)}
              aria-label={`Edit ${category.name}`}
            >
              Edit
            </Button>
          ) : null}
          {canManageLifecycle ? (
            <CategoryLifecycleButton
              category={category}
              action={isArchived ? "restore" : "archive"}
            />
          ) : null}
        </div>
      </div>

      {editing && canEdit ? (
        <EditCategoryForm category={category} onClose={() => setEditing(false)} />
      ) : (
        <header className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <span
              aria-hidden
              className="size-4 rounded-full"
              style={{ backgroundColor: swatch?.hex }}
            />
            <h2 className="font-display text-xl font-semibold tracking-tight">{category.name}</h2>
            <span className="rounded-full border border-border px-2 py-px text-xs capitalize text-muted-foreground">
              {category.type}
            </span>
            {isArchived ? (
              <span className="rounded-full border border-border bg-muted px-2.5 py-0.5 text-xs text-muted-foreground">
                Archived
              </span>
            ) : null}
          </div>
          <p className="text-sm text-muted-foreground">
            Created by <span className="text-foreground">{category.creator.displayName}</span>
          </p>
        </header>
      )}

      <section aria-label="Recent transactions" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-semibold">Recent transactions</h3>
          <Link
            to={categoryTransactionSearchHref(circle, category)}
            className={buttonVariants({ variant: "outline", size: "sm" })}
          >
            View all matching transactions
          </Link>
        </div>
        {recent === undefined ? (
          <p className="text-sm text-muted-foreground">Loading transactions…</p>
        ) : (
          <TransactionList
            paginated={{ transactions: recent, status: "Exhausted", loadMore: () => {} }}
            circle={circle}
            emptyLabel="No transactions use this category yet."
            canEdit={false}
            paginationMode="none"
            showLifecycle={false}
          />
        )}
      </section>

      <CategoryHistory circleId={circle.id} categoryId={category.id} name={category.name} />
    </div>
  );
}
