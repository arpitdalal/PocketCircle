import { Dialog } from "@base-ui/react/dialog";
import {
  CIRCLE_PURPOSES,
  type CircleSetupAnswers,
  circleSettingsColorChoices,
  colorHex,
  colorLabel,
  LIMITS,
  RESIDENCE_TYPES,
  SUPPORTED_CURRENCIES,
} from "@pocketcircle/domain";
import { type FormEvent, useId, useState } from "react";
import { href, Navigate, useNavigate } from "react-router";
import { CircleMark } from "~/components/circle-mark.js";
import { Button } from "~/components/ui/button.js";
import { buttonVariants } from "~/components/ui/button-variants.js";
import { mobileSheetBackdropClassName } from "~/components/ui/mobile-sheet-primitives.js";
import {
  type Member,
  useArchiveCircle,
  useCircleHasTransactions,
  useDeleteCircle,
  useMembers,
  useRenameCircle,
  useRestoreCircle,
  useSetCurrency,
  useSetPersonalCircleNameAutoSync,
  useUpdateCircleSettings,
} from "~/lib/data.js";
import { mutationErrorMessageForUser } from "~/lib/mutation-user-message.js";
import { useSnackbar } from "~/lib/snackbar.js";
import { useValueChange } from "~/lib/use-value-change.js";
import { cn } from "~/lib/utils.js";
import { useCircle } from "~/routes/layouts/circle-layout.js";

const PURPOSE_LABELS: Record<NonNullable<CircleSetupAnswers["purpose"]>, string> = {
  residence: "Residence",
  trip: "Trip",
  family: "Family",
  roommates: "Roommates",
  project: "Project",
  personal: "Personal",
  other: "Other",
};

const RESIDENCE_LABELS: Record<NonNullable<CircleSetupAnswers["residenceType"]>, string> = {
  leased: "Leased",
  owned: "Owned",
};

type PurposeChoice = NonNullable<CircleSetupAnswers["purpose"]> | "";
type ResidenceChoice = NonNullable<CircleSetupAnswers["residenceType"]> | "";

/**
 * Circle-scoped Settings (CS-2): Owner-only Color and Setup answers, plus rename via
 * the existing `renameCircle` mutation. Distinct from the user-level App Settings at
 * `/settings` (SET-1). Members who land here are redirected; the server enforces too.
 */
