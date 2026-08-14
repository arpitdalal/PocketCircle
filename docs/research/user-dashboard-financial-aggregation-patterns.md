# User Dashboard financial aggregation patterns

Research date: 2026-08-14. Sources are first-party product documentation.

## PocketCircle baseline

- A **Transaction** belongs to exactly one **Circle**. **Paid By** assigns the entire money movement to one **Member**; it does not represent consumption or a partial share. **Settlement**, splits, and Member balances are out of scope. A **Refund** is an unlinked Income Transaction. Each Circle has one Currency, but different Circles may use different Currencies. See the [domain glossary](../../CONTEXT.md).
- Current Dashboard reporting is per-Circle, active-Transaction-only, and Circle-wide. The prior Paid By Dashboard filter was removed because its multi-month scope did not align with month-local Ledger filters. See [RPT-3](../issues/RPT-3-dashboard-totals.md) and [RPT-4](../issues/RPT-4-dashboard-charts.md).
- At research time, `/` lists Circles and the deployed Activation Checklist is shown only on the Personal Circle Dashboard; its first two stored milestones specifically record a Personal-Circle Transaction and Category. The target decision now lives in [ADR 0030](../adr/0030-skippable-monotonic-user-activation-checklist.md); current implementation evidence remains in [`home.tsx`](../../apps/web-app/app/routes/home.tsx) and [`activation.ts`](../../packages/convex/convex/activation.ts) until issue #273 ships.

## Established patterns

### Monarch Money

