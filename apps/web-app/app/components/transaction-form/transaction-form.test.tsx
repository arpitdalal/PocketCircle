import {
  currentMonth,
  MUTATION_ERRORS,
  mutationErrorData,
  paletteColorForSeed,
  toPlainDate,
} from "@pocketcircle/domain";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Category, Circle, Member, Transaction } from "~/lib/data.js";
import {
  configureConvex,
  inlineCreateTransactionFormCategory,
  makeCategoryView,
  makeCircleView,
  makeMemberView,
  makeTransactionView,
  pickTransactionFormCategory,
  testId,
} from "~/test/convex-react.js";
import {
  posthogSdk,
  primeAnalyticsForTests,
  resetPostHogBoundary,
} from "~/test/posthog-boundary.js";

/**
 * Behavior test for the shared Transaction form (jsdom). The ONLY doubled thing is
 * Convex's reactive client (via the shared helper); the real `~/lib/data.js` hooks,
 * the real TanStack Form wiring, and the real field/validation/Type-Change logic run.
 * The form is mounted DIRECTLY (no route) because it is the reusable unit both the
 * inline create (Monthly Ledger) and the edit object route render — testing it here
 * once keeps the route tests about routing, not about field rules (ADR 0006/0020).
 */
vi.mock("convex/react", async () => (await import("~/test/convex-react.js")).convexReactMock);
vi.mock("posthog-js", async () => (await import("~/test/posthog-mock.js")).posthogModuleMock);
vi.mock("~/lib/env.js", async (importOriginal) =>
  (await import("~/test/posthog-mock.js")).createPosthogEnvMock(importOriginal),
);

import { TransactionForm, type TransactionFormMode } from "./index.js";

const createTransaction = vi.fn();
const updateTransaction = vi.fn();
const createCategory = vi.fn();

/** What the helper accepts for a create: the real create mode minus `selectedMonth`, which
 * `renderForm` injects (defaulting to the current month) so a test needn't repeat it; the
 * edit variant is passed through unchanged. */
type FormModeInput =
  | Omit<Extract<TransactionFormMode, { kind: "create" }>, "selectedMonth">
  | Extract<TransactionFormMode, { kind: "edit" }>;

function renderForm(
  mode: FormModeInput,
  opts: {
    circle?: Partial<Circle>;
    categories?: Category[] | null;
    members?: Member[] | null;
    selectedMonth?: string;
  } = {},
) {
  const circle = makeCircleView(opts.circle);
  createTransaction.mockReset();
  createTransaction.mockResolvedValue("new-id");
  updateTransaction.mockReset();
  updateTransaction.mockResolvedValue("t1");
  createCategory.mockReset();
  createCategory.mockResolvedValue(testId<Category["id"]>("cat-new"));
  configureConvex({
    categories: opts.categories === undefined ? [makeCategoryView()] : opts.categories,
    members: opts.members === undefined ? [makeMemberView()] : opts.members,
    createTransaction,
    updateTransaction,
    createCategory,
  });
  const onClose = vi.fn();
  // Default the selected month to the current one so a create's date defaults to today
  // (the common record-as-you-go case); tests that care about back-dating pass a month.
  const month = opts.selectedMonth ?? currentMonth(new Date());
  const realMode: TransactionFormMode =
    mode.kind === "create" ? { ...mode, selectedMonth: month } : mode;
  const ui = () => <TransactionForm circle={circle} mode={realMode} onClose={onClose} />;
  const result = render(ui());
  return { onClose, circle, ...result, rerenderForm: () => result.rerender(ui()) };
}

const createExpense: FormModeInput = { kind: "create", type: "expense" };

beforeEach(() => {
  primeAnalyticsForTests();
});

afterEach(() => {
  resetPostHogBoundary();
  vi.clearAllMocks();
});

