/**
 * Throwaway prototype. Three Global Add Transaction layouts, switchable through
 * `?variant=`, on the proposed `/transactions/new` route.
 */
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  CircleDollarSign,
  LoaderCircle,
  Plus,
} from "lucide-react";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import {
  PrototypeSwitcher,
  type PrototypeVariant,
  readPrototypeVariant,
} from "~/components/prototype-switcher.js";
import { Button } from "~/components/ui/button.js";
import { buttonVariants } from "~/components/ui/button-variants.js";
import { ModalDialog } from "~/components/ui/dialog.js";
import { cn } from "~/lib/utils.js";

const TYPES = ["expense", "income"] as const;
type TransactionType = (typeof TYPES)[number];

const CIRCLES = [
  { id: "personal", ref: "arpits-circle-personal", name: "Arpit's Circle", currency: "CAD" },
  { id: "home", ref: "shared-home-home", name: "Shared Home", currency: "CAD" },
  { id: "trip", ref: "montreal-trip-trip", name: "Montréal Trip", currency: "USD" },
] as const;

const CATEGORY_OPTIONS = {
  expense: ["Groceries", "Dining", "Transport"],
  income: ["Salary", "Refund", "Other income"],
};

type PendingChange = { kind: "circle"; value: string } | { kind: "type"; value: TransactionType };

function readType(value: string | null) {
  return TYPES.find((type) => type === value) ?? "expense";
}

