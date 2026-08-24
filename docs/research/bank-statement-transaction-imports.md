# Bank statement transaction imports

Research date: 2026-08-20. Sources are first-party product documentation, official specifications, and public security or privacy guidance.

## Recommendation

Do not start with "upload a PDF and trust the result." Start with a private import workspace for the Personal Circle:

1. Accept one or more OFX/QFX or CSV files in one import session. Defer PDF.
2. Make the User identify each source as Chequing, Savings, or Credit Card before parsing rows into Transactions. Remember the mapping for later imports.
3. Parse locally where practical. Show every parsed row before any write. Let the User fix date and amount direction, choose Categories in bulk, and deselect rows.
4. Separate duplicate detection from transfer detection. A duplicate is one real-world movement seen twice from the same account. A transfer is one movement with two real account legs.
5. Auto-skip only deterministic duplicates. Mark heuristic matches as "possible duplicate" with the evidence and let the User include them.
6. Suggest internal transfers only when both accounts are represented. A Credit Card payment should be excluded from spending only when its opposite Credit Card account leg is present or already tracked. If only Checking is represented, keep the payment. It may be the only evidence that cash left the tracked system.
7. Keep matched transfers visible in the review as a linked pair. PocketCircle has no Transfer type today, so the MVP should leave both rows unselected rather than import one as an Expense and the other as Income.
8. Commit only selected, fully categorized rows. Record one Import Batch and provenance per created Transaction. Offer "Undo import," implemented by archiving that Batch's Transactions so the existing audit remains intact.

This is narrower than a bank connection, but it solves the User's immediate job without bank credentials, aggregator fees, webhook operations, or a PDF extraction vendor.

## PocketCircle constraints

- A Transaction belongs to one Circle, has only Expense or Income type, requires at least one Category, and attributes the money movement to a Member through Paid By. PocketCircle has no Financial Account or Transfer concept. See the [domain glossary](../../CONTEXT.md) and current [`transactions` schema](../../packages/convex/convex/schema.ts).
- A bank statement belongs to a financial account, not to a Circle. Importing a whole personal statement into a shared Circle could expose unrelated spending to every Member. The first release should therefore be Personal Circle only. A later shared-Circle flow can let a User privately stage rows and commit only selected shared Transactions.
- Paid By cannot stand in for source account. It answers whose money movement this is. It cannot distinguish the same User's Checking, Savings, and Credit Card accounts, which is required for stable deduplication and transfer matching.
- Categories are mandatory. A post-import "uncategorized inbox" would require changing the core Transaction invariant. The smaller change is to require a Category before a selected row can be committed, with bulk actions and learned suggestions to keep this tolerable.
- Imported Transactions should use the uploader as Recorded By and default Paid By. Normal edit, archive, history, search, and reporting rules should continue to apply.

## What established products do

