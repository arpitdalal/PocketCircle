# PocketCircle

PocketCircle is a shared personal finance domain for tracking money activity inside collaborative financial spaces.

## Language

**Circle**:
A shared financial space with one or more **Members**. A Circle can represent personal tracking, a residence, trip, family, roommates, project, or any shared budget; Circle names do not need to be unique.
_Avoid_: Household, Group, Space, House

**Circle Visibility**:
The rule that a **User** can see only Circles where they are a current **Member**, plus Archived Circles where they remain a Member. Users cannot discover other Circles by name or email.
_Avoid_: Public Circle

**Circle Color**:
The required visual color assigned to a **Circle**. PocketCircle chooses an initial Circle Color when a Circle is created; the **Owner** can change it, and UI must not identify a Circle by color alone.
_Avoid_: Group Color

**Circle Mark**:
The generated visual mark for a **Circle**, based on its initials and **Circle Color**. V1 does not support uploaded Circle images.
_Avoid_: Circle Avatar Upload

**Circle Capacity**:
The maximum occupied seats in a **Circle**, counting current **Members** plus unexpired pending **Invitations**. A Circle can have at most 256 occupied seats; accepted Invitations become Member seats, while revoked or expired Invitations release their reserved seat.
_Avoid_: Member Limit, Invite Limit