export default function GlobalTransactionNewPrototype() {
  const [searchParams, setSearchParams] = useSearchParams();
  const variant = readPrototypeVariant(searchParams.get("variant"));
  const initialCircle = CIRCLES.find((circle) => circle.ref === searchParams.get("circle"));
  const [circleId, setCircleId] = useState(initialCircle?.id ?? "");
  const [type, setType] = useState(() => readType(searchParams.get("type")));
  const [title, setTitle] = useState("");
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [category, setCategory] = useState("");
  const [paidBy, setPaidBy] = useState("");
  const [note, setNote] = useState("");
  const [pendingChange, setPendingChange] = useState<PendingChange | null>(null);
  const [toast, setToast] = useState("");
  const [submitError, setSubmitError] = useState("");
  const [circleState, setCircleState] = useState<"ready" | "loading" | "empty">("ready");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const circle = CIRCLES.find((candidate) => candidate.id === circleId);
  const hasCircleScopedDraft = amount !== "" || category !== "" || paidBy !== "";

  const syncUrl = (nextType: TransactionType, nextCircleId: string) => {
    const params = new URLSearchParams(searchParams);
    params.set("type", nextType);
    const nextCircle = CIRCLES.find((candidate) => candidate.id === nextCircleId);
    if (nextCircle) params.set("circle", nextCircle.ref);
    else params.delete("circle");
    setSearchParams(params, { replace: true });
  };

  const applyCircle = (nextCircleId: string) => {
    setCircleId(nextCircleId);
    setAmount("");
    setCategory("");
    setPaidBy("");
    setSubmitError("");
    syncUrl(type, nextCircleId);
  };

  const requestCircle = (nextCircleId: string) => {
    if (nextCircleId === circleId) return;
    if (hasCircleScopedDraft) {
      setPendingChange({ kind: "circle", value: nextCircleId });
      return;
    }
    applyCircle(nextCircleId);
  };

  const applyType = (nextType: TransactionType) => {
    setType(nextType);
    setCategory("");
    setSubmitError("");
    syncUrl(nextType, circleId);
  };

  const requestType = (nextType: TransactionType) => {
    if (nextType === type) return;
    if (category) {
      setPendingChange({ kind: "type", value: nextType });
      return;
    }
    applyType(nextType);
  };

  const confirmChange = () => {
    if (!pendingChange) return;
    if (pendingChange.kind === "circle") applyCircle(pendingChange.value);
    else applyType(pendingChange.value);
    setPendingChange(null);
  };

  const invalidateCircle = () => {
    if (!circle) return;
    setCircleId("");
    setAmount("");
    setCategory("");
    setPaidBy("");
    syncUrl(type, "");
    setToast("That Circle is no longer available. Circle-specific fields were cleared.");
  };

  const changeCurrency = () => {
    if (!circle) return;
    setAmount("");
    setToast("The Circle's currency changed. Amount was cleared.");
  };

  const submit = () => {
    setSubmitError("");
    if (!circle) {
      setSubmitError("Choose a Circle before saving.");
      return;
    }
    if (!title || !amount || !category) {
      setSubmitError("Complete Title, Amount, and Category before saving.");
      return;
    }
    setSaving(true);
    window.setTimeout(() => {
      setSaving(false);
      setSaved(true);
    }, 650);
  };

  const props = {
    circle,
    circleId,
    type,
    title,
    amount,
    date,
    category,
    paidBy,
    note,
    circleState,
    saving,
    submitError,
    requestCircle,
    requestType,
    setTitle,
    setAmount,
    setDate,
    setCategory,
    setPaidBy,
    setNote,
    submit,
  };

  if (saved) {
    return (
      <div className="mx-auto max-w-xl space-y-5 py-12 text-center">
        <span className="mx-auto flex size-12 items-center justify-center rounded-full bg-positive/15 text-positive">
          <Check aria-hidden />
        </span>
        <div>
          <h1 className="font-display text-2xl font-semibold">Transaction created</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Production would open the new Transaction Detail and retain the Home return path.
          </p>
        </div>
        <Button type="button" variant="outline" onClick={() => setSaved(false)}>
          Return to prototype
        </Button>
        <PrototypeSwitcher current={variant} />
      </div>
    );
  }

  return (
    <>
      {toast ? (
        <div
          role="status"
          className="fixed top-4 right-4 z-40 max-w-sm rounded-lg border border-border bg-card px-4 py-3 text-sm shadow-lg"
        >
          {toast}
          <button type="button" className="ml-3 underline" onClick={() => setToast("")}>
            Dismiss
          </button>
        </div>
      ) : null}

      {variant === "A" ? <VariantA {...props} /> : null}
      {variant === "B" ? <VariantB {...props} /> : null}
      {variant === "C" ? <VariantC {...props} /> : null}

      <PrototypeStateInspector
        variant={variant}
        circle={circle?.name ?? "None"}
        type={type}
        title={title}
        amount={amount}
        category={category}
        paidBy={paidBy}
        note={note}
        date={date}
        onInvalidateCircle={invalidateCircle}
        onCurrencyChange={changeCurrency}
        onCircleStateChange={setCircleState}
        onSubmissionError={() => setSubmitError("Couldn't save the transaction. Please try again.")}
      />

      <ModalDialog
        open={pendingChange !== null}
        onOpenChange={(open) => {
          if (!open) setPendingChange(null);
        }}
        title={pendingChange?.kind === "type" ? "Change transaction type?" : "Change Circle?"}
        description={
          pendingChange?.kind === "type"
            ? "Your selected Category belongs to the current type."
            : "Amount, Categories, and Paid By belong to the current Circle."
        }
      >
        <div className="space-y-4">
          <div className="flex gap-3 rounded-lg bg-warning/10 p-3 text-sm">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
            <p>
              {pendingChange?.kind === "type"
                ? "Changing Type clears Categories. Your other entries stay."
                : "Changing Circle clears Amount, Categories, and Paid By. Type, Title, Note, and Date stay."}
            </p>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setPendingChange(null)}>
              Keep current
            </Button>
            <Button type="button" onClick={confirmChange}>
              {pendingChange?.kind === "type" ? "Change type" : "Change Circle"}
            </Button>
          </div>
        </div>
      </ModalDialog>
      <PrototypeSwitcher current={variant} />
    </>
  );
}

type FormProps = {
  circle: (typeof CIRCLES)[number] | undefined;
  circleId: string;
  type: TransactionType;
  title: string;
  amount: string;
  date: string;
  category: string;
  paidBy: string;
  note: string;
  circleState: "ready" | "loading" | "empty";
  saving: boolean;
  submitError: string;
  requestCircle: (value: string) => void;
  requestType: (value: TransactionType) => void;
  setTitle: (value: string) => void;
  setAmount: (value: string) => void;
  setDate: (value: string) => void;
  setCategory: (value: string) => void;
  setPaidBy: (value: string) => void;
  setNote: (value: string) => void;
  submit: () => void;
};

export function VariantA(props: FormProps) {
  return (
    <main className="mx-auto max-w-2xl space-y-5 pb-40">
      <PageHeading subtitle="Choose where it belongs, then record it." />
      <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
        <h2 className="text-sm font-semibold">Transaction context</h2>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <CircleField {...props} />
          <TypeField {...props} />
        </div>
      </section>
      <TransactionFields {...props} />
    </main>
  );
}