| Product | File and review flow | Duplicate handling | Transfer handling |
| --- | --- | --- | --- |
| YNAB | Supports QFX, OFX, QIF, and CSV. Its import dialog confirms the destination account and can swap payee/memo, reverse inflow/outflow, and preview date timezone changes. Imported rows then enter an approval and categorization queue with bulk actions. [File-Based Import](https://support.ynab.com/en_us/file-based-import-a-guide-Bkj4Sszyo), [Approving and Matching](https://support.ynab.com/en_us/approving-and-matching-transactions-a-guide-ByYNZaQ1i) | It matches a manual Transaction when amount is exact and dates are within ten days. Repeated file or direct imports with the same date and amount are skipped. Deleted imported rows remain known and cannot normally be reimported. [File-Based Import](https://support.ynab.com/en_us/file-based-import-a-guide-Bkj4Sszyo) | The first imported transfer between two accounts arrives as a regular Transaction unless the User entered the transfer first or reclassifies it. If both accounts are in YNAB, it is a transfer. If only the sending account is present, it is spending. [Transfer Transactions](https://support.ynab.com/en_us/transfer-transactions-a-guide-HJOsZz4Jj) |
| Actual Budget | Imports CSV, QIF, OFX, QFX, and CAMT, with OFX/QFX recommended. CSV has field mapping, date format, delimiter, amount direction, and multiplier controls. [Importing Transactions](https://actualbudget.org/docs/transactions/importing/) | It first uses the imported ID, then looks near the same date for the same amount and a similar payee. It can merge a manual row into an imported row and can keep deleted imported rows from returning. [Importing Transactions](https://actualbudget.org/docs/transactions/importing/), [Merging Duplicate Transactions](https://actualbudget.org/docs/transactions/merging/) | It stores a linked pair. For file imports it recommends creating the transfer from the first account before importing the second, so the second leg reconciles. Existing opposite-signed rows can be linked when amounts match exactly. Dates remain independent because account posting dates may differ. [Transfers](https://actualbudget.org/docs/transactions/transfers/) |
| Lunch Money | Imports CSV and PDF through a five-step flow: upload, map columns, verify notation/settings, review every resulting Transaction, then commit. Users can deselect individual rows. It recommends starting with one month so rules improve before a larger import. [CSV / PDF Importing](https://support.lunchmoney.app/guides/import-via-csv) | "Skip Duplicates" is on by default and uses exact date, payee, and amount equality. Duplicates remain visible at the bottom of the review for debugging. [CSV / PDF Importing](https://support.lunchmoney.app/guides/import-via-csv) | A Credit Card payment is represented as opposite debit and credit rows, categorized as Payment, Transfer, grouped together, and excluded from totals and budgets. [Transaction FAQ](https://support.lunchmoney.app/finances/transactions/transactions) |
| Monarch Money | Imports a rigid CSV into one account or uses a separate multi-account migration flow. It warns that imports cannot be undone and recommends a small test file. [Manual import](https://help.monarchmoney.com/hc/en-us/articles/4409682789908-Import-data-manually-from-banks-or-other-finance-apps) | Manual Transactions are not reconciled with matching synced Transactions. [Manual Transactions](https://help.monarchmoney.com/hc/en-us/articles/360058441811-Manual-transactions) | Transfer and Credit Card Payment Categories are excluded from budgets and Cash Flow. [Budgets](https://help.monarchmoney.com/hc/en-us/articles/360048883631-Budgets) |
| Quicken Classic and Simplifi | Classic imports QFX and tells the User to review the register and delete any duplicates. Simplifi distinguishes manual from downloaded rows and can merge one of each on web. [Quicken file import](https://info.quicken.com/win/importing-files-from-your-bank), [Simplifi duplicate resolution](https://support.simplifi.quicken.com/en/articles/4901071-how-to-resolve-duplicate-transactions) | Simplifi notes that editing a pending row can prevent it from matching the cleared row. This is a useful warning against treating Transaction fields as immutable identity. [Simplifi duplicate resolution](https://support.simplifi.quicken.com/en/articles/4901071-how-to-resolve-duplicate-transactions) | Classic can scan downloaded rows for opposite deposit/withdrawal pairs and either create transfers automatically or ask for confirmation. It models a Credit Card payment as a Checking-to-card transfer when both accounts are tracked. [Transfer detection preferences](https://info.quicken.com/win/transfer-detection-preferences), [Credit Card payment](https://info.quicken.com/win/how-do-i-make-a-credit-card-account-payment) |

The useful consensus is not full automation. It is account-scoped import, visible review, conservative matching, bulk correction, and a durable way to remember earlier imports.

## File format order

### 1. OFX and QFX

Prefer OFX/QFX when the bank offers it. The current OFX Banking 2.3 specification defines `FITID` for a financial institution to identify a Transaction uniquely within an account. Its primary purpose is duplicate-response detection. A client needs the Financial Institution, Account ID, and `FITID` together for a global key. OFX also defines corrections through `CORRECTFITID` and `CORRECTACTION`, and can use the same server Transaction ID on both sides of a transfer. [FDX OFX Work Group](https://financialdataexchange.org/about-fdx/ofx-work-group/), [OFX Banking 2.3 specification](https://www.financialdataexchange.org/common/Uploaded%20files/OFX%20files/OFX%20Banking%20Specification%20v2.3.pdf)

QFX is Quicken File eXchange. Quicken says it contains Transactions, balances, and other account data. [Quicken file import](https://info.quicken.com/win/importing-files-from-your-bank)

Store the raw external ID as provenance, scope it to the source account, and keep a fallback review path for files without one.

### 2. CSV

CSV gives broad coverage, but there is no bank Transaction CSV standard. Banks vary on delimiters, date formats, positive/negative direction, separate debit/credit columns, headers, and descriptions. Lunch Money exposes all of those mapping decisions and explicitly notes that every bank exports differently. [CSV / PDF Importing](https://support.lunchmoney.app/guides/import-via-csv)

CSV therefore needs a mapping UI, live parsed samples, and a saved configuration per source account. Never infer sign and date format silently when the file is ambiguous.

### 3. PDF

Defer PDF until file import has proven demand. PDF does not supply the finance-specific Transaction ID that OFX does. Lunch Money warns that PDF layouts vary significantly and routes PDFs to Bank Statement Converter, where the vendor says uploaded documents persist for 24 hours. Its CSV path instead runs client-side and sends only reviewed rows. [CSV / PDF Importing](https://support.lunchmoney.app/guides/import-via-csv)

A PDF parser can be a later fallback with a bank-template coverage list, per-row confidence, visual reconciliation against opening and closing balances, and a clear third-party retention disclosure. It should never bypass the same review screen used by structured files.

## Duplicate detection

Use confidence tiers and one-to-one matching. Never use title alone, and never use amount alone.

### Deterministic duplicate, skip by default

- Same source account plus the same OFX `FITID` or future provider Transaction ID.
- Same source account plus the same previously committed file checksum and source row position.
- Same Import Batch retry idempotency key. A partially retried commit must not create another set.

Show these under "Already imported" with the matching PocketCircle Transaction and an Include override. Match active and Archived Transactions so an archived import does not silently return.

### Probable duplicate, require review

- Same source account and Currency.
- Exact amount and direction.
- Same parsed date, or a small posting-date window.
- Same normalized original description or a strong payee similarity.

Use multiset matching. Two identical coffee purchases on one day are two rows, not one row seen twice. Match each incoming row to at most one existing row and preserve excess occurrences.

YNAB's exact date-and-amount skip is convenient, Lunch Money adds exact payee, and Actual adds a nearby-date plus similar-payee fallback. None makes a heuristic universally safe. PocketCircle should expose the evidence and reserve automatic suppression for stable IDs and exact Import Batch retries.

Persist a compact import decision so skipped rows do not appear on every overlapping statement. Keep the external ID when present. For CSV, keep a keyed fingerprint of the canonical account, date, amount, normalized description, and occurrence number. Do not retain the raw file just to support deduplication.

## Transfer and Credit Card payment matching

A transfer candidate must meet all of these base conditions:

- Different source accounts owned by the same User.
- Same Currency.
- Exact absolute amount with opposite direction.
- Posting dates within a small window. Actual's historical helper uses three days and refuses ambiguous repeated matches. [Identify and Apply Transfers Historically](https://actualbudget.org/docs/advanced/scripts/modify-transfers)
- One-to-one candidate. If several opposite rows have the same amount in the window, ask instead of guessing.

Description clues such as a card issuer, "payment," "transfer," an account nickname, or last four digits can raise confidence. They cannot establish a transfer alone.

The coverage rule matters more than the matcher:

- Checking debit plus Credit Card credit, with both accounts represented: suggest one linked Credit Card payment and exclude both legs from spending.
- Checking debit only, Credit Card not represented: do not suppress it. Keep it as an Expense candidate because it is the only cash-out evidence available. Tell the User that importing the card statement later would provide itemized purchases and let them replace the coarse payment.
- Credit Card credit only, Checking not represented: do not treat it as Income. Mark it as a possible payment that needs review.
- Checking-to-Savings with both accounts represented: suggest an internal transfer and exclude both legs from Income and Expense totals.
- Same-side rows across two accounts are not a transfer. Opposite rows within one account are not a transfer.

For the MVP, transfer candidates should remain visible as paired rows and default to not imported. Once PocketCircle has a real Transfer model, import and link both legs. Do not discard one leg or pretend the pair is a duplicate.

## Review experience

Use one workspace rather than a modal that immediately writes Transactions.

1. **Files.** Upload one or more files. Show file name, detected format, row count, date range, and errors. Reject encrypted or malformed files with a specific reason.
2. **Accounts.** Map each file to a remembered source account. Show account type, Currency, and optional last four digits. Do not store a full account number.
3. **Mapping.** For CSV, map Date, Description, Amount or Debit/Credit, and optional Note. Preview several real rows. Provide date format and flip-direction controls.
4. **Review.** Show all parsed rows in one table grouped by source account. Each row has Include, Date, Description, signed Amount, suggested Type, required Categories, and status such as New, Already imported, Possible duplicate, or Possible transfer.
5. **Resolve.** Put attention-needed rows first. Support bulk Include, Exclude, Category, and Paid By. Let the User expand a match to see both rows or the existing Transaction.
6. **Confirm.** Summarize counts and totals per account: selected, duplicate, transfer, excluded, and invalid. Do not collapse different Currencies into one total.
7. **Commit.** Create one Import Batch. Report created and skipped counts. Link to the resulting Ledger filter and provide a batch archive action.

Start with one month per file even if the parser accepts more. Lunch Money recommends this because category rules improve with a reviewed first batch and a year of uncategorized data overwhelms people. [CSV / PDF Importing](https://support.lunchmoney.app/guides/import-via-csv)

The table should have four saved views plus All:

- **Ready.** New, valid, categorized rows. Selected by default.
- **Needs attention.** Ambiguous sign or date, missing Category, parsing error, or possible duplicate. Unselected until resolved.
- **Transfers.** Matched or possible internal transfers. Unselected by default, with both account legs shown together.
- **Already imported.** Deterministic duplicates. Unselected by default, with a link to the existing Transaction.

The default action is "Import ready rows," not "Select all." This lets the User inspect every row without making routine imports a row-by-row chore.

## Data model needed before automation

The names can change, but the concepts should not be compressed into Transaction title or Note:

- **Financial Account.** User-owned stable ID, nickname, account type, Currency, optional institution label and last four. No Circle ownership, credentials, or full account number. The MVP targets the User's Personal Circle, while a later private staging flow can commit selected rows to regular Circles without exposing account metadata.
- **Import Batch.** User, source files' keyed checksums, parser version, started/completed status, and counts. It gives retries and batch archive a stable boundary.
- **Import provenance.** Transaction ID, Financial Account ID, Batch ID, external Transaction ID when present, source-row fingerprint, original description, and match disposition.
- **Import decision.** A compact record for a skipped duplicate or confirmed transfer candidate. It prevents a later overlapping file from repeatedly asking the same question without storing the statement.
- **Transfer link.** Deferred until the domain supports Transfer. It must link two account legs and keep their posting dates independent.

Do not expose private Financial Account metadata to other Circle Members. If shared-Circle import arrives later, the private staging source remains User-owned and only the committed Transaction fields become Circle data.

## Privacy and security

Bank statements can contain names, addresses, account identifiers, balances, counterparties, and a complete spending history. Treat them as more sensitive than the selected Transactions.

- Parse CSV and structured financial files in the browser where practical. Send only selected, validated rows to Convex. Do not upload or retain the original file. Lunch Money uses this pattern for CSV. [CSV / PDF Importing](https://support.lunchmoney.app/guides/import-via-csv)
- Keep file names, raw descriptions, account digits, amounts, and parsed rows out of PostHog, Sentry breadcrumbs, logs, support payloads, and error messages.
- Allow only authenticated Users. Allowlist required extensions, validate actual content rather than trusting MIME, generate any server-side names, impose file, row, field-length, and parser-time limits, and keep parser libraries patched. OWASP recommends layered controls because extension, MIME, or signature checks alone are bypassable. [OWASP File Upload Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html)
- Parse untrusted files in an isolated worker. Never render descriptions as HTML. For XML-based formats, disable external entity and network resolution.
- If PDF processing becomes server-side, isolate it from the application host, scan it, impose resource limits, encrypt temporary storage, delete originals on a short documented schedule, and do not send statements to public malware or AI services. OWASP recommends antivirus or sandboxing, Content Disarm and Reconstruction for PDF when applicable, and storage outside the web root or on a separate host. [OWASP File Upload Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html)
- State what is collected, why, which processor receives it, and when it is deleted before upload. The Office of the Privacy Commissioner of Canada starts reasonable safeguards with collecting only information needed for the stated purpose. [OPC self-assessment tool](https://services.priv.gc.ca/securite-security/en?wbdisable=true)

## Why not connect banks first

Direct feeds are a later acquisition and retention feature, not a simpler importer.

Plaid's current Transactions Sync API provides cursor-based added, modified, and removed changes. Pending Transactions can be removed and replaced by posted Transactions with a new ID, and the link is not guaranteed. A correct integration needs durable cursors, pagination restart logic, webhooks, pending-to-posted replacement, deletion handling, consent revocation, and account reconnect flows. [Plaid Transactions API](https://plaid.com/docs/api/products/transactions/), [Transaction states](https://plaid.com/docs/transactions/transactions-data/)

Plaid's US and Canada consent flow discloses requested data types and use cases. Its OAuth guide says Canadian financial institutions do not currently use OAuth, while US OAuth coverage includes many large banks. Revoked access requires deleting associated data unless retention remains necessary for the requested service. [Plaid Data Transparency Messaging](https://plaid.com/docs/link/data-transparency-messaging-migration-guide/), [Plaid OAuth guide](https://plaid.com/docs/link/oauth/)

Stripe Financial Connections exposes account-scoped transaction IDs, status, asynchronous refreshes, and up to 180 days of history, but its listed institution coverage is US-focused. It is not a Canadian replacement for file import. Stripe also tells developers to request only the permissions needed for the use case. [Stripe Transactions](https://docs.stripe.com/financial-connections/transactions), [Stripe supported institutions](https://docs.stripe.com/financial-connections/supported-institutions), [Stripe data-powered products](https://docs.stripe.com/financial-connections/other-data-powered-products)

A later provider integration should feed the same staging, matching, review, provenance, and account model as files. Do not build a second Transaction ingestion path.

## Staged roadmap

### Stage 1: useful and safe

- Personal Circle only.
- OFX/QFX and CSV, one month recommended, multiple files allowed in one session.
- Browser parsing, account mapping, CSV column/sign/date controls.
- Full pre-commit review, row selection, required Category, bulk Category and Paid By.
- Deterministic dedupe plus visible probable matches.
- Conservative paired transfer suggestions. No suppression when the destination account is not represented.
- Idempotent batch commit and batch archive.
- No PDF, AI enrichment, bank connection, or automatic rule creation.

### Stage 2: reduce repeat work

- Saved per-account CSV mappings.
- Payee normalization and Category suggestions learned from the User's confirmed history.
- Persisted skipped-row decisions and better one-to-one duplicate matching.
- A real Transfer type with linked account legs, excluded from Income and Expense reports.
- Balance reconciliation using statement opening/closing balances when the format supplies them.

### Stage 3: expand coverage

- PDF through a disclosed, short-retention isolated processor, with bank-template coverage and extraction confidence.
- Private staging for imports into regular Circles. Only selected rows cross into shared Circle data.
- Direct bank connections through one provider after Canada coverage, cost, consent, deletion, and support burden are acceptable.
- Plaid Enrich or another paid enrichment service only if local payee history proves insufficient. Plaid Enrich accepts non-Plaid Transaction data in US and Canada, but that sends descriptions and amounts to another processor and is billed per Transaction. [Plaid Enrich](https://plaid.com/docs/enrich/)

## Product decisions to settle

- Is the first job historical migration, monthly upkeep, or both? Monthly upkeep needs saved mappings and remembered decisions sooner.
- Should a confirmed transfer remain visible in PocketCircle, or is excluding both legs acceptable until a Transfer model exists?
- Does batch undo archive imported Transactions or add a distinct rejected state? Archive matches the current recoverable lifecycle but changes what "Archived Transaction" means.
- Can the User import a coarse Credit Card payment now and later replace it with itemized card purchases without losing history? This needs an explicit review action, not silent deduplication.
- Which source formats do the first target Canadian banks actually export? Test real samples before fixing the parser scope.

The key product choice is simple: make import a reviewable proposal, not an automatic write. Structured IDs make some duplicates certain. Everything else, especially transfers, depends on account coverage and should remain reversible.