export default function CircleSettings() {
  const circle = useCircle();
  const navigate = useNavigate();
  const members = useMembers(circle.id);
  const hasTransactions = useCircleHasTransactions(circle.id);
  const renameCircle = useRenameCircle();
  const setCurrency = useSetCurrency();
  const archiveCircle = useArchiveCircle();
  const restoreCircle = useRestoreCircle();
  const deleteCircle = useDeleteCircle();
  const setPersonalCircleNameAutoSync = useSetPersonalCircleNameAutoSync();
  const updateSettings = useUpdateCircleSettings();
  const { show } = useSnackbar();

  const writable = circle.status === "active";

  const [name, setName] = useState(circle.name);
  const [color, setColor] = useState(circle.color);
  const [purpose, setPurpose] = useState<PurposeChoice>(circle.setupAnswers?.purpose ?? "");
  const [residenceType, setResidenceType] = useState<ResidenceChoice>(
    circle.setupAnswers?.residenceType ?? "",
  );
  const [nameError, setNameError] = useState<string | null>(null);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [savingName, setSavingName] = useState(false);
  const [syncingName, setSyncingName] = useState(false);
  const [savingColor, setSavingColor] = useState(false);
  const [savingCurrency, setSavingCurrency] = useState(false);
  const [savingSetup, setSavingSetup] = useState(false);
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [archiving, setArchiving] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const dashboardPath = href("/circles/:circleRef", { circleRef: circle.ref });

  useValueChange(circle, (current) => {
    setName(current.name);
    setColor(current.color);
    setPurpose(current.setupAnswers?.purpose ?? "");
    setResidenceType(current.setupAnswers?.residenceType ?? "");
  });

  if (members === undefined || hasTransactions === undefined) {
    return <p className="text-sm text-muted-foreground">Loading settings…</p>;
  }

  if (!viewerIsOwner(members)) {
    return <Navigate to={dashboardPath} replace />;
  }

  const currencyLocked = circle.currencyLocked || hasTransactions === true;

  const nameDirty = name.trim() !== circle.name;
  const setupDirty = setupAnswersChanged(circle.setupAnswers, setupAnswers(purpose, residenceType));
  const deletableEmpty =
    circle.kind === "regular" &&
    members !== null &&
    members.length === 1 &&
    hasTransactions === false;
  const showArchiveGuidance =
    circle.kind === "regular" && !deletableEmpty && (circle.setupComplete || !writable);

  async function onConfirmDelete() {
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteCircle({ circleId: circle.id });
      setDeleteDialogOpen(false);
      show("Circle deleted.");
      navigate("/");
    } catch (caught) {
      console.error("deleteCircle failed", caught);
      setDeleteError(
        mutationErrorMessageForUser(caught, "Couldn't delete this circle. Please try again."),
      );
    } finally {
      setDeleting(false);
    }
  }

  async function onToggleNameAutoSync() {
    setSyncingName(true);
    try {
      await setPersonalCircleNameAutoSync({ enabled: circle.nameCustomized });
    } catch (caught) {
      console.error("setPersonalCircleNameAutoSync failed", caught);
      show("Couldn't update name sync. Please try again.");
    } finally {
      setSyncingName(false);
    }
  }

  async function onSaveName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNameError(null);
    const trimmed = name.trim();
    if (trimmed === "") {
      setNameError("Name is required");
      return;
    }
    if (trimmed.length > LIMITS.circleNameMax) {
      setNameError(`Name must be at most ${LIMITS.circleNameMax} characters`);
      return;
    }
    if (trimmed === circle.name) {
      return;
    }

    setSavingName(true);
    try {
      await renameCircle({ circleId: circle.id, name: trimmed });
      show("Circle name updated.");
    } catch (caught) {
      console.error("renameCircle failed", caught);
      setNameError("Couldn't save the name. Please try again.");
    } finally {
      setSavingName(false);
    }
  }

  async function onPickCurrency(nextCurrency: string) {
    if (nextCurrency === circle.currency) {
      return;
    }
    setSavingCurrency(true);
    try {
      await setCurrency({ circleId: circle.id, currency: nextCurrency });
      show("Circle currency updated.");
    } catch (caught) {
      console.error("setCurrency failed", caught);
      show(mutationErrorMessageForUser(caught, "Couldn't save the currency. Please try again."));
    } finally {
      setSavingCurrency(false);
    }
  }

  async function onPickColor(nextColor: string) {
    if (nextColor === circle.color) {
      setColor(nextColor);
      return;
    }
    setColor(nextColor);
    setSavingColor(true);
    try {
      await updateSettings({ circleId: circle.id, color: nextColor });
      show("Circle color updated.");
    } catch (caught) {
      console.error("updateCircleSettings (color) failed", caught);
      setColor(circle.color);
      show("Couldn't save the color. Please try again.");
    } finally {
      setSavingColor(false);
    }
  }

  async function onSaveSetup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSetupError(null);
    const answers = setupAnswers(purpose, residenceType);
    if (!setupAnswersChanged(circle.setupAnswers, answers)) {
      return;
    }

    setSavingSetup(true);
    try {
      await updateSettings({ circleId: circle.id, setupAnswers: answers });
      show("Setup answers updated.");
    } catch (caught) {
      console.error("updateCircleSettings (setup) failed", caught);
      setSetupError("Couldn't save setup answers. Please try again.");
    } finally {
      setSavingSetup(false);
    }
  }

  async function onConfirmArchive() {
    setArchiving(true);
    setArchiveError(null);
    try {
      await archiveCircle({ circleId: circle.id });
      setArchiveDialogOpen(false);
      show("Circle archived.");
    } catch (caught) {
      console.error("archiveCircle failed", caught);
      setArchiveError(
        mutationErrorMessageForUser(caught, "Couldn't archive this circle. Please try again."),
      );
    } finally {
      setArchiving(false);
    }
  }

  async function onRestore() {
    setRestoring(true);
    setRestoreError(null);
    try {
      await restoreCircle({ circleId: circle.id });
      show("Circle restored.");
    } catch (caught) {
      console.error("restoreCircle failed", caught);
      setRestoreError(
        mutationErrorMessageForUser(caught, "Couldn't restore this circle. Please try again."),
      );
    } finally {
      setRestoring(false);
    }
  }

  const colorChoices = circleSettingsColorChoices(circle.kind);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h2 className="font-display text-lg font-semibold tracking-tight">Circle settings</h2>
        <p className="text-sm text-muted-foreground">
          {writable
            ? "Change how this circle looks and the setup context you picked."
            : "This circle is archived. Restore it to change settings."}
        </p>
      </div>

      <div className="flex items-center gap-3 rounded-xl border border-border bg-card p-4 shadow-sm">
        <CircleMark mark={circle.mark} color={color} className="size-12 text-base" />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{circle.name}</p>
          <p className="text-xs text-muted-foreground">
            Mark tint follows the circle color ({colorLabel(color)})
          </p>
          <p
            className="text-xs text-muted-foreground"
            data-testid="mark-tint"
            data-color-hex={colorHex(color)}
          >
            Preview uses {colorHex(color)}
          </p>
        </div>
      </div>

      <form
        onSubmit={onSaveName}
        className="space-y-4 rounded-xl border border-border bg-card p-5 shadow-sm"
      >
        <h3 className="text-sm font-medium">Name</h3>
        <fieldset disabled={!writable || savingName} className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="circle-settings-name" className="block text-sm text-muted-foreground">
              Circle name
            </label>
            <input
              id="circle-settings-name"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                if (nameError) {
                  setNameError(null);
                }
              }}
              maxLength={LIMITS.circleNameMax}
              autoComplete="off"
              aria-invalid={nameError != null}
              aria-describedby={nameError ? "circle-settings-name-error" : undefined}
              className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm shadow-sm outline-none transition-[border-color,box-shadow] duration-150 focus:border-ring focus:ring-2 focus:ring-ring/30"
            />
          </div>
          {nameError ? (
            <p id="circle-settings-name-error" role="alert" className="text-sm text-destructive">
              {nameError}
            </p>
          ) : null}
          {circle.kind === "personal" ? (
            <div className="space-y-1.5 rounded-lg border border-border/60 bg-muted/30 p-3">
              <div className="flex items-start gap-3">
                <input
                  id="circle-settings-name-auto-sync"
                  type="checkbox"
                  role="switch"
                  aria-checked={!circle.nameCustomized}
                  checked={!circle.nameCustomized}
                  disabled={syncingName}
                  onChange={() => void onToggleNameAutoSync()}
                  className="mt-0.5 size-4 shrink-0 rounded border border-input accent-primary"
                />
                <div className="space-y-1">
                  <label htmlFor="circle-settings-name-auto-sync" className="text-sm font-medium">
                    Match my display name
                  </label>
                  <p className="text-xs text-muted-foreground">
                    When on, your Personal Circle&apos;s name and icon update automatically whenever
                    you change your display name. Renaming it yourself turns this off.
                  </p>
                </div>
              </div>
            </div>
          ) : null}
          <Button type="submit" disabled={!writable || !nameDirty || savingName}>
            {savingName ? "Saving…" : "Save name"}
          </Button>
        </fieldset>
      </form>

      <fieldset
        disabled={!writable || savingCurrency}
        className="space-y-4 rounded-xl border border-border bg-card p-5 shadow-sm"
      >
        <legend className="text-sm font-medium">Currency</legend>
        {currencyLocked ? (
          <>
            <p className="text-sm">{currencyOptionLabel(circle.currency)}</p>
            <p className="text-xs text-muted-foreground">
              Locked once the circle has a transaction.
            </p>
          </>
        ) : (
          <>
            <div className="space-y-1.5">
              <label
                htmlFor="circle-settings-currency"
                className="block text-sm text-muted-foreground"
              >
                Circle currency
              </label>
              <select
                id="circle-settings-currency"
                value={circle.currency}
                onChange={(event) => void onPickCurrency(event.target.value)}
                className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm shadow-sm outline-none transition-[border-color,box-shadow] duration-150 focus:border-ring focus:ring-2 focus:ring-ring/30"
              >
                {SUPPORTED_CURRENCIES.map((option) => (
                  <option key={option.code} value={option.code}>
                    {option.code} · {option.name}
                  </option>
                ))}
              </select>
            </div>
            <p className="text-xs text-muted-foreground">
              Every transaction in this circle uses this currency. It locks once the circle has a
              transaction.
            </p>
          </>
        )}
      </fieldset>

      <fieldset
        disabled={!writable || savingColor}
        className="space-y-4 rounded-xl border border-border bg-card p-5 shadow-sm"
      >
        <legend className="text-sm font-medium">Color</legend>
        <div className="flex flex-wrap gap-2">
          {colorChoices.map((paletteColor) => (
            <button
              key={paletteColor.id}
              type="button"
              aria-label={paletteColor.name}
              aria-pressed={color === paletteColor.id}
              onClick={() => void onPickColor(paletteColor.id)}
              style={{ backgroundColor: paletteColor.hex }}
              className={cn(
                "size-7 rounded-full ring-offset-2 ring-offset-background transition",
                color === paletteColor.id ? "ring-2 ring-ring" : "ring-0",
              )}
            />
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{colorLabel(color)}</p>
      </fieldset>

      <form
        onSubmit={onSaveSetup}
        className="space-y-4 rounded-xl border border-border bg-card p-5 shadow-sm"
      >
        <h3 className="text-sm font-medium">Setup answers</h3>
        <fieldset disabled={!writable || savingSetup} className="space-y-4">
          <p className="text-xs text-muted-foreground">
            Changing these does not add or remove existing categories.
          </p>

          <div className="space-y-1.5">
            <label htmlFor="settings-purpose" className="block text-sm font-medium">
              Circle use
            </label>
            <select
              id="settings-purpose"
              value={purpose}
              onChange={(event) => {
                const next = normalizePurpose(event.target.value);
                setPurpose(next);
                if (next !== "residence") {
                  setResidenceType("");
                }
                if (setupError) {
                  setSetupError(null);
                }
              }}
              className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm shadow-sm outline-none transition-[border-color,box-shadow] duration-150 focus:border-ring focus:ring-2 focus:ring-ring/30"
            >
              <option value="">Not set</option>
              {CIRCLE_PURPOSES.map((option) => (
                <option key={option} value={option}>
                  {PURPOSE_LABELS[option]}
                </option>
              ))}
            </select>
          </div>

          {purpose === "residence" ? (
            <div className="space-y-1.5">
              <label htmlFor="settings-residence-type" className="block text-sm font-medium">
                Residence type
              </label>
              <select
                id="settings-residence-type"
                value={residenceType}
                onChange={(event) => {
                  setResidenceType(normalizeResidenceType(event.target.value));
                  if (setupError) {
                    setSetupError(null);
                  }
                }}
                className="w-full rounded-md border border-input bg-card px-3 py-2 text-sm shadow-sm outline-none transition-[border-color,box-shadow] duration-150 focus:border-ring focus:ring-2 focus:ring-ring/30"
              >
                <option value="">Not set</option>
                {RESIDENCE_TYPES.map((option) => (
                  <option key={option} value={option}>
                    {RESIDENCE_LABELS[option]}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {setupError ? (
            <p role="alert" className="text-sm text-destructive">
              {setupError}
            </p>
          ) : null}

          <Button type="submit" disabled={!writable || !setupDirty || savingSetup}>
            {savingSetup ? "Saving…" : "Save setup answers"}
          </Button>
        </fieldset>
      </form>

      {circle.kind === "regular" && (circle.setupComplete || !writable) ? (
        <ArchiveRestoreSection
          writable={writable}
          archiving={archiving}
          restoring={restoring}
          archiveDialogOpen={archiveDialogOpen}
          onArchiveDialogOpenChange={(open) => {
            setArchiveDialogOpen(open);
            if (!open) {
              setArchiveError(null);
            }
          }}
          archiveError={archiveError}
          restoreError={restoreError}
          onOpenArchiveDialog={() => setArchiveDialogOpen(true)}
          onConfirmArchive={() => void onConfirmArchive()}
          onRestore={() => void onRestore()}
        />
      ) : null}

      {circle.kind === "regular" ? (
        <DeleteCircleSection
          deletable={deletableEmpty}
          showArchiveGuidance={showArchiveGuidance}
          deleting={deleting}
          deleteDialogOpen={deleteDialogOpen}
          onDeleteDialogOpenChange={(open) => {
            setDeleteDialogOpen(open);
            if (!open) {
              setDeleteError(null);
            }
          }}
          deleteError={deleteError}
          onOpenDeleteDialog={() => setDeleteDialogOpen(true)}
          onConfirmDelete={() => void onConfirmDelete()}
        />
      ) : null}
    </div>
  );
}

function DeleteCircleSection({
  deletable,
  showArchiveGuidance,
  deleting,
  deleteDialogOpen,
  onDeleteDialogOpenChange,
  deleteError,
  onOpenDeleteDialog,
  onConfirmDelete,
}: {
  deletable: boolean;
  showArchiveGuidance: boolean;
  deleting: boolean;
  deleteDialogOpen: boolean;
  onDeleteDialogOpenChange: (open: boolean) => void;
  deleteError: string | null;
  onOpenDeleteDialog: () => void;
  onConfirmDelete: () => void;
}) {
  return (
    <section className="space-y-3 rounded-xl border border-destructive/30 bg-card p-5 shadow-sm">
      <h3 className="text-sm font-medium text-destructive">Delete circle</h3>
      {deletable ? (
        <>
          <p className="text-sm text-muted-foreground">
            Permanently remove this circle. Only available when you are the sole member and no
            transactions exist. Pending invitations are revoked and this cannot be undone.
          </p>
          <Button
            type="button"
            variant="outline"
            className="border-destructive/40 text-destructive hover:bg-destructive/10"
            onClick={onOpenDeleteDialog}
          >
            Delete circle
          </Button>
          <DeleteCircleDialog
            open={deleteDialogOpen}
            onOpenChange={onDeleteDialogOpenChange}
            onConfirm={onConfirmDelete}
            confirming={deleting}
            error={deleteError}
          />
        </>
      ) : showArchiveGuidance ? (
        <p className="text-sm text-muted-foreground">
          This circle has members or transaction history, so it cannot be deleted. Archive it
          instead to hide it while keeping the record.
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">
          Delete is only available for a circle with no other members and no transactions.
        </p>
      )}
    </section>
  );
}

function DeleteCircleDialog({
  open,
  onOpenChange,
  onConfirm,
  confirming,
  error,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  confirming: boolean;
  error: string | null;
}) {
  const titleId = useId();
  const descriptionId = useId();

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className={mobileSheetBackdropClassName} />
        <Dialog.Popup
          role="alertdialog"
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          className={cn(
            "fixed top-1/2 left-1/2 z-50 w-[min(100%-2rem,24rem)] -translate-x-1/2 -translate-y-1/2",
            "space-y-4 rounded-xl border border-border bg-card p-5 shadow-xl outline-none",
            "data-open:animate-fade-in",
          )}
        >
          <Dialog.Title id={titleId} className="font-display text-lg font-semibold tracking-tight">
            Delete circle permanently?
          </Dialog.Title>
          <Dialog.Description id={descriptionId} className="text-sm text-muted-foreground">
            This removes the circle, its categories, invitations, and history. It cannot be undone.
          </Dialog.Description>

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Dialog.Close
              type="button"
              disabled={confirming}
              className={cn(buttonVariants({ variant: "outline" }))}
            >
              Cancel
            </Dialog.Close>
            <Button
              type="button"
              disabled={confirming}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={onConfirm}
            >
              {confirming ? "Deleting…" : "Delete circle"}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ArchiveRestoreSection({
  writable,
  archiving,
  restoring,
  archiveDialogOpen,
  onArchiveDialogOpenChange,
  archiveError,
  restoreError,
  onOpenArchiveDialog,
  onConfirmArchive,
  onRestore,
}: {
  writable: boolean;
  archiving: boolean;
  restoring: boolean;
  archiveDialogOpen: boolean;
  onArchiveDialogOpenChange: (open: boolean) => void;
  archiveError: string | null;
  restoreError: string | null;
  onOpenArchiveDialog: () => void;
  onConfirmArchive: () => void;
  onRestore: () => void;
}) {
  return (
    <section className="space-y-3 rounded-xl border border-border bg-card p-5 shadow-sm">
      <h3 className="text-sm font-medium">{writable ? "Archive circle" : "Restore circle"}</h3>
      {writable ? (
        <>
          <p className="text-sm text-muted-foreground">
            Archive a finished circle to hide it from active views. Members can still read history,
            but nothing can be edited until you restore it. Pending invitations are revoked.
          </p>
          <Button
            type="button"
            variant="outline"
            className="border-destructive/40 text-destructive hover:bg-destructive/10"
            onClick={onOpenArchiveDialog}
          >
            Archive circle
          </Button>
          <ArchiveCircleDialog
            open={archiveDialogOpen}
            onOpenChange={onArchiveDialogOpenChange}
            onConfirm={onConfirmArchive}
            confirming={archiving}
            error={archiveError}
          />
        </>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            Restore this circle to make it active again. Revoked invitations stay revoked —
            re-invite members if needed.
          </p>
          {restoreError ? (
            <p role="alert" className="text-sm text-destructive">
              {restoreError}
            </p>
          ) : null}
          <Button type="button" disabled={restoring} onClick={onRestore}>
            {restoring ? "Restoring…" : "Restore circle"}
          </Button>
        </>
      )}
    </section>
  );
}

function ArchiveCircleDialog({
  open,
  onOpenChange,
  onConfirm,
  confirming,
  error,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  confirming: boolean;
  error: string | null;
}) {
  const titleId = useId();
  const descriptionId = useId();

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className={mobileSheetBackdropClassName} />
        <Dialog.Popup
          role="alertdialog"
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
          className={cn(
            "fixed top-1/2 left-1/2 z-50 w-[min(100%-2rem,24rem)] -translate-x-1/2 -translate-y-1/2",
            "space-y-4 rounded-xl border border-border bg-card p-5 shadow-xl outline-none",
            "data-open:animate-fade-in",
          )}
        >
          <Dialog.Title id={titleId} className="font-display text-lg font-semibold tracking-tight">
            Archive circle?
          </Dialog.Title>
          <Dialog.Description id={descriptionId} className="text-sm text-muted-foreground">
            This circle becomes read-only for everyone. Pending invitations are revoked. You can
            restore it later from settings.
          </Dialog.Description>

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Dialog.Close
              type="button"
              disabled={confirming}
              className={cn(buttonVariants({ variant: "outline" }))}
            >
              Cancel
            </Dialog.Close>
            <Button
              type="button"
              disabled={confirming}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={onConfirm}
            >
              {confirming ? "Archiving…" : "Archive circle"}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function viewerIsOwner(members: Member[] | null) {
  return members?.find((member) => member.isSelf)?.role === "owner";
}

function setupAnswers(purpose: PurposeChoice, residenceType: ResidenceChoice) {
  if (purpose === "") {
    return {};
  }
  if (purpose === "residence") {
    return { purpose, ...(residenceType ? { residenceType } : {}) };
  }
  return { purpose };
}

function normalizePurpose(value: string) {
  return CIRCLE_PURPOSES.find((option) => option === value) ?? "";
}

function normalizeResidenceType(value: string) {
  return RESIDENCE_TYPES.find((option) => option === value) ?? "";
}

function setupAnswersChanged(before: CircleSetupAnswers | undefined, after: CircleSetupAnswers) {
  return before?.purpose !== after.purpose || before?.residenceType !== after.residenceType;
}

function currencyOptionLabel(code: string) {
  const match = SUPPORTED_CURRENCIES.find((option) => option.code === code);
  return match ? `${match.code} · ${match.name}` : code;
}