- Monarch models a shared household as one visible financial dataset and one Budget, but assigns every account and Transaction an owner: Shared or one household member. Transactions inherit account ownership by default, can be overridden, and can be filtered by owner in Accounts, Transactions, Reports, and Cash Flow. A split rule can assign different owners to different portions. Ownership filters are currently temporary rather than persisted. [Shared Views](https://help.monarch.com/hc/en-us/articles/42228648365076-Shared-Views-in-Monarch)
- Inclusion is layered. An account can independently be hidden from the account list, excluded from Net Worth, or have its transactions excluded from Cash Flow and budgets. An individual transaction can also be hidden from Cash Flow and budgets while remaining in history. [Hiding an account](https://help.monarchmoney.com/hc/en-us/articles/4407859794580-Hiding-an-account), [Hiding transactions](https://help.monarchmoney.com/hc/en-us/articles/4405041904916-Hide-Transactions)
- Transfers and Credit Card Payments are excluded from budgets, Cash Flow, and spending totals. Monarch does not convert currencies and warns that mixing them produces misleading totals. [Transfers](https://help.monarch.com/hc/en-us/articles/360048393292-Transfers-and-Credit-Card-Payments), [International Currency](https://help.monarch.com/hc/en-us/articles/360048393552-International-Accounts-and-Currency)

### YNAB

- A plan is the financial/reporting boundary. For hybrid finances, YNAB documents separate personal plans plus a shared plan as its cleanest setup; the plan dashboard switches among plans rather than aggregating them. Reports within one plan can include selected accounts. [Budgeting as a couple](https://www.ynab.com/guide/budgeting-as-a-couple), [Multiple plans](https://support.ynab.com/en_us/navigating-multiple-plans-r1qeOvbC5), [Reports and account filters](https://www.ynab.com/blog/ynab-reports-and-data)
- Tracking accounts preserve balances for Net Worth without affecting the spending plan. [Account types](https://support.ynab.com/account-types-an-overview-BkmGM0qCq), [Net Worth filters](https://support.ynab.com/en_us/net-worth-BkwQO5WA5)
- YNAB recommends funding reimbursable spending up front. A later reimbursement is recorded against a reimbursement category; partial or combined reimbursements use split transactions. This preserves the fact that cash left before it returned instead of pretending the advance never occurred. [Reimbursements](https://support.ynab.com/en_us/reimbursements-in-ynab-H1W7ilhC5), [Reimbursement FAQ](https://support.ynab.com/en_us/reimbursements-faq-Sy9qDvtvgg)
- A transfer is a linked movement when both real-world accounts are in YNAB; if only the sending account is present, YNAB treats it as spending. [Transfers](https://support.ynab.com/transfer-transactions-a-guide-HJOsZz4Jj)
- One plan cannot contain multiple currencies. YNAB suggests separate plans per currency or manual conversion to one plan currency. [Pricing FAQ](https://www.ynab.com/pricing/), [Multiple-currency guide](https://www.ynab.com/blog/the-digital-nomads-guide-to-budgeting-in-different-currencies)

### Copilot Money

- Copilot's home Dashboard aggregates monthly spending and Income. Transactions have explicit Income, Internal Transfer, and Regular types; Internal Transfers are excluded from spending budgets, while refunds remain Regular spending-side credits. [Dashboard](https://help.copilot.money/en/articles/6045480-dashboard-tab-overview), [Transaction types](https://help.copilot.money/en/articles/3971267-transaction-types)
- Individual transactions or whole excluded Categories can be omitted from spending totals. Cash Flow can optionally add excluded spending back, and Dashboard then follows that choice. Accounts can separately be excluded from the Net Worth chart. [Excluded transactions](https://help.copilot.money/en/articles/9718801-excluding-transactions), [Accounts](https://help.copilot.money/en/articles/6213732-accounts-tab-overview)
- A refund/reimbursement is moved into the original purchase Category and may be backdated to the purchase month. If embedded in a larger payment, it is split out first. Copilot also suggests tagging trip spending and transactions awaiting repayment. [Refunds and reimbursements](https://help.copilot.money/en/articles/5325170-refund-and-reimbursement-transactions), [Splitting transactions](https://help.copilot.money/en/articles/5325255-splitting-transactions), [Tag uses](https://help.copilot.money/en/articles/9554370-creative-ways-to-use-tags)
- Copilot supports USD only and does not convert foreign-currency transactions; users must manually edit the USD amount. [International Currency](https://help.copilot.money/en/articles/10715424-international-currency)

### Splitwise

- Splitwise separates who paid from how much each participant owes. A shared expense defaults to equal shares but supports exact amounts, percentages, shares, adjustments, reimbursements, and itemization. Its API exposes `paid_share` and `owed_share` separately for each User; the resulting balance is based on their difference, not the gross amount paid. [API](https://dev.splitwise.com/), [Split methods](https://kb.splitwise.com/balances-and-expenses/what-are-different-ways-i-can-split-an-expense)
- “Settle up” records repayment and updates balances; settling with one friend can clear net balances across multiple shared groups. Simplify Debts may change who pays whom but never changes a person's total balance. [Fully settled up](https://kb.splitwise.com/balances-and-expenses/what-does-it-mean-if-im-fully-settled-up-with-my-friend), [Simplify Debts](https://kb.splitwise.com/balances-and-expenses/what-is-simplify-debts)
- Splitwise keeps different-currency balances separate by default. Its optional conversion rewrites all group expenses into the User's default Currency at the current market rate, including already-settled expenses; it is not a historical reporting conversion. [Multiple currencies](https://kb.splitwise.com/balances-and-expenses/how-can-i-manage-a-friendship-or-group-with-multiple-currencies), [Exchange rates](https://kb.splitwise.com/pro/how-are-exchange-rates-calculated-for-currency-conversion)

### Lunch Money

- Categories can be excluded from budgets, totals, or both. Lunch Money specifically suggests splitting off a friend's reimbursable portion into an excluded “Reimbursed” Category, so the portion does not count as the User's Expense even before repayment arrives. Transfers use a Category excluded from budgets and totals. [Transaction FAQ](https://support.lunchmoney.app/finances/transactions/transactions), [Category properties](https://support.lunchmoney.app/setup/categories/category-properties)
- Lunch Money converts every Transaction to a User-selected primary Currency for all totals and summaries, using the historical exchange rate for that Transaction's date. [Multicurrency](https://support.lunchmoney.app/settings/multicurrency)

### Quicken Simplifi

- Simplifi explicitly frames shared-Expense reporting as the User's true portion. A reimbursement is categorized back to the original purchase Category so it reduces out-of-pocket cost instead of appearing as Income; when paying someone else back, only the User's reimbursed share is recorded. [Shared Expenses](https://support.simplifi.quicken.com/en/articles/8229807-tracking-shared-expenses)
- Accounts can be independently excluded from Reports or the Spending Plan. Net Worth uses a separate account filter. Simplifi supports only one Currency at a time and warns that mixing USD and CAD causes balance discrepancies. [Account exclusions](https://support.simplifi.quicken.com/en/articles/5160316-how-to-exclude-accounts-from-reports-and-the-spending-plan), [Currencies](https://support.simplifi.quicken.com/en/articles/3828353-what-currencies-does-quicken-simplifi-support)

## Implications for PocketCircle's model

The products expose three distinct concepts that a User-level surface could otherwise conflate:

1. **Attributed cash flow** — full Income and Expense where Paid By is the User. PocketCircle can derive this now. A trip advance appears as a large Expense until a later reimbursement Income arrives; recording that Income in another Circle makes the cash-flow total recover, but does not link it to the original Expense, repair the original month, or identify the User's actual trip cost.
2. **The User's share** — the portion economically consumed by the User. Splitwise derives this from explicit per-participant shares; PocketCircle has no equivalent data. Circle inclusion controls can omit a trip, but cannot distinguish the User's portion from friends' portions within it.
3. **Receivable/payable position** — what other Members owe the User, or the User owes them, before Settlement. PocketCircle deliberately has no Member balances or Settlement model, so it cannot calculate this from Paid By alone.

Other design constraints exposed by the comparison:

- **Scope control has levels.** Established products distinguish persistent account/report inclusion from temporary filters and per-Transaction exclusions. A Circle selector answers which data participates; it does not solve inaccurate attribution inside an included Circle.
- **Default scope communicates semantics.** “All active Circles” is broad attributed cash flow. Personal Circle only preserves current solo reporting. A persisted selected set behaves more like Monarch account inclusion; a temporary selector behaves more like YNAB report filters. Archived Circles need an explicit rule because their active Transactions remain historical facts even though current per-Circle reporting stays readable.
- **Currency policy is prerequisite.** Adding minor units from differently denominated Circles is invalid. Proven choices are separate totals per Currency (Splitwise), no cross-Currency scope (YNAB/Copilot), or conversion into a primary Currency with an explicit rate/date policy (Lunch Money). PocketCircle currently has neither a User reporting Currency nor exchange-rate data.
- **Transfers and reimbursements need semantics, not only categories.** PocketCircle has only Income and Expense. Using Income to offset a trip advance describes cash returning, but a generic dashboard cannot tell reimbursement from earnings or link it across Circles. Treating a whole Circle as excluded resembles account exclusion; treating only friends' portions as excluded requires amount splits or another allocation model.
- **Cross-Circle Category analytics are not directly additive.** Categories are Circle-scoped, names may collide semantically, and one Transaction may have multiple Categories. A User dashboard can aggregate Transaction totals before it can safely claim global Category totals.
- **Checklist relocation broadens evidence.** If “first Transaction” and “first Category” mean any Circle, the domain glossary and ADR 0030 change. Existing Personal-Circle milestones remain valid evidence under the broader rule, but existing regular-Circle activity would need a one-time evidence policy. The current fields, writers, CTAs, and backfill are explicitly Personal-Circle-specific.

## Questions this research leaves for product design

- Is `/` describing cash flow, economic consumption, outstanding shared balances, or explicitly only the first?
- Are Circle selections persistent reporting preferences, temporary filters, or both? What is the default for new, joined, archived, and restored Circles?
- Should an advance remain visible as cash outflow until repayment, be reduced immediately to “my share,” or support both views?
- Must the first release support differently denominated Circles? If yes, should it keep totals separate or introduce a User reporting Currency and exchange-rate history?
- Does a repayment belong in the original Circle for traceability, or may cross-Circle Income offset it without a link?