describe("TransactionForm — create", () => {
  it("scopes categories to the form's type", async () => {
    const user = userEvent.setup();
    renderForm(createExpense, {
      categories: [
        makeCategoryView({ name: "Groceries", type: "expense" }),
        makeCategoryView({ id: testId<Category["id"]>("i1"), name: "Salary", type: "income" }),
      ],
    });
    const form = screen.getByRole("form", { name: /add expense/i });
    await user.click(within(form).getByRole("combobox", { name: "Categories" }));
    expect(await screen.findByRole("option", { name: "Groceries" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Salary" })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
  });

  it("filters category options by search query", async () => {
    const user = userEvent.setup();
    renderForm(createExpense, {
      categories: [
        makeCategoryView({ name: "Groceries", type: "expense" }),
        makeCategoryView({
          id: testId<Category["id"]>("cat-gas"),
          name: "Gas",
          type: "expense",
        }),
      ],
    });
    const form = screen.getByRole("form", { name: /add expense/i });
    const categoryCombo = within(form).getByRole("combobox", { name: "Categories" });
    await user.click(categoryCombo);
    await user.type(categoryCombo, "Groc");
    expect(await screen.findByRole("option", { name: "Groceries" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Gas" })).not.toBeInTheDocument();
    await user.clear(categoryCombo);
    await user.type(categoryCombo, "zzz");
    expect(await screen.findByRole("option", { name: 'Create "zzz"' })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Groceries" })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
  });

  it("submits a new expense with parsed minor units and the default Paid By", async () => {
    const user = userEvent.setup();
    const { onClose } = renderForm(createExpense, {
      categories: [makeCategoryView({ name: "Groceries", type: "expense" })],
    });
    const form = screen.getByRole("form", { name: /add expense/i });
    await user.type(within(form).getByLabelText("Title"), "Weekly shop");
    await user.type(within(form).getByLabelText(/Amount/), "12.5");
    await pickTransactionFormCategory(user, form, "Groceries");
    await user.click(within(form).getByRole("button", { name: "Add expense" }));

    expect(createTransaction).toHaveBeenCalledWith({
      circleId: "c1",
      type: "expense",
      title: "Weekly shop",
      note: undefined,
      amountMinorUnits: 1250,
      date: toPlainDate(new Date()),
      categoryIds: ["cat-groceries"],
      paidByMemberId: undefined, // "Me" default omits → server defaults to creator
    });
    expect(posthogSdk.capture).toHaveBeenCalledWith("transaction_added", {
      type: "expense",
      paidBySelf: true,
      categoryCount: 1,
    });
    expect(onClose).toHaveBeenCalled(); // a successful save closes the form
  });

  it("defaults the date into the selected (non-current) month", async () => {
    const user = userEvent.setup();
    renderForm(createExpense, {
      categories: [makeCategoryView({ name: "Groceries", type: "expense" })],
      selectedMonth: "2026-03",
    });
    const form = screen.getByRole("form", { name: /add expense/i });
    expect(within(form).getByLabelText("Date")).toHaveValue("2026-03-01");

    await user.type(within(form).getByLabelText("Title"), "Back-dated");
    await user.type(within(form).getByLabelText(/Amount/), "10");
    await pickTransactionFormCategory(user, form, "Groceries");
    await user.click(within(form).getByRole("button", { name: "Add expense" }));
    expect(createTransaction).toHaveBeenCalledWith(expect.objectContaining({ date: "2026-03-01" }));
  });

  it("sends the selected Paid By Member id when changed away from Me", async () => {
    const user = userEvent.setup();
    renderForm(createExpense, {
      categories: [makeCategoryView({ name: "Groceries", type: "expense" })],
      members: [
        makeMemberView(),
        makeMemberView({
          id: testId<Member["id"]>("mem-alex"),
          displayName: "Alex",
          isSelf: false,
        }),
      ],
    });
    const form = screen.getByRole("form", { name: /add expense/i });
    await user.type(within(form).getByLabelText("Title"), "Dinner");
    await user.type(within(form).getByLabelText(/Amount/), "20");
    await pickTransactionFormCategory(user, form, "Groceries");
    await user.selectOptions(within(form).getByLabelText("Paid by"), "mem-alex");
    await user.click(within(form).getByRole("button", { name: "Add expense" }));

    expect(createTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ paidByMemberId: "mem-alex" }),
    );
  });

  it("blocks creating when the selected Paid By member is removed mid-form", async () => {
    const user = userEvent.setup();
    const members: Member[] = [
      makeMemberView(),
      makeMemberView({ id: testId<Member["id"]>("mem-y"), displayName: "Yuki", isSelf: false }),
    ];
    const { rerenderForm } = renderForm(createExpense, {
      categories: [makeCategoryView({ name: "Groceries", type: "expense" })],
      members,
    });
    const form = screen.getByRole("form", { name: /add expense/i });
    await user.type(within(form).getByLabelText("Title"), "Dinner");
    await user.type(within(form).getByLabelText(/Amount/), "20");
    await pickTransactionFormCategory(user, form, "Groceries");
    await user.selectOptions(within(form).getByLabelText("Paid by"), "mem-y");

    members.splice(1, 1); // Yuki removed mid-form
    rerenderForm();
    await user.click(within(form).getByRole("button", { name: "Add expense" }));

    expect(await within(form).findByText(/no longer a member/i)).toBeInTheDocument();
    expect(createTransaction).not.toHaveBeenCalled();
  });

  it("reveals required errors on submit and does not create when fields are empty", async () => {
    const user = userEvent.setup();
    renderForm(createExpense, {
      categories: [makeCategoryView({ name: "Groceries", type: "expense" })],
    });
    const form = screen.getByRole("form", { name: /add expense/i });
    await user.click(within(form).getByRole("button", { name: "Add expense" }));

    expect(await within(form).findByText("Title is required")).toBeInTheDocument();
    expect(within(form).getByText("Amount is required")).toBeInTheDocument();
    expect(within(form).getByText("Pick at least one category")).toBeInTheDocument();
    expect(createTransaction).not.toHaveBeenCalled();
  });

  it("shows a field error on blur once a field is edited and invalid", async () => {
    const user = userEvent.setup();
    renderForm(createExpense, {
      categories: [makeCategoryView({ name: "Groceries", type: "expense" })],
    });
    const form = screen.getByRole("form", { name: /add expense/i });
    await user.type(within(form).getByLabelText(/Amount/), "0");
    await user.tab();
    expect(await within(form).findByText("Amount must be greater than zero")).toBeInTheDocument();
  });

  it("stays quiet when a required field is focused and blurred without typing", async () => {
    const user = userEvent.setup();
    renderForm(createExpense, {
      categories: [makeCategoryView({ name: "Groceries", type: "expense" })],
    });
    const form = screen.getByRole("form", { name: /add expense/i });
    await user.click(within(form).getByLabelText("Title"));
    await user.tab();
    expect(within(form).queryByText("Title is required")).not.toBeInTheDocument();
  });

  it("stays quiet when Amount is focused and blurred without typing (no dirty blur normalize)", async () => {
    const user = userEvent.setup();
    renderForm(createExpense, {
      categories: [makeCategoryView({ name: "Groceries", type: "expense" })],
    });
    const form = screen.getByRole("form", { name: /add expense/i });
    await user.click(within(form).getByLabelText(/Amount/));
    await user.tab();
    expect(within(form).queryByText("Amount is required")).not.toBeInTheDocument();
  });

  it("keeps a category archived mid-edit visible and blocks submit (PRD 57)", async () => {
    const user = userEvent.setup();
    const cats: Category[] = [
      makeCategoryView({ id: testId<Category["id"]>("cat-x"), name: "Snacks", type: "expense" }),
    ];
    const { rerenderForm } = renderForm(createExpense, { categories: cats });
    const form = screen.getByRole("form", { name: /add expense/i });
    await user.type(within(form).getByLabelText("Title"), "Movie night");
    await user.type(within(form).getByLabelText(/Amount/), "10");
    await pickTransactionFormCategory(user, form, "Snacks");

    cats[0] = makeCategoryView({
      id: testId<Category["id"]>("cat-x"),
      name: "Snacks",
      type: "expense",
      status: "archived",
    });
    rerenderForm();

    expect(within(form).getByText(/Snacks · archived/)).toBeInTheDocument();
    expect(within(form).getByRole("alert")).toHaveTextContent(/"Snacks" was archived/);
    await user.click(within(form).getByRole("button", { name: "Add expense" }));
    expect(createTransaction).not.toHaveBeenCalled();

    await user.click(within(form).getByRole("button", { name: /Remove Snacks/ }));
    expect(within(form).queryByText(/Snacks · archived/)).not.toBeInTheDocument();
  });

  it("surfaces a generic error and reports the failure when the create fails", async () => {
    const user = userEvent.setup();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    renderForm(createExpense, {
      categories: [makeCategoryView({ name: "Groceries", type: "expense" })],
    });
    createTransaction.mockRejectedValueOnce(new Error("Network down"));

    const form = screen.getByRole("form", { name: /add expense/i });
    await user.type(within(form).getByLabelText("Title"), "Weekly shop");
    await user.type(within(form).getByLabelText(/Amount/), "10");
    await pickTransactionFormCategory(user, form, "Groceries");
    await user.click(within(form).getByRole("button", { name: "Add expense" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/Couldn't save the transaction/i);
    expect(alert).not.toHaveTextContent(/Network down/);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("inline-creates a category from zero active categories and auto-selects it", async () => {
    const user = userEvent.setup();
    const newId = testId<Category["id"]>("cat-snacks");
    renderForm(createExpense, { categories: [] });
    createCategory.mockResolvedValueOnce(newId);
    const form = screen.getByRole("form", { name: /add expense/i });
    await inlineCreateTransactionFormCategory(user, form, "Snacks");

    expect(createCategory).toHaveBeenCalledWith({
      circleId: "c1",
      name: "Snacks",
      type: "expense",
      color: paletteColorForSeed("snacks").id,
    });
    expect(posthogSdk.capture).toHaveBeenCalledWith("category_created", {
      type: "expense",
      source: "transaction_inline",
    });
    expect(within(form).getByRole("button", { name: /Remove Snacks/ })).toBeInTheDocument();
  });

  it("inline-creates a category, auto-selects it, and submits with the new id", async () => {
    const user = userEvent.setup();
    const newId = testId<Category["id"]>("cat-snacks");
    const { onClose } = renderForm(createExpense, { categories: [] });
    createCategory.mockResolvedValueOnce(newId);
    const form = screen.getByRole("form", { name: /add expense/i });
    await user.type(within(form).getByLabelText("Title"), "Movie night");
    await user.type(within(form).getByLabelText(/Amount/), "10");
    await inlineCreateTransactionFormCategory(user, form, "Snacks");
    await user.click(within(form).getByRole("button", { name: "Add expense" }));

    expect(createCategory).toHaveBeenCalledWith({
      circleId: "c1",
      name: "Snacks",
      type: "expense",
      color: paletteColorForSeed("snacks").id,
    });
    expect(createTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ categoryIds: [newId] }),
    );
    expect(onClose).toHaveBeenCalled();
  });

  it("hides inline-create when the typed name matches an active category", async () => {
    const user = userEvent.setup();
    renderForm(createExpense, {
      categories: [makeCategoryView({ name: "Groceries", type: "expense" })],
    });
    const form = screen.getByRole("form", { name: /add expense/i });
    const combo = within(form).getByRole("combobox", { name: "Categories" });
    await user.click(combo);
    await user.type(combo, "Groceries");

    expect(screen.queryByRole("option", { name: 'Create "Groceries"' })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
  });

  it("shows a reserved-name message for an archived category name without creating", async () => {
    const user = userEvent.setup();
    renderForm(createExpense, {
      categories: [
        makeCategoryView({
          id: testId<Category["id"]>("cat-old"),
          name: "OldCat",
          type: "expense",
          status: "archived",
        }),
      ],
    });
    const form = screen.getByRole("form", { name: /add expense/i });
    const combo = within(form).getByRole("combobox", { name: "Categories" });
    await user.click(combo);
    await user.type(combo, "OldCat");

    expect(
      await screen.findByText(/A category named .OldCat. already exists but is archived/),
    ).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: 'Create "OldCat"' })).not.toBeInTheDocument();
    expect(createCategory).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
  });

  it("surfaces a friendly inline error when createCategory rejects with a duplicate name", async () => {
    const user = userEvent.setup();
    renderForm(createExpense, { categories: [] });
    createCategory.mockRejectedValueOnce(
      new ConvexError(mutationErrorData(MUTATION_ERRORS.categoryNameDuplicate)),
    );
    const form = screen.getByRole("form", { name: /add expense/i });
    await inlineCreateTransactionFormCategory(user, form, "Snacks", { waitForSelection: false });

    expect(
      await screen.findByText(MUTATION_ERRORS.categoryNameDuplicate.message),
    ).toBeInTheDocument();
    expect(within(form).queryByRole("button", { name: /Remove Snacks/ })).not.toBeInTheDocument();
  });

  it("surfaces a generic inline error when createCategory rejects for another reason", async () => {
    const user = userEvent.setup();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    renderForm(createExpense, { categories: [] });
    createCategory.mockRejectedValueOnce(
      new ConvexError(mutationErrorData(MUTATION_ERRORS.circleArchived)),
    );
    const form = screen.getByRole("form", { name: /add expense/i });
    await inlineCreateTransactionFormCategory(user, form, "Snacks", { waitForSelection: false });

    expect(await screen.findByText(MUTATION_ERRORS.circleArchived.message)).toBeInTheDocument();
    expect(within(form).queryByRole("button", { name: /Remove Snacks/ })).not.toBeInTheDocument();
    consoleError.mockRestore();
  });

  it("clears the category search input after a successful inline create", async () => {
    const user = userEvent.setup();
    const newId = testId<Category["id"]>("cat-rent");
    renderForm(createExpense, { categories: [] });
    createCategory.mockResolvedValueOnce(newId);
    const form = screen.getByRole("form", { name: /add expense/i });
    const combo = within(form).getByRole("combobox", { name: "Categories" });
    await user.click(combo);
    await user.type(combo, "Rent");
    await user.click(await screen.findByRole("option", { name: 'Create "Rent"' }));

    expect(within(form).getByRole("button", { name: /Remove Rent/ })).toBeInTheDocument();
    expect(combo).toHaveValue("");
    await user.keyboard("{Escape}");
  });

  it("keeps the category search text when inline create fails", async () => {
    const user = userEvent.setup();
    renderForm(createExpense, { categories: [] });
    createCategory.mockRejectedValueOnce(
      new ConvexError(mutationErrorData(MUTATION_ERRORS.categoryNameDuplicate)),
    );
    const form = screen.getByRole("form", { name: /add expense/i });
    const combo = within(form).getByRole("combobox", { name: "Categories" });
    await user.click(combo);
    await user.type(combo, "Rent");
    await user.click(await screen.findByRole("option", { name: 'Create "Rent"' }));

    expect(combo).toHaveValue("Rent");
    expect(
      await screen.findByText(MUTATION_ERRORS.categoryNameDuplicate.message),
    ).toBeInTheDocument();
    await user.keyboard("{Escape}");
  });

  it("creates a category from the keyboard-highlighted create option", async () => {
    const user = userEvent.setup();
    const newId = testId<Category["id"]>("cat-rent");
    renderForm(createExpense, { categories: [] });
    createCategory.mockResolvedValueOnce(newId);
    const form = screen.getByRole("form", { name: /add expense/i });
    const combo = within(form).getByRole("combobox", { name: "Categories" });
    await user.click(combo);
    await user.type(combo, "Rent");
    await user.keyboard("{ArrowDown}{Enter}");

    expect(createCategory).toHaveBeenCalledWith({
      circleId: "c1",
      name: "Rent",
      type: "expense",
      color: paletteColorForSeed("rent").id,
    });
    expect(within(form).getByRole("button", { name: /Remove Rent/ })).toBeInTheDocument();
    expect(combo).toHaveValue("");
  });

  it("lets you re-select an inline-created category after removing its chip", async () => {
    const user = userEvent.setup();
    const newId = testId<Category["id"]>("cat-snacks");
    renderForm(createExpense, { categories: [] });
    createCategory.mockResolvedValueOnce(newId);
    const form = screen.getByRole("form", { name: /add expense/i });
    await inlineCreateTransactionFormCategory(user, form, "Snacks");
    await user.click(within(form).getByRole("button", { name: /Remove Snacks/ }));

    await pickTransactionFormCategory(user, form, "Snacks");

    expect(within(form).getByRole("button", { name: /Remove Snacks/ })).toBeInTheDocument();
    expect(createCategory).toHaveBeenCalledTimes(1);
  });

  it("disables the category combobox while inline create is in flight", async () => {
    const user = userEvent.setup();
    let resolveCreate: (id: Category["id"]) => void = () => {};
    const createPromise = new Promise<Category["id"]>((resolve) => {
      resolveCreate = resolve;
    });
    renderForm(createExpense, { categories: [] });
    createCategory.mockReturnValueOnce(createPromise);
    const form = screen.getByRole("form", { name: /add expense/i });
    const combo = within(form).getByRole("combobox", { name: "Categories" });
    await user.click(combo);
    await user.type(combo, "Snacks");
    await user.click(screen.getByRole("option", { name: 'Create "Snacks"' }));

    expect(combo).toBeDisabled();

    resolveCreate(testId<Category["id"]>("cat-snacks"));
    await waitFor(() => expect(combo).not.toBeDisabled());
    await user.keyboard("{Escape}");
  });

  it("shows the category combobox when none exist for the type", () => {
    renderForm(createExpense, { categories: [] });
    expect(screen.getByRole("combobox", { name: "Categories" })).toBeInTheDocument();
    expect(screen.queryByText(/Create one first/)).not.toBeInTheDocument();
  });
});

describe("TransactionForm — edit (TXN-2)", () => {
  const editMode = (over: Partial<Transaction> = {}): FormModeInput => ({
    kind: "edit",
    transaction: makeTransactionView(over),
  });

  it("prefills from the saved Transaction", () => {
    renderForm(editMode({ title: "Weekly shop", amountMinorUnits: 1250, date: "2026-05-15" }));
    const form = screen.getByRole("form", { name: /edit transaction/i });
    expect(within(form).getByLabelText("Title")).toHaveValue("Weekly shop");
    expect(within(form).getByLabelText(/Amount/)).toHaveValue("12.50");
    expect(within(form).getByLabelText("Date")).toHaveValue("2026-05-15");
    expect(within(form).getByRole("button", { name: /Remove Groceries/ })).toBeInTheDocument();
  });

  it("saves edited fields through updateTransaction and closes", async () => {
    const user = userEvent.setup();
    const { onClose } = renderForm(editMode({ title: "Weekly shop", amountMinorUnits: 1250 }));
    const form = screen.getByRole("form", { name: /edit transaction/i });
    await user.clear(within(form).getByLabelText("Title"));
    await user.type(within(form).getByLabelText("Title"), "Big shop");
    await user.click(within(form).getByRole("button", { name: "Save changes" }));

    expect(updateTransaction).toHaveBeenCalledWith({
      transactionId: "t1",
      type: "expense",
      title: "Big shop",
      note: "",
      amountMinorUnits: 1250,
      date: "2026-05-15",
      categoryIds: ["cat-groceries"],
      paidByMemberId: "mem-you",
    });
    expect(onClose).toHaveBeenCalled();
  });

  it("confirms a type change, clears categories, and saves the new type + categories", async () => {
    const user = userEvent.setup();
    renderForm(editMode({ title: "Weekly shop" }), {
      categories: [
        makeCategoryView({ name: "Groceries", type: "expense" }),
        makeCategoryView({
          id: testId<Category["id"]>("cat-salary"),
          name: "Salary",
          type: "income",
        }),
      ],
    });
    const form = screen.getByRole("form", { name: /edit transaction/i });

    await user.click(within(form).getByRole("button", { name: "Income" }));
    const dialog = within(form).getByRole("alertdialog");
    expect(dialog).toHaveTextContent(/change to income/i);
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(within(form).queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(
      within(form).getByRole("button", { name: "Expense", pressed: true }),
    ).toBeInTheDocument();

    await user.click(within(form).getByRole("button", { name: "Income" }));
    await user.click(
      within(within(form).getByRole("alertdialog")).getByRole("button", { name: "Change type" }),
    );
    expect(
      within(form).queryByRole("button", { name: /Remove Groceries/ }),
    ).not.toBeInTheDocument();
    expect(within(form).getByRole("button", { name: "Income", pressed: true })).toBeInTheDocument();

    await pickTransactionFormCategory(user, form, "Salary");
    await user.click(within(form).getByRole("button", { name: "Save changes" }));

    expect(updateTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ transactionId: "t1", type: "income", categoryIds: ["cat-salary"] }),
    );
  });

  it("inline-creates a category with the new type after a type change", async () => {
    const user = userEvent.setup();
    const newId = testId<Category["id"]>("cat-bonus");
    renderForm(editMode({ title: "Weekly shop" }), {
      categories: [
        makeCategoryView({ name: "Groceries", type: "expense" }),
        makeCategoryView({
          id: testId<Category["id"]>("cat-salary"),
          name: "Salary",
          type: "income",
        }),
      ],
    });
    const form = screen.getByRole("form", { name: /edit transaction/i });

    await user.click(within(form).getByRole("button", { name: "Income" }));
    await user.click(
      within(within(form).getByRole("alertdialog")).getByRole("button", { name: "Change type" }),
    );
    createCategory.mockResolvedValueOnce(newId);
    await inlineCreateTransactionFormCategory(user, form, "Bonus");

    expect(createCategory).toHaveBeenCalledWith({
      circleId: "c1",
      name: "Bonus",
      type: "income",
      color: paletteColorForSeed("bonus").id,
    });
    expect(within(form).getByRole("button", { name: /Remove Bonus/ })).toBeInTheDocument();
  });

  it("blocks saving until the cleared categories are re-picked after a type change", async () => {
    const user = userEvent.setup();
    renderForm(editMode({ title: "Weekly shop" }), {
      categories: [
        makeCategoryView({ name: "Groceries", type: "expense" }),
        makeCategoryView({
          id: testId<Category["id"]>("cat-salary"),
          name: "Salary",
          type: "income",
        }),
      ],
    });
    const form = screen.getByRole("form", { name: /edit transaction/i });
    await user.click(within(form).getByRole("button", { name: "Income" }));
    await user.click(
      within(within(form).getByRole("alertdialog")).getByRole("button", { name: "Change type" }),
    );
    await user.click(within(form).getByRole("button", { name: "Save changes" }));

    expect(await within(form).findByText("Pick at least one category")).toBeInTheDocument();
    expect(updateTransaction).not.toHaveBeenCalled();
  });

  it("keeps an already-attached archived category on save without blocking", async () => {
    const user = userEvent.setup();
    renderForm(
      editMode({
        title: "Weekly shop",
        categories: [{ id: testId<Category["id"]>("cat-arch"), name: "OldCat", color: "green" }],
      }),
      {
        categories: [
          makeCategoryView({
            id: testId<Category["id"]>("cat-arch"),
            name: "OldCat",
            status: "archived",
          }),
        ],
      },
    );
    const form = screen.getByRole("form", { name: /edit transaction/i });
    expect(within(form).getByText(/OldCat · archived/)).toBeInTheDocument();
    expect(within(form).queryByRole("alert")).not.toBeInTheDocument();

    await user.clear(within(form).getByLabelText("Title"));
    await user.type(within(form).getByLabelText("Title"), "Edited");
    await user.click(within(form).getByRole("button", { name: "Save changes" }));

    expect(updateTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ categoryIds: ["cat-arch"], title: "Edited" }),
    );
  });

  it("blocks newly adding a category that was archived mid-edit", async () => {
    const user = userEvent.setup();
    const cats: Category[] = [
      makeCategoryView({ name: "Groceries", type: "expense" }),
      makeCategoryView({
        id: testId<Category["id"]>("cat-snacks"),
        name: "Snacks",
        type: "expense",
      }),
    ];
    const { rerenderForm } = renderForm(editMode({ title: "Weekly shop" }), { categories: cats });
    const form = screen.getByRole("form", { name: /edit transaction/i });
    await pickTransactionFormCategory(user, form, "Snacks");

    cats[1] = makeCategoryView({
      id: testId<Category["id"]>("cat-snacks"),
      name: "Snacks",
      type: "expense",
      status: "archived",
    });
    rerenderForm();

    expect(within(form).getByText(/Snacks · archived/)).toBeInTheDocument();
    expect(within(form).getByRole("alert")).toHaveTextContent(/"Snacks" was archived/);
    await user.click(within(form).getByRole("button", { name: "Save changes" }));
    expect(updateTransaction).not.toHaveBeenCalled();
  });

  it("shows a Removed Member's existing Paid By as a selectable option", () => {
    renderForm(
      editMode({
        title: "Weekly shop",
        paidBy: { id: testId<Member["id"]>("mem-rex"), displayName: "Rex", image: undefined },
      }),
      { members: [makeMemberView()] },
    );
    const form = screen.getByRole("form", { name: /edit transaction/i });
    expect(within(form).getByRole("option", { name: "Rex (removed)" })).toBeInTheDocument();
  });

  it("blocks saving when a newly selected Paid By member is removed mid-edit", async () => {
    const user = userEvent.setup();
    const members: Member[] = [
      makeMemberView(),
      makeMemberView({ id: testId<Member["id"]>("mem-y"), displayName: "Yuki", isSelf: false }),
    ];
    const { rerenderForm } = renderForm(editMode({ title: "Weekly shop" }), { members });
    const form = screen.getByRole("form", { name: /edit transaction/i });
    await user.selectOptions(within(form).getByLabelText("Paid by"), "mem-y");

    members.splice(1, 1);
    rerenderForm();
    await user.click(within(form).getByRole("button", { name: "Save changes" }));

    expect(await within(form).findByText(/no longer a member/i)).toBeInTheDocument();
    expect(updateTransaction).not.toHaveBeenCalled();
  });

  it("still saves a no-op when keeping a now-removed current Paid By", async () => {
    const user = userEvent.setup();
    renderForm(
      editMode({
        title: "Weekly shop",
        paidBy: { id: testId<Member["id"]>("mem-rex"), displayName: "Rex", image: undefined },
      }),
      { members: [makeMemberView()] },
    );
    const form = screen.getByRole("form", { name: /edit transaction/i });
    await user.clear(within(form).getByLabelText("Title"));
    await user.type(within(form).getByLabelText("Title"), "Edited");
    await user.click(within(form).getByRole("button", { name: "Save changes" }));

    expect(within(form).queryByText(/no longer a member/i)).not.toBeInTheDocument();
    expect(updateTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Edited", paidByMemberId: "mem-rex" }),
    );
  });

  it("surfaces a generic error and reports the failure when the edit fails", async () => {
    const user = userEvent.setup();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    renderForm(editMode({ title: "Weekly shop" }));
    updateTransaction.mockRejectedValueOnce(new Error("Network down"));

    const form = screen.getByRole("form", { name: /edit transaction/i });
    await user.clear(within(form).getByLabelText("Title"));
    await user.type(within(form).getByLabelText("Title"), "Edited");
    await user.click(within(form).getByRole("button", { name: "Save changes" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(/Couldn't save the transaction/i);
    expect(alert).not.toHaveTextContent(/Network down/);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
