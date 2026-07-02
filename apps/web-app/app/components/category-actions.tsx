import { COLOR_PALETTE, categoryUpdateSchema, LIMITS } from "@spend-circle/domain";
import { type FormEvent, useState } from "react";
import { ColorPicker } from "~/components/category-form.js";
import { Button } from "~/components/ui/button.js";
import {
  type Category,
  useArchiveCategory,
  useRestoreCategory,
  useUpdateCategory,
} from "~/lib/data.js";
import { mutationErrorMessageForUser } from "~/lib/mutation-user-message.js";
import { useDoubleCheck } from "~/lib/use-double-check.js";

const LIFECYCLE_COPY = {
  archive: {
    idle: "Archive",
    confirm: "Confirm archive",
    busy: "Archiving…",
    error: "Couldn't archive the category.",
  },
  restore: { idle: "Restore", busy: "Restoring…", error: "Couldn't restore the category." },
};

/**
 * The inline rename/recolor form (creator-only — the server enforces it, ADR 0015).
 * Sends only the fields that differ from the current Category, so an untouched
 * submit is a server-side no-op that records no history.
 */
export function EditCategoryForm({
  category,
  onClose,
}: {
  category: Category;
  onClose: () => void;
}) {
  return <EditCategoryFormFields key={category.id} category={category} onClose={onClose} />;
}

function EditCategoryFormFields({
  category,
  onClose,
}: {
  category: Category;
  onClose: () => void;
}) {
  const updateCategory = useUpdateCategory();
  // react-doctor-disable-next-line react-doctor/no-derived-useState -- parent key={category.id} remounts this editor per row/session.
  const [name, setName] = useState(category.name);
  // react-doctor-disable-next-line react-doctor/no-derived-useState -- parent key={category.id} remounts this editor per row/session.
  const [color, setColor] = useState(category.color);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const inputId = `edit-category-${category.id}`;
  const errorId = `${inputId}-error`;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);

    const parsed = categoryUpdateSchema.safeParse({ name, color });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Please check the category details.");
      return;
    }

    const changedName = parsed.data.name !== category.name ? parsed.data.name : undefined;
    const changedColor = parsed.data.color !== category.color ? parsed.data.color : undefined;
    if (changedName === undefined && changedColor === undefined) {
      onClose();
      return;
    }

    setSubmitting(true);
    try {
      await updateCategory({
        categoryId: category.id,
        ...(changedName !== undefined ? { name: changedName } : {}),
        ...(changedColor !== undefined ? { color: changedColor } : {}),
      });
      onClose();
    } catch (caught) {
      setError(
        mutationErrorMessageForUser(caught, "Couldn't save the category. Please try again."),
      );
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3" aria-label={`Edit ${category.name}`}>
      <div className="space-y-1.5">
        <label htmlFor={inputId} className="block text-sm font-medium">
          Name
        </label>
        <input
          id={inputId}
          name="name"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            if (error) {
              setError(null);
            }
          }}
          maxLength={LIMITS.categoryNameMax}
          autoComplete="off"
          aria-invalid={error != null}
          aria-describedby={error ? errorId : undefined}
          className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm shadow-sm outline-none transition-[border-color,box-shadow] duration-150 focus:border-ring focus:ring-2 focus:ring-ring/30"
        />
      </div>

      <ColorPicker legend="Color" color={color} onChange={setColor} />

      {error ? (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div className="flex gap-2">
        <Button type="submit" disabled={submitting || name.trim() === ""}>
          {submitting ? "Saving…" : "Save"}
        </Button>
        <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * The archive/restore moderation affordance (creator or Owner — the server enforces
 * it, ADR 0015). The action derives from the row's own `status`.
 */
export function CategoryLifecycleButton({
  category,
  action,
}: {
  category: Category;
  action: "archive" | "restore";
}) {
  if (action === "restore") {
    return <RestoreLifecycleButton category={category} />;
  }
  return <ArchiveLifecycleButton category={category} />;
}

function ArchiveLifecycleButton({ category }: { category: Category }) {
  const archiveCategory = useArchiveCategory();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const copy = LIFECYCLE_COPY.archive;

  const runArchive = async () => {
    setPending(true);
    setError(null);
    try {
      await archiveCategory({ categoryId: category.id });
    } catch (caught) {
      console.error("archiveCategory failed", caught);
      setError(mutationErrorMessageForUser(caught, `${copy.error} Please try again.`));
    } finally {
      setPending(false);
    }
  };

  const { armed, getButtonProps } = useDoubleCheck({
    onConfirm: runArchive,
    identity: category.id,
  });
  const idleAriaLabel = `${copy.idle} ${category.name}`;

  return (
    <>
      <Button
        type="button"
        variant={armed && !pending ? "destructive" : "outline"}
        size="sm"
        disabled={pending}
        aria-label={
          pending ? idleAriaLabel : armed ? `${copy.confirm} ${category.name}` : idleAriaLabel
        }
        {...getButtonProps()}
      >
        {pending ? copy.busy : armed ? copy.confirm : copy.idle}
      </Button>
      {error ? (
        <p role="alert" className="w-full text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </>
  );
}

function RestoreLifecycleButton({ category }: { category: Category }) {
  const restoreCategory = useRestoreCategory();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const copy = LIFECYCLE_COPY.restore;

  const onClick = async () => {
    setPending(true);
    setError(null);
    try {
      await restoreCategory({ categoryId: category.id });
    } catch (caught) {
      console.error("restoreCategory failed", caught);
      setError(mutationErrorMessageForUser(caught, `${copy.error} Please try again.`));
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={onClick}
        aria-label={`${copy.idle} ${category.name}`}
      >
        {pending ? copy.busy : copy.idle}
      </Button>
      {error ? (
        <p role="alert" className="w-full text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </>
  );
}

/** Color swatch label for a Category's palette id. */
export function categoryColorSwatch(colorId: string) {
  return COLOR_PALETTE.find((entry) => entry.id === colorId);
}
