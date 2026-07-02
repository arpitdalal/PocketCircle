import {
  buildRef,
  categoryInputSchema,
  MUTATION_ERRORS,
  paletteColorForSeed,
  type TransactionType,
  transactionFieldSchemas,
} from "@spend-circle/domain";
import { useMemo, useState } from "react";
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxValue,
  useComboboxAnchor,
} from "~/components/ui/combobox.js";
import { FieldError, FieldLegend, FieldSet } from "~/components/ui/field.js";
import { track } from "~/lib/analytics.js";
import { type Category, type Circle, useCreateCategory } from "~/lib/data.js";
import { useTypedAppFormContext } from "~/lib/form.js";
import { mutationErrorCode, mutationErrorMessageForUser } from "~/lib/mutation-user-message.js";
import { cn } from "~/lib/utils.js";
import { transactionFormContextOptions } from "./transaction-form-options.js";

/** Sentinel combobox item — keyboard-reachable create action, never stored as a category id. */
const INLINE_CREATE_ITEM = "__sc_inline_create__";

function toInlineCreatedCategory(
  id: Category["id"],
  name: string,
  type: TransactionType,
  color: string,
): Category {
  return {
    id,
    ref: buildRef(name, id),
    name,
    type,
    color,
    status: "active",
    creator: { displayName: "You", image: undefined },
    canEditFields: true,
    canArchive: true,
  };
}

function buildCategoryNameIndex(categoryById: ReadonlyMap<string, Category>) {
  const byType = new Map<TransactionType, Map<string, Category>>();
  for (const category of categoryById.values()) {
    let typeIndex = byType.get(category.type);
    if (!typeIndex) {
      typeIndex = new Map();
      byType.set(category.type, typeIndex);
    }
    typeIndex.set(category.name.toLowerCase(), category);
  }
  return byType;
}

function lookupCategoryByName(
  index: ReadonlyMap<TransactionType, ReadonlyMap<string, Category>>,
  activeType: TransactionType,
  name: string,
) {
  const normalized = name.trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  return index.get(activeType)?.get(normalized) ?? null;
}