export function VariantB(props: FormProps) {
  return (
    <main className="mx-auto max-w-4xl space-y-5 pb-40">
      <PageHeading subtitle="Circle context stays visible while you fill the form." />
      <div className="grid gap-5 md:grid-cols-[15rem_1fr] md:items-start">
        <aside className="space-y-5 rounded-xl border border-border bg-card p-4 md:sticky md:top-4">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Where
            </p>
            <div className="mt-2">
              <CircleField {...props} hideLabel />
            </div>
          </div>
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              What
            </p>
            <div className="mt-2">
              <TypeField {...props} stacked />
            </div>
          </div>
          <p className="border-t border-border pt-4 text-xs text-muted-foreground">
            Switching Circle keeps Title, Note, Date, and Type. Circle-specific values reset after
            confirmation.
          </p>
        </aside>
        <TransactionFields {...props} compactHeader />
      </div>
    </main>
  );
}

export function VariantC(props: FormProps) {
  const ready = Boolean(props.circle);
  return (
    <main className="mx-auto max-w-2xl space-y-5 pb-40">
      <PageHeading subtitle="Start with the destination. The form follows." />
      <section className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <div className="border-b border-border p-5">
          <div className="flex items-center gap-3">
            <span className="flex size-7 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
              1
            </span>
            <h2 className="font-semibold">Choose Circle and Type</h2>
          </div>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <CircleField {...props} />
            <TypeField {...props} />
          </div>
        </div>
        <div className={cn("p-5", !ready && "bg-muted/30")}>
          <div className="mb-4 flex items-center gap-3">
            <span
              className={cn(
                "flex size-7 items-center justify-center rounded-full text-xs font-semibold",
                ready ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
              )}
            >
              2
            </span>
            <h2 className={cn("font-semibold", !ready && "text-muted-foreground")}>
              Transaction details
            </h2>
          </div>
          {ready ? (
            <TransactionFieldBody {...props} />
          ) : (
            <div className="rounded-lg border border-dashed border-border p-8 text-center">
              <CircleDollarSign className="mx-auto size-7 text-muted-foreground" aria-hidden />
              <p className="mt-3 text-sm font-medium">Choose a Circle to continue</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Currency, Categories, and Members depend on it.
              </p>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}

function PageHeading({ subtitle }: { subtitle: string }) {
  return (
    <header className="space-y-3">
      <Link
        to="/"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden /> Home
      </Link>
      <div>
        <h1 className="font-display text-2xl font-semibold tracking-tight">Add transaction</h1>
        <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>
      </div>
    </header>
  );
}

function CircleField({
  circleId,
  circleState,
  requestCircle,
  hideLabel = false,
}: FormProps & { hideLabel?: boolean }) {
  return (
    <div className="grid gap-1.5 text-sm font-medium">
      {hideLabel ? <span className="sr-only">Circle</span> : "Circle"}
      {circleState === "loading" ? (
        <span className="flex h-10 items-center gap-2 rounded-md border border-border px-3 text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" aria-hidden /> Loading Circles…
        </span>
      ) : circleState === "empty" ? (
        <span className="rounded-md border border-dashed border-border px-3 py-2 font-normal text-muted-foreground">
          No eligible Circles
        </span>
      ) : (
        <select
          aria-label="Circle"
          value={circleId}
          onChange={(event) => requestCircle(event.target.value)}
          className="h-10 rounded-md border border-border bg-background px-3 font-normal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <option value="">Choose a Circle</option>
          {CIRCLES.map((circle) => (
            <option key={circle.id} value={circle.id}>
              {circle.name} · {circle.currency}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

function TypeField({ type, requestType, stacked = false }: FormProps & { stacked?: boolean }) {
  return (
    <fieldset>
      <legend className="text-sm font-medium">Type</legend>
      <div
        className={cn(
          "mt-1.5 grid rounded-lg bg-muted p-1",
          stacked ? "grid-cols-1" : "grid-cols-2",
        )}
      >
        {TYPES.map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={type === option}
            onClick={() => requestType(option)}
            className={cn(
              "rounded-md px-3 py-2 text-sm capitalize focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              type === option
                ? "bg-card font-semibold shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {option}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function TransactionFields(props: FormProps & { compactHeader?: boolean }) {
  return (
    <section className="rounded-xl border border-border bg-card p-5 shadow-sm">
      {!props.compactHeader ? <h2 className="mb-4 text-sm font-semibold">Details</h2> : null}
      <TransactionFieldBody {...props} />
    </section>
  );
}

function TransactionFieldBody(props: FormProps) {
  const disabled = !props.circle || props.circleState !== "ready";
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        props.submit();
      }}
      className="space-y-4"
    >
      <label className="grid gap-1.5 text-sm font-medium">
        Title
        <input
          value={props.title}
          onChange={(event) => props.setTitle(event.target.value)}
          placeholder="e.g. Weekly shop"
          className="h-10 rounded-md border border-border bg-background px-3 font-normal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="grid gap-1.5 text-sm font-medium">
          Amount {props.circle ? `(${props.circle.currency})` : ""}
          <input
            disabled={disabled}
            inputMode="decimal"
            value={props.amount}
            onChange={(event) => props.setAmount(event.target.value)}
            placeholder={disabled ? "Choose Circle first" : "0.00"}
            className="h-10 min-w-0 rounded-md border border-border bg-background px-3 font-normal disabled:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
        <label className="grid gap-1.5 text-sm font-medium">
          Date
          <input
            type="date"
            value={props.date}
            onChange={(event) => props.setDate(event.target.value)}
            className="h-10 min-w-0 rounded-md border border-border bg-background px-3 font-normal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
      </div>
      <label className="grid gap-1.5 text-sm font-medium">
        Categories
        <select
          disabled={disabled}
          value={props.category}
          onChange={(event) => props.setCategory(event.target.value)}
          className="h-10 rounded-md border border-border bg-background px-3 font-normal disabled:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <option value="">{disabled ? "Choose Circle first" : "Choose a Category"}</option>
          {CATEGORY_OPTIONS[props.type].map((option) => (
            <option key={option}>{option}</option>
          ))}
        </select>
      </label>
      <label className="grid gap-1.5 text-sm font-medium">
        Paid by
        <select
          disabled={disabled}
          value={props.paidBy}
          onChange={(event) => props.setPaidBy(event.target.value)}
          className="h-10 rounded-md border border-border bg-background px-3 font-normal disabled:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <option value="">{disabled ? "Choose Circle first" : "You (default)"}</option>
          <option>Jamie</option>
          <option>Sam</option>
        </select>
      </label>
      <label className="grid gap-1.5 text-sm font-medium">
        Note <span className="sr-only">optional</span>
        <textarea
          value={props.note}
          onChange={(event) => props.setNote(event.target.value)}
          rows={2}
          placeholder="Extra context (optional)"
          className="rounded-md border border-border bg-background px-3 py-2 font-normal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </label>
      {props.submitError ? (
        <p role="alert" className="text-sm text-destructive">
          {props.submitError}
        </p>
      ) : null}
      <div className="flex justify-end gap-2 border-t border-border pt-4">
        <Link to="/" className={buttonVariants({ variant: "outline" })}>
          Cancel
        </Link>
        <Button type="submit" disabled={props.saving}>
          {props.saving ? (
            <>
              <LoaderCircle className="size-4 animate-spin" aria-hidden />
              Saving…
            </>
          ) : (
            <>
              <Plus className="size-4" aria-hidden />
              Add {props.type}
            </>
          )}
        </Button>
      </div>
    </form>
  );
}

function PrototypeStateInspector({
  variant,
  circle,
  type,
  title,
  amount,
  category,
  paidBy,
  note,
  date,
  onInvalidateCircle,
  onCurrencyChange,
  onCircleStateChange,
  onSubmissionError,
}: {
  variant: PrototypeVariant;
  circle: string;
  type: TransactionType;
  title: string;
  amount: string;
  category: string;
  paidBy: string;
  note: string;
  date: string;
  onInvalidateCircle: () => void;
  onCurrencyChange: () => void;
  onCircleStateChange: (state: "ready" | "loading" | "empty") => void;
  onSubmissionError: () => void;
}) {
  return (
    <details className="mx-auto mt-6 mb-28 w-[calc(100%-2rem)] max-w-2xl rounded-lg border border-border bg-card shadow-lg">
      <summary className="cursor-pointer px-4 py-3 text-xs font-semibold">
        Prototype state and failure controls
      </summary>
      <div className="space-y-3 border-t border-border p-4 text-xs">
        <pre className="max-h-36 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3">
          {JSON.stringify(
            {
              variant,
              circle,
              type,
              title,
              amount,
              category,
              paidBy: paidBy || "You (default)",
              note,
              date,
            },
            null,
            2,
          )}
        </pre>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" onClick={onInvalidateCircle}>
            Invalidate Circle
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={onCurrencyChange}>
            Change currency
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => onCircleStateChange("loading")}
          >
            Loading
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => onCircleStateChange("empty")}
          >
            No Circles
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => onCircleStateChange("ready")}
          >
            Restore
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={onSubmissionError}>
            Save error
          </Button>
        </div>
      </div>
    </details>
  );
}
