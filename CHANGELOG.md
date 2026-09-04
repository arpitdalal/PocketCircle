# Changelog

All notable user-facing changes are documented here.

This format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and PocketCircle uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [v0.4.0] - 2026-09-04

### Added

- New Transaction and New Category now include Save & new so you can save one
  entry and keep the form open for another.
- Keyboard users can skip to main content from the authenticated app shell.
- PocketCircle now works with AI assistants that support remote MCP (for
  example Claude, Cursor, etc). After you approve Circles and permissions in the
  browser, the assistant can review spending and record or update transactions
  and categories in those Circles.
- The account menu now includes Connections for the MCP server URL, connected
  assistants, and revoking access.

### Fixed

- Changing chart or list filters no longer jumps the page back to the top.

## [v0.3.0] - 2026-08-26

### Added

- Home now includes Add transaction for recording an expense or income in any
  active Circle.
- Transaction Detail now includes Duplicate for creating a new transaction from
  an existing one.
- Added a What's new page for current and previous release notes, linked from
  the account menu and Settings.
- The Notification Center now has Unread and All views with full notification
  history.

### Changed

- Google sign-in now asks which account to use each time. The sign-in page also
  shows a masked reminder of the last Google account used on that device.
- Income, expense, and net totals and cash-flow charts now animate when the
  selected period or currency changes. Reduced-motion preferences disable these
  animations.

### Fixed

- Mark all read now clears the full unread backlog instead of only the first
  page.
- Cash-flow totals and charts no longer disappear while a new selection loads.

## [v0.2.0] - 2026-08-17

### Added

- After you sign in, Home now shows a Cash flow report for one currency at a
  time: income, expenses, and net for the last 1, 3, 6, or 12 months, plus a
  month-by-month trend, per-Circle contributions, and recent transactions you
  paid. Totals count money you paid, not your share of a split. Circle cards
  stay below. You can leave a Circle out of the report without hiding it;
  that choice sticks across visits. Amounts in different currencies stay
  separate.

### Changed

- The optional Get started checklist now lives on Home instead of your
  Personal Circle. Recording a transaction or creating a category counts in
  any Circle you belong to, not only Personal.

### Fixed

- On phones, the Circle navigation bar sat above the bottom of the screen
  with a gap under the labels. It now sits flush and fills the iPhone home
  indicator.

## [v0.1.0] - 2026-08-16

First public beta of PocketCircle — a place for partners, families, roommates,
and trip groups to track shared spending together.

### Added

- Sign in with Google. You get a private Personal Circle for your own money,
  and you can create shared Circles for groups.
- Set up each shared Circle with a currency, starter categories, and a look
  that is easy to tell apart. Archive finished Circles; delete ones that never
  got used.
- Record expenses and income with amount, date, title, note, who paid, and
  categories. Edit or hide mistakes; see who changed a record and when.
- Invite people by email, accept invites, leave a Circle, remove members, or
  hand ownership to someone else. Your Personal Circle stays private.
- See month totals, charts, and category breakdowns on the Circle home page,
  browse a month-by-month ledger, search across records, and download a CSV.
- Get in-app notifications when something involves you, plus a welcome email
  and invite emails when someone asks you to join.
- Update your profile, turn off product analytics, send feedback, or delete
  your account. Shared Circles keep enough history that other members’ records
  still make sense.
- Optional Get started checklist on your Personal Circle, and Install
  PocketCircle on phones and desktops that support it.
- Works on phone and desktop, updates live when others change a Circle, and
  formats money clearly for your language.

### Security

- Invite links work once, expire after seven days, and only the invited Google
  account can accept them.
- Deleting your account asks you to confirm in writing and verify by email
  before anything is removed.
