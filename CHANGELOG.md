# Changelog

All notable user-facing changes are documented here.

This format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and PocketCircle uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [v0.1.0] - 2026-08-16

First public beta of PocketCircle — collaborative Transaction tracking for
partners, families, roommates, trips, and other shared Circles.

### Added

- Google sign-in with Terms and Privacy Policy acceptance, then a private
  Personal Circle created automatically for solo tracking.
- Regular Circles with guided setup (currency, starter Categories, color, and
  mark), Owner settings, archive/restore, empty-Circle delete, and Circle History.
- Expense and Income Transactions with Amount, Date, Title, Note, Paid By,
  multi-Category tags, inline Category create, edit (including type change),
  archive/restore, detail audit metadata, and field history.
- Categories that are type-specific per Circle, with create/edit, archive/restore,
  search and lifecycle filters, and Category History.
- Membership for regular Circles: email invitations (7-day single-use links,
  resend/revoke), accept and rejoin, Member list, leave, Owner remove Member,
  and ownership transfer — Personal Circles stay solo.
- Circle Dashboard with month totals, comparison charts, category analytics,
  recent activity, and drilldowns into the Monthly Ledger.
- Monthly Ledger with month navigation, totals, and filters; Circle-wide
  Transaction Search (text, type, people, Categories, dates, amounts, lifecycle)
  with CSV export of the current result set.
- In-app Notification Center for events that involve you, with unread state and
  deep links into Circles, Transactions, Categories, and membership flows.
- Welcome email on first sign-in and invitation emails when Owners invite people
  to join.
- Settings for Display Name, Personal Circle name sync, privacy-safe product
  analytics opt-out, app version, and verified Account Deletion that keeps shared
  financial attribution intact for other Members.
- In-app Feedback (bug, feature, or currency requests) from the account menu and
  Circle chrome.
- Skippable Get started checklist on the Personal Circle Dashboard for first
  Transaction, Category, regular Circle, and invited Member.
- Install PocketCircle from the account menu on supported browsers (native
  install prompt or iOS Add to Home Screen guidance).
- Responsive web app with Circle switcher, mobile bottom navigation, live
  updates, and locale-safe money formatting.

### Security

- Invitation links use hashed single-use tokens that expire after seven days;
  only the matching Google account email can accept.
- Account Deletion requires eligibility checks, phrase confirmation, and email
  verification before the account is removed.