export function TransactionFormCategorySection({
  circleId,
  categoryById,
  alreadyAttached,
  activeCategories,
  activeType,
  onInlineCreatedCategory,
}: {
  circleId: Circle["id"];
  categoryById: ReadonlyMap<string, Category>;
  alreadyAttached: ReadonlySet<string>;
  activeCategories: Category[];
  activeType: TransactionType;
  onInlineCreatedCategory: (category: Category) => void;
}) {
  const form = useTypedAppFormContext(transactionFormContextOptions);
  const createCategory = useCreateCategory();
  const anchorRef = useComboboxAnchor();
  const [query, setQuery] = useState("");
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const trimmedQuery = query.trim();
  const categoryNameIndex = useMemo(() => buildCategoryNameIndex(categoryById), [categoryById]);
  const exactNameMatch = useMemo(
    () => lookupCategoryByName(categoryNameIndex, activeType, trimmedQuery),
    [categoryNameIndex, activeType, trimmedQuery],
  );
  const showCreateAffordance = trimmedQuery.length > 0 && !exactNameMatch && !creating;
  const showReservedName =
    trimmedQuery.length > 0 && exactNameMatch?.status === "archived" && !creating;
  const createOptionLabel = `Create "${trimmedQuery}"`;

  const activeIds = useMemo(
    () => activeCategories.map((category) => category.id),
    [activeCategories],
  );

  const comboboxItems = useMemo(
    () => (showCreateAffordance ? [...activeIds, INLINE_CREATE_ITEM] : activeIds),
    [activeIds, showCreateAffordance],
  );

  async function handleInlineCreate(
    currentIds: string[],
    onIdsChange: (nextIds: string[]) => void,
  ) {
    setInlineError(null);

    if (!trimmedQuery) {
      return;
    }

    if (exactNameMatch?.status === "active") {
      if (!currentIds.includes(exactNameMatch.id)) {
        onIdsChange([...currentIds, exactNameMatch.id]);
      }
      setQuery("");
      return;
    }
    if (exactNameMatch?.status === "archived") {
      setInlineError(`A category named '${exactNameMatch.name}' already exists but is archived`);
      return;
    }

    const seededColor = paletteColorForSeed(trimmedQuery.toLowerCase()).id;

    const parsed = categoryInputSchema.safeParse({
      name: trimmedQuery,
      type: activeType,
      color: seededColor,
    });
    if (!parsed.success) {
      setInlineError(parsed.error.issues[0]?.message ?? "Please check the category name.");
      return;
    }

    setCreating(true);
    try {
      const newId = await createCategory({
        circleId,
        name: parsed.data.name,
        type: activeType,
        color: seededColor,
      });
      if (!newId) {
        setInlineError("Couldn't create the category. Please try again.");
        return;
      }
      const created = toInlineCreatedCategory(newId, parsed.data.name, activeType, seededColor);
      onInlineCreatedCategory(created);
      track("category_created", { type: activeType, source: "transaction_inline" });
      if (!currentIds.includes(newId)) {
        onIdsChange([...currentIds, newId]);
      }
      setQuery("");
    } catch (caught) {
      const userMessage = mutationErrorMessageForUser(
        caught,
        "Couldn't create the category. Please try again.",
      );
      if (mutationErrorCode(caught) !== MUTATION_ERRORS.categoryNameDuplicate.code) {
        console.error("inlineCreateCategory failed", caught);
      }
      setInlineError(userMessage);
    } finally {
      setCreating(false);
    }
  }

  return (
    <form.Subscribe selector={(state) => state.submissionAttempts > 0}>
      {(submitReveal) => (
        <form.Field
          name="categoryIds"
          validators={{ onChange: transactionFieldSchemas.categoryIds }}
        >
          {(field) => {
            const reveal = field.state.meta.isDirty || submitReveal;
            const invalid = reveal && field.state.meta.errors.length > 0;
            const archivedSelected = field.state.value.flatMap((id) => {
              const category = categoryById.get(id);
              return category && category.status === "archived" ? [category] : [];
            });
            const blockingArchived = archivedSelected.filter(
              (category) => !alreadyAttached.has(category.id),
            );

            return (
              <FieldSet>
                <FieldLegend>Categories</FieldLegend>
                <Combobox
                  multiple
                  autoHighlight
                  disabled={creating}
                  inputValue={query}
                  onInputValueChange={(next, eventDetails) => {
                    // Only mirror typed input — item selection also emits input clears we
                    // handle explicitly after a successful pick or inline create.
                    if (eventDetails.reason !== "input-change") {
                      return;
                    }
                    setQuery(next);
                    if (inlineError) {
                      setInlineError(null);
                    }
                  }}
                  value={field.state.value}
                  onValueChange={(next) => {
                    const ids = next ?? [];
                    if (ids.includes(INLINE_CREATE_ITEM)) {
                      void handleInlineCreate(field.state.value, field.handleChange);
                      return;
                    }
                    const added = ids.length > field.state.value.length;
                    field.handleChange(ids);
                    if (added) {
                      setQuery("");
                    }
                  }}
                  items={comboboxItems}
                  itemToStringLabel={(id: string) =>
                    id === INLINE_CREATE_ITEM
                      ? createOptionLabel
                      : (categoryById.get(id)?.name ?? id)
                  }
                >
                  <ComboboxChips ref={anchorRef} className="w-full max-w-full">
                    <ComboboxValue>
                      {(values: string[]) => (
                        <>
                          {values.map((id) => {
                            const category = categoryById.get(id);
                            const archived = category?.status === "archived";
                            const label = category?.name ?? id;
                            return (
                              <ComboboxChip
                                key={id}
                                removeAriaLabel={`Remove ${label}`}
                                className={
                                  archived
                                    ? cn(
                                        "border border-amber-600/70 bg-amber-950/40 text-amber-300",
                                        "hover:text-amber-100",
                                      )
                                    : undefined
                                }
                              >
                                {label}
                                {archived ? " · archived" : ""}
                              </ComboboxChip>
                            );
                          })}
                          <ComboboxChipsInput
                            placeholder="Search categories…"
                            aria-label="Categories"
                            disabled={creating}
                          />
                        </>
                      )}
                    </ComboboxValue>
                  </ComboboxChips>
                  <ComboboxContent anchor={anchorRef}>
                    <ComboboxEmpty>No matching categories.</ComboboxEmpty>
                    <ComboboxList>
                      {(id: string) => {
                        if (id === INLINE_CREATE_ITEM) {
                          return (
                            <ComboboxItem key={id} value={id} className="border-t border-border">
                              {createOptionLabel}
                            </ComboboxItem>
                          );
                        }
                        const category = categoryById.get(id);
                        if (category?.status !== "active") {
                          return null;
                        }
                        return (
                          <ComboboxItem key={id} value={id}>
                            {category.name}
                          </ComboboxItem>
                        );
                      }}
                    </ComboboxList>
                  </ComboboxContent>
                </Combobox>
                {showReservedName ? (
                  <p role="alert" className="text-sm text-amber-400">
                    A category named &lsquo;{exactNameMatch?.name}&rsquo; already exists but is
                    archived
                  </p>
                ) : null}
                {inlineError ? (
                  <p role="alert" className="text-sm text-destructive">
                    {inlineError}
                  </p>
                ) : null}
                {blockingArchived.length > 0 ? (
                  <p role="alert" className="text-sm text-amber-400">
                    {blockingArchived.length === 1
                      ? `"${blockingArchived[0]?.name}" was archived and can't be added to a ${activeType}. Remove it to continue.`
                      : "Some selected categories were archived and can't be added. Remove them to continue."}
                  </p>
                ) : null}
                <FieldError errors={invalid ? field.state.meta.errors : undefined} />
              </FieldSet>
            );
          }}
        </form.Field>
      )}
    </form.Subscribe>
  );
}