**Personal Circle**:
The always-solo **Circle** automatically created for a Google-authenticated **User**. It has exactly one **Member**, can be renamed manually, and cannot invite Members, be archived, deleted, left by its owning User, or transferred to another Owner. Its default name is derived from the User's **Display Name** (`{firstName}'s Circle`, or **Personal Circle** when no usable first token exists) and auto-tracks that Display Name until the owner manually renames it or turns off **Match my display name** in Circle Settings; the owner can turn auto-sync back on there, which immediately re-derives the name and Mark from the current Display Name. After auto-sync is off, identity-driven Display Name edits no longer change the Circle name. Its **Mark** always derives from the Circle's current name via `initials()` — including after manual renames and identity-driven reconciles — and is never user-chosen. Identity-driven name updates (Onboarding, App Settings, or re-enabling auto-sync) do not record **Circle History**; manual renames do.
_Avoid_: Personal Household, Private Circle, Default Group

**Archived Circle**:
A **Circle** hidden from active use after the **Owner** no longer needs it. Current Members can view and search historical Transactions from archives, but cannot add, edit, or delete Transactions, Categories, or membership unless the Owner restores the Circle; ownership transfer and a non-Owner leaving are narrow lifecycle exceptions to this read-only rule. Anyone viewing a Circle when it is archived is moved to its read-only archived view; archiving revokes pending Invitations and invalidates their Invitation Links. V1 only supports deleting a regular Circle, active or archived, with no Transactions ever created and no current Member other than its Owner; Circle Settings, Categories, and Circle History alone do not block deletion, while Removed Members and pending Invitations do not block it either; deletion revokes pending Invitations and invalidates their Invitation Links; a Personal Circle cannot be archived or deleted outside **Account Deletion**.
_Avoid_: Deleted Circle

**Circle Setup**:
The mandatory Finish-only step for every newly created regular **Circle**. The Owner must Finish — Skip does not exist — which records completion and seeds starter **Categories** (defaults when answers are empty; purpose/residence answers add extras). Setup questions remain optional *data* where the Circle does not match the question's context, but the setup *step* is not skippable. A **Personal Circle** has no setup workflow and is born complete.
_Avoid_: Household Setup, Wizard

**Circle Settings**:
The Owner-controlled configuration for a **Circle**, including Circle name, Currency while it is still editable, and Circle Setup answers. Changing Circle Setup answers after creation does not remove existing Categories.
_Avoid_: Group Settings

**Circle History**:
The immutable change history for a **Circle**, including ownership transfers, Members added, removed, or deleted, Circle archived or restored, Invitation actions, and Circle Settings changed. Current Members can view Circle History as a Circle-level audit distinct from the **Member List**; it shows old and new values for Circle name, Circle Color, Currency, and Circle Setup answers, transfer from/to Members for ownership changes, and actor plus affected Member for membership changes; only the current Owner can see invitee email in Invitation history events, because unaccepted invitee emails remain Owner-only **Invitation** data, and internal IDs are not shown.
_Avoid_: Group Audit

**Currency**:
The single ISO 4217 money unit chosen for a **Circle** from PocketCircle's supported currency list. Every Transaction in a Circle uses that Circle's Currency; v1 does not support mixed currencies inside one Circle, Currency defaults from the creating User's locale with USD fallback, Currency is validated server-side, and Currency is locked once the Circle has any Transactions.
_Avoid_: Transaction Currency

**Residence Type**:
An optional **Circle Setup** answer used when a **Circle** represents a residence. A leased residence suggests a Rent Category; an owned residence suggests a Mortgage Category.
_Avoid_: Home Type

**User**:
A person with a Google-authenticated login identity in PocketCircle, identified by Google's provider subject rather than email address. A User can become a **Member** of zero or more **Circles**.
_Avoid_: Account

**Account Deletion**:
A workflow for permanently removing a **User** from PocketCircle while preserving Circle-scoped financial attribution through **Deleted Members**. The User confirms with `DELETE MY ACCOUNT` and an email link while authenticated as the same User. Account Deletion immediately and irreversibly removes login access, User-owned profile data, User-owned Notifications, and shared-Circle access; revokes pending Invitations created by or addressed to that User; and starts durable bounded deletion of the Personal Circle, solo setup-incomplete regular Circles, and archived regular Circles with no active co-Members. It does not rewrite existing History or other Users' Notifications and never blocks on Circles where the User is a non-Owner Member. A setup-complete active solo Circle must be archived first; any regular Circle with active co-Members must be transferred first, including while archived.
_Avoid_: User Erasure

**Google Account Email**:
The verified email address returned by Google sign-in for a **User**. Unlike **Display Name** and **Profile Picture** (seeded once at account creation), Google Account Email stays synced with Google and is not user-editable. Invitation acceptance matches the User's current (live) Google Account Email against the Invitation email; changing Google Account Email does not change existing Circle memberships.
_Avoid_: Verified Email

**Display Name**:
The editable name shown for a **User** in Circles, Transactions, Audit Metadata, and Member Lists. Display Name is seeded from Google sign-in when the account is created, then owned by the User and editable in-app; later Google profile changes do not overwrite it. Editing it refreshes the materialized identity on the User's active memberships.
_Avoid_: Full Name

**Profile Picture**:
The image shown for a **User** in Circles, Transactions, Audit Metadata, and Member Lists. Profile Picture is seeded from Google sign-in when the account is created and is not synced afterward; it is not editable in v1 (uploads are a later feature). If Google does not provide one, PocketCircle uses a generated initials avatar.
_Avoid_: Avatar Upload

**Onboarding**:
The one-time, gated step shown after a **User's** first sign-in where they confirm and optionally edit their **Display Name** — with their **Google Account Email** shown read-only for confirmation — before using the app. Completion is tracked by a per-User flag, and PocketCircle funnels the User back to it on return until it is done. Distinct from **Circle Setup**, which is per-**Circle**: Onboarding completes the User's profile, Circle Setup configures a Circle. Confirming or later editing the Display Name (Onboarding or App Settings) renames the User's **Personal Circle** to match only while the owner has not manually renamed it; afterward identity changes no longer touch the Circle name. Those identity-driven updates do not record **Circle History** because they are not deliberate Circle renames. Future versions may add optional questions, such as referral source, that never block completion.
_Avoid_: Circle Setup, Wizard, Profile Setup

**Member**:
A **User** participating in a specific **Circle**. Membership is the relationship that determines what the User can see or do inside that Circle.
_Avoid_: Account, Participant

**Owner**:
The single **Member** responsible for managing a **Circle's** membership and moderating its financial activity. An Owner can invite Members, remove Members, transfer ownership to another Member, archive the Circle, and archive or restore any Circle Transaction, but cannot edit another Member's Transaction fields.
_Avoid_: Admin, Manager

**Invitation**:
A reserved **Circle Capacity** seat sent to an email address for a person to become a **Member** of a **Circle**. An Invitation can be accepted only by a Google-authenticated **User** whose **Google Account Email** matches the Invitation email, and can be revoked by the **Owner** while pending; only the Owner can see pending Invitations. Invitation screens show Circle name, Owner Display Name, Owner Profile Picture, and invited email.
_Avoid_: Access Request

**Invitation Link**:
The single-use, seven-day expiring link sent for an **Invitation**. Resending an Invitation creates a new Invitation Link, refreshes the Invitation's expiry, keeps its **Circle Capacity** seat reserved, and invalidates older links; only the latest unexpired link can be accepted.
_Avoid_: Reusable Invite

**Removed Member**:
A former **Member** who no longer has access to a **Circle**. Transactions created by a Removed Member remain visible in the Circle with the creator's Display Name and Profile Picture preserved from removal time; if the same **User** rejoins by Invitation, their historical Transactions resolve to their current Display Name and Profile Picture again.
_Avoid_: Ex-member

**Deleted Member**:
A former **Member** whose **User** completed **Account Deletion**. A Deleted Member no longer has access, cannot rejoin as the same User, keeps Display Name for Circle attribution, does not keep Profile Picture, and is never reconnected to a future User even if the same person signs up again.
_Avoid_: Removed Member, Deleted User

**Member List**:
The current **Members** of a **Circle**. All current Members can view the Member List.
_Avoid_: Roster

**Historical Member**:
A **Member** whose status is no longer current but whose Circle-scoped attribution remains relevant to Transactions, filters, or History. Removed Members and Deleted Members are Historical Members; Active Members are current Members.
_Avoid_: Former User

**Transaction**:
A dated money movement recorded in exactly one **Circle** by a **Member**. In v1, a Transaction is either an **Expense** or **Income**, and has an amount, Transaction Date, Title, optional Note, and at least one Category.
_Avoid_: Entry, Record

**Transaction Type Change**:
Changing a saved **Transaction** between **Expense** and **Income**. Only the **Recorded By** Member can change Transaction type; the change requires confirmation, clears existing Categories, requires at least one active Category for the new type, and is recorded in **Transaction History**.
_Avoid_: Reclassification

**Recorded By**:
The **Member** who creates a **Transaction**. Only the Recorded By Member can edit the Transaction fields while they are a current Member, except that the **Owner** can archive or restore it for moderation; if the same **User** rejoins, they regain field-edit rights.
_Avoid_: Creator

**Paid By**:
The **Member** the **Transaction's** money movement belongs to. Paid By defaults to the **Recorded By** Member, can be set to another current Member, and preserves historical identity if that Member is later removed; Ledger Filter and Transaction Search can still include Removed Members when relevant, but when editing Paid By, only current Members can be newly selected. If the same **User** rejoins, Paid By resolves to their current Display Name and Profile Picture again.
_Avoid_: Payer

**Settlement**:
A debt-balancing workflow that calculates who owes whom inside a **Circle**. Settlement is out of scope for v1; PocketCircle tracks Transactions but does not calculate Member balances.
_Avoid_: Split, Owes

**Budget**:
A planned spending limit or envelope for a **Circle**, Category, Member, or time period. Budgets are out of scope for v1; PocketCircle tracks actual Transactions only.
_Avoid_: Limit, Envelope

**Recurring Transaction**:
A scheduled rule that creates repeated **Transactions**. Recurring Transactions are out of scope for v1; Transactions are entered manually.
_Avoid_: Subscription Rule

**Offline Use**:
Using PocketCircle without a live connection to save changes. Offline writes are out of scope for v1; the app can show stale or read-only data while disconnected but cannot save changes until reconnected.
_Avoid_: Offline Mode

**Amount**:
The positive monetary value of a **Transaction**, using the **Circle's** Currency. Expense or Income determines direction; zero or negative Amounts are not allowed, v1 supports up to two decimal places with a maximum of 999,999,999.99, and Amounts are stored as integer minor units for calculation.
_Avoid_: Signed Amount

**Title**:
The required short label for a **Transaction**, shown in lists, Transaction Search results, and Dashboard surfaces.
_Avoid_: Description

**Note**:
The optional longer text for a **Transaction**, used for item lists or extra context.
_Avoid_: Memo

**Archived Transaction**:
A **Transaction** removed from active reporting without being deleted. Archived Transactions are frozen and do not count toward Dashboard metrics. The lifecycle scope of **Ledger Filter** and **Transaction Search** defaults to all, so Archived Transactions appear alongside active ones, marked as archived; narrowing lifecycle scope to active hides them, and archived shows only them. Creator Members can restore their own Archived Transactions, and Owners can restore any Archived Transaction in the Circle.
_Avoid_: Deleted Transaction

**Transaction Date**:
The plain calendar date assigned to a **Transaction** for reporting and Transaction Search. It has no time-of-day component, no timezone conversion, and defines Dashboard month buckets and date-range Transaction Search.
_Avoid_: Timestamp

**Audit Metadata**:
The created-by, created-at, updated-by, and updated-at details for a **Transaction**. Current Members can view Audit Metadata in Transaction detail, and timestamps are displayed with their stored timezone or offset rather than converted to the viewer's timezone.
_Avoid_: Activity Log

**Transaction History**:
The immutable change history for a **Transaction**, including created, edited, archived, and restored events. Current Members can view Transaction History in Transaction detail, including the acting Member, changed field names, and old and new values for amount, Transaction Date, Title, Note, Transaction type, Paid By, and Categories; amount changes retain their **Currency**, and internal IDs are not shown.
_Avoid_: Hidden Audit Trail

**Expense**:
A **Transaction** that represents money leaving the **Circle's** budget.
_Avoid_: Cost, Spend

**Income**:
A **Transaction** that represents money entering the **Circle's** budget.
_Avoid_: Earning, Revenue

**Refund**:
An **Income** Transaction that represents money returned from a prior purchase. V1 does not link a Refund to the original Expense; archiving the original Expense is reserved for voids, mistakes, or records the user wants removed from active reporting.
_Avoid_: Negative Expense

**Category**:
A type-specific label created inside exactly one **Circle** to classify **Transactions**. A Transaction must have one or more Categories and cannot select the same Category more than once; Category names are unique per Circle and Transaction type case-insensitively; a Category records the **Member** who created it; Members can edit, archive, or restore their own Categories while they are current Members, while the **Owner** can archive or restore any Category in the Circle but cannot rename or recolor another Member's Category. Categories created by Removed Members remain active unless archived; if the same **User** rejoins, they regain field-edit rights on their Categories.
_Avoid_: Tag, Bucket

**Category Color**:
The required visual color assigned to a **Category**. PocketCircle chooses an initial Category Color when a Category is created; Members can change colors they are allowed to edit, colors can be shared by multiple Categories, and UI must not identify a Category by color alone.
_Avoid_: Category Icon, Emoji

**Archived Category**:
A **Category** removed from future Transaction selection while remaining attached to historical **Transactions**. Archived Categories can still be used to filter historical Transactions when matching Transactions exist; Transactions can keep already-attached Archived Categories during edits, but Archived Categories cannot be newly added to Transactions, and an Archived Category's name cannot be reused unless the Category is restored.
_Avoid_: Deleted Category

**Category History**:
The immutable change history for a **Category**, including created, edited, archived, and restored events. Current Members can view Category History, including the acting Member, changed field names, and old and new values for name and Category Color; internal IDs are not shown.
_Avoid_: Hidden Category Audit

**Category Detail**:
A focused view of one **Category** inside its **Circle**, reached from Category notifications or the Category list. It shows the Category's name, type, color, lifecycle status, creator attribution, edit and archive or restore actions when allowed, recent Transactions that use the Category ordered by Transaction Date, a link to all matching Transactions in all-time **Transaction Search**, and **Category History**. Archived Categories still have a Category Detail view because they remain attached to historical Transactions.
_Avoid_: Category Profile, Category Page

**Category Filter**:
A lightweight way to narrow a **Circle's** **Category** list of one **Transaction** type by Category name text and lifecycle scope: active, archived, or all. The Category Filter is a view over the type-scoped Category list; it does not change which Categories can be attached to Transactions. It parallels **Ledger Filter** and is distinct from **Transaction Search**, which finds Transactions, not Categories.
_Avoid_: Category Search, Category Lookup

**Dashboard**:
A per-**Circle** summary of money activity. The v1 Dashboard shows current-month Income, Expenses, Net, recent Transactions, a selected-month Expense breakdown by Category, and month-over-month Income, Expense, and Net comparison; all metrics include active Transactions across the Circle. Category analytics are non-additive because a Transaction can have multiple Categories, and include Archived Categories when active Transactions in the selected period still use them.
_Avoid_: Overview

**Home Summary**:
A future cross-**Circle** summary of a **User's** money activity across visible Circles. Home Summary is distinct from the per-Circle **Dashboard** and does not replace Circle-scoped reporting.
_Avoid_: Global Dashboard, Overview

**Monthly Ledger**:
The month-focused Transaction view for a **Circle**. A Monthly Ledger shows one selected month and year, that month's Income, Expenses, and Net, and that month's Transactions sorted by Transaction Date descending and then created-at descending.
_Avoid_: Transaction List

**Ledger Filter**:
A lightweight way to narrow a **Monthly Ledger** to the selected month using Transaction text, Transaction type, Category, Recorded By, Paid By, and lifecycle scope: active, archived, or all. A Ledger Filter is reset when the User changes the selected **Monthly Ledger** month.
_Avoid_: Search, Advanced Search

**Comparison Range**:
The time window used by the Dashboard's month-over-month comparison. It defaults to six months and can be changed to one month, three months, or one year.
_Avoid_: Date Range

**Transaction Search**:
A dedicated per-**Circle** way to find **Transactions** by Title, Note, type, Category, Recorded By, Paid By, lifecycle scope, date range or all-time scope, and amount range. Transaction Search is separate from the **Monthly Ledger** and offers all Categories and all current or Removed Members as filter options; Archived Circles remain searchable through their read-only Circle routes.
_Avoid_: Search, Global Search

**Export**:
A CSV download of **Transactions** from one **Circle**. Any current **Member** can Export Transactions they can view; Export includes active Transactions by default and can optionally include Archived Transactions, and exported amounts identify the **Currency** explicitly. V1 supports Export but does not support importing Transactions.
_Avoid_: Import

**Account Export**:
A future download of a **User's** PocketCircle data across the account. Account Deletion may point Users toward Account Export before deletion, but Account Export is not required before deleting an account.
_Avoid_: Backup

**Notification Center**:
The in-app list of user-specific Circle events. Notifications belong to one **User**, have per-User unread/read state, can be marked read individually or in bounded batches, and cannot be deleted in v1. The dropdown shows **unread only**, at most **20 at a time** — there is no “Load more”; **Mark all read** at the bottom of the list clears the visible batch and the next unread batch appears reactively. Read notifications are not listed in the dropdown (inbox to clear, not history). Notifications link to the relevant Circle, Transaction, or Category when the User still has access; otherwise they show text only, and archived objects open in their archived context. V1 notifications include Invitation accepted, revoked, or expired involving the User; being added to or removed from a Circle; ownership transferred to or from the User; Circle archived or restored for a Circle they belong to; a Transaction recorded with Paid By set to them by another Member; their Transaction archived or restored by the Owner; and their Category archived or restored by the Owner.
_Avoid_: Activity Feed

**Email Notification**:
An email sent outside the app. V1 Email Notifications are limited to Welcome, Invitation, Feedback delivery, and Account Deletion verification emails; normal Circle activity never sends email.
_Avoid_: Activity Email

**Feedback**:
An in-app way for a **User** to report a bug or request a feature, including requests to add a supported Currency. Feedback has a type, required message, optional current Circle context, and automatically includes User email, Display Name, and app build information when available; it sends an email to the configured support address and does not create app data inside a Circle.
_Avoid_: Support Ticket

**App Version**:
The released app version and build identifier shown in Settings and included in **Feedback** when available.
_Avoid_: Release Notes

## Example Dialogue

**Product**: "A person creates a Circle and invites the people they budget with."

**Engineer**: "So shared transactions belong to the Circle, not to a generic group?"

**Product**: "Correct. Circle is the canonical shared space."

**Engineer**: "Can two Circles have the same name?"

**Product**: "Yes. Circle identity is not the name, so the UI uses the Circle Mark and name together."

**Engineer**: "Where does a new User record transactions before joining anyone else?"

**Product**: "Every Google-authenticated User starts with a Personal Circle for solo tracking. To collaborate, they create a regular Circle or join one by Invitation."

**Engineer**: "Can the Personal Circle be removed?"

**Product**: "No. It can be renamed, but it cannot invite Members, be archived, deleted, left, or transferred."

**Engineer**: "What can Members do in an Archived Circle?"

**Product**: "They can view and search historical Transactions, but active changes are disabled unless the Owner restores the Circle."

**Engineer**: "Should every Circle get Rent or Mortgage?"

**Product**: "No. Circle Setup asks Residence Type only when relevant. Leased suggests Rent; owned suggests Mortgage. Shared defaults like Groceries, Dining, Transport, Utilities, Health, Entertainment, Shopping, Education, and Travel are still useful."

**Engineer**: "Can Members change Circle Settings?"

**Product**: "No. Circle Settings are Owner-controlled, but Members can still create non-colliding Categories in the Circle."

**Engineer**: "When you say account, do you mean the login or the person inside a Circle?"

**Product**: "Use User for the login, and Member for the User's role inside one Circle."

**Engineer**: "Can someone use PocketCircle without Google sign-in?"

**Product**: "No. V1 uses Google sign-in only."

**Engineer**: "Can a Circle have more than one Owner?"

**Product**: "No. A Circle has exactly one Owner, but ownership can be transferred to another Member before the current Owner leaves."

**Engineer**: "How does someone become a Member?"

**Product**: "The Owner sends an Invitation to an email address. A User can accept only when their Google Account Email matches that Invitation email."

**Engineer**: "Can an old Invitation email be reused?"

**Product**: "No. Invitation Links are single-use and resends invalidate older links."

**Engineer**: "Can non-Owners see invitee emails in Circle History?"

**Product**: "No. They can see that an Invitation action happened, but only the current Owner sees the invitee email."

**Engineer**: "If Alex is removed, do Alex's rent and grocery transactions disappear?"

**Product**: "No. They stay in the Circle and still show Alex as the original creator."

**Engineer**: "Can normal Members edit each other's transactions?"

**Product**: "No. Members can edit or archive only their own Transactions. The Owner can archive or restore anyone's Transactions, but cannot rewrite another Member's Transaction fields."

**Engineer**: "Are expenses and income separate objects?"

**Product**: "No. They are Transaction types. v1 supports Expense and Income only."

**Engineer**: "If Sam records Alex's grocery expense, who owns the Transaction?"

**Product**: "Sam is Recorded By and controls field edits. Alex can be Paid By so Ledger and Search show whose money movement it was."

**Engineer**: "How should a real refund be recorded?"

**Product**: "As Income categorized as Refund. Archiving the original Expense is for voids or mistakes, not the general refund workflow."

**Engineer**: "Does a Transaction need a time of day?"

**Product**: "No. Transaction Date is calendar-only; timestamps are not the reporting date."

**Engineer**: "If a Member in IST searches May 1 to May 30, does Circle timezone matter?"

**Product**: "No. Transaction Date is a plain date. Transaction Search and Dashboard use the dates as entered, without timezone conversion."

**Engineer**: "Can Members see who edited a Transaction?"

**Product**: "Yes. Current Members can see Transaction Audit Metadata and Transaction History in the detail view."

**Engineer**: "Does removing a Transaction erase it?"

**Product**: "No. It becomes an Archived Transaction, stops counting toward Dashboard metrics, is frozen, and can be restored later."

**Engineer**: "Can Morgan attach one grocery Transaction to both a Personal Circle and a Trip Circle?"

**Product**: "No. A Transaction belongs to exactly one Circle."

**Engineer**: "Can a Trip Circle mix USD and CAD?"

**Product**: "No. Each Circle has one Currency, and every Transaction in that Circle uses it."

**Engineer**: "Are Categories global?"

**Product**: "No. Categories belong to one Circle, including a Personal Circle. Members can create and edit their own Categories, and the Owner can archive or restore any Category."

**Engineer**: "Can the Owner rename another Member's Category?"

**Product**: "No. Category permissions follow Transaction permissions: creators control fields, while the Owner can archive or restore for moderation."

**Engineer**: "If Taylor removes Coffee as a Category, what happens to old Coffee Transactions?"

**Product**: "The Category is archived. Old Transactions still show Coffee, and search can still filter by Coffee when matching Transactions exist."

**Engineer**: "Should Rent appear when adding Income?"

**Product**: "No. Categories are type-specific, so Expense forms show Expense Categories and Income forms show Income Categories."

**Engineer**: "Can one Transaction have both Car and Gas as Categories?"

**Product**: "Yes. Transactions can have multiple Categories, so filtering by Car can include financing, gas, cleaning, and other car-related costs."

**Engineer**: "Can two Members both create an Expense Category named Gas in one Circle?"

**Product**: "No. Category names are unique per Circle and Transaction type, ignoring case."

**Engineer**: "Do Categories need icons?"

**Product**: "No. Categories require colors, but color is a visual cue only and can be shared by multiple Categories."

**Engineer**: "Can the Dashboard show Category totals as a pie chart?"

**Product**: "No. Category analytics are non-additive because one Transaction can count under multiple Categories."

**Engineer**: "Does the Dashboard combine all Circles?"

**Product**: "No. The v1 Dashboard is per Circle and compares Income, Expenses, and Net over a selected Comparison Range."

**Engineer**: "Can Transaction Search find Categories without Transactions?"

**Product**: "No. Transaction Search finds Transactions. Categories are structured filters, not text matches."
