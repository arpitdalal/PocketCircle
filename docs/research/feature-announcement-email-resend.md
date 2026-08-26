# Feature announcement email through Resend

Research date: 2026-08-25. Sources are the PocketCircle repository, current Resend documentation, Canada's legislation and CRTC guidance, and the U.S. FTC's CAN-SPAM guide.

## Verdict

Email is a useful second channel for Feature Announcements, but it should not expand issue #282. Ship and verify the in-app announcement first. Track product-update email as a linked follow-up and send the first campaign only after the released build is stable.

Use a Resend Broadcast, not PocketCircle's transactional email action or Resend's Batch Email endpoint. Resend lists product launches and changelogs as Broadcast use cases, manages Contacts and Segments, and handles unsubscribe flows. Its Batch Email documentation explicitly directs marketing campaigns to Broadcasts. [Resend Broadcasts](https://resend.com/docs/dashboard/broadcasts/introduction), [Resend Batch Email](https://resend.com/docs/dashboard/emails/batch-sending)

There is one blocker before emailing all existing Users: PocketCircle has not collected product-update email consent. Account creation records acceptance of the Terms and Privacy Policy, not consent to product announcement emails. The current Privacy Policy says PocketCircle sends Welcome, Invitation, Account Deletion, and support-related email, and describes Resend as the provider for transactional and support email. `packages/convex/convex/schema.ts:33-48`; `packages/convex/convex/model.ts:41-50`; `apps/web-app/app/routes/privacy.tsx:41-50,72-89`.

Do not treat an existing PocketCircle account as blanket marketing consent. A narrowly factual message about a new capability for an existing account may fit Canada's limited consent exception, but that is a legal/content decision, not an engineering assumption. The safe product default for recurring announcements is express opt-in.

## Current PocketCircle email architecture

- The app User row stores the current canonical Google Account Email and Display Name. New Users get both at account creation; later Better Auth updates patch the email. `packages/convex/convex/schema.ts:33-48`; `packages/convex/convex/model.ts:34-50,170-184`.
- `sendEmail` posts one message to `POST /emails`, using `RESEND_API_KEY` and `RESEND_FROM_EMAIL`. It has no contact list, unsubscribe headers, campaign, segment, or preference behavior. `packages/convex/convex/email.ts:45-90`.
- A shared Workpool runs at five concurrent actions with retry and exponential backoff. Welcome sends add a per-User idempotency key and patch `welcomeSentAt` after a confirmed send. `packages/convex/convex/email.ts:28-43,112-170`; `packages/convex/convex/convex.config.ts:5-11`.
- That pool is deliberately transactional. The PRD and domain glossary limit Email Notifications to Welcome, Invitation, Feedback delivery, and Account Deletion verification. `docs/prd/v1.md:181-184`; `CONTEXT.md:247-249`.
- Resend keeps Email and Batch Email idempotency keys for only 24 hours. PocketCircle's current per-User marker supplies durable welcome deduplication beyond that provider window. [Resend idempotency keys](https://resend.com/docs/dashboard/emails/idempotency-keys)
- Resend's current default API limit is 10 requests per second for a team, shared across its API keys, with separate email and Contact quotas. Workpool parallelism limits simultaneous calls, not requests per second. A large fan-out through the existing sender could still compete with Invitation, Welcome, Feedback, and Account Deletion traffic. [Resend usage limits](https://resend.com/docs/api-reference/rate-limit)

The existing seam remains right for transactional mail. Feature campaigns belong beside it, not inside it.

## Recommended first campaign

### 1. Keep delivery operational

For the first rare announcement, do not build a campaign engine in Convex.

1. Release Duplicate Transaction and the in-app Feature Announcement.
2. Wait until the release has run without a rollback. Two or three days is a sensible operational delay, not a system invariant.
3. Resolve the consent basis and final legal footer before exporting any recipient.
4. Create a scoped recipient snapshot containing only email and optional Display Name. Use the same `eligibleBefore` cutoff as the in-app campaign. Prefer Users who still lack `duplicate-transaction` acknowledgment when the snapshot is taken. A further filter for at least one eligible Transaction would reduce irrelevant mail but needs an explicit product decision.
5. Import the snapshot into a release-specific Resend Segment, such as `feature-duplicate-transaction-2026-08`.
6. Create a Broadcast in the Resend dashboard, send tests, include Resend's unsubscribe footer, and schedule the send. Resend supports editing, testing, scheduling, and canceling scheduled Broadcasts. [Resend Broadcasts](https://resend.com/docs/dashboard/broadcasts/introduction)
7. Keep the message generic. Do not include a Circle name, Transaction title, amount, source ID, or other financial data. Link to PocketCircle Home. The app can choose the safe recent Transaction after authentication.

Suggested shape:

- Subject: `New in PocketCircle: duplicate a transaction`
- One short explanation that Duplicate creates a separate editable copy
- CTA: `Open PocketCircle`
- Sender identity, required contact information, physical mailing address, and unsubscribe footer

Email delivery does not acknowledge the in-app card. A click only opens the app. Acknowledgment remains an authenticated in-app CTA or close action.

### 2. Let Resend own campaign mechanics

Resend now uses global Contacts. Segments are internal recipient groups; Topics are recipient-facing preference categories. Broadcast unsubscribe links can let a Contact leave one Topic or all Broadcast email. [Global Contacts model](https://resend.com/docs/dashboard/segments/migrating-from-audiences-to-segments), [Resend Topics](https://resend.com/docs/dashboard/topics/introduction)

Create a public `Product updates` Topic only when PocketCircle adds recurring email consent. Its default should be **Opt-out** in Resend's terminology, which means a Contact receives nothing until explicitly subscribed. Resend cannot change a Topic's default after creation. [Resend Topics](https://resend.com/docs/dashboard/topics/introduction)

Resend also suppresses addresses after permanent bounces, complaints, or a manual suppression. Suppressions apply team-wide to transactional and Broadcast email, which protects the existing transactional stream too. [Resend email suppressions](https://resend.com/docs/dashboard/emails/email-suppressions)

Do not use `POST /emails/batch` for this. It accepts at most 100 messages per request, does not support scheduled sends in a batch, rejects a batch containing an invalid payload, and leaves PocketCircle responsible for audience and unsubscribe state. Resend itself says Batch Email is for transactional sends with many recipients and Broadcasts are for marketing campaigns. [Resend Batch Email](https://resend.com/docs/dashboard/emails/batch-sending)

## If campaigns become recurring

Build the next layer only after the first campaign proves useful:

- Add an explicit Product updates email preference in Settings. Keep it separate from `acknowledgedFeatureAnnouncementIds`; seeing an in-app card and consenting to future email are different decisions.
- Record enough consent evidence to prove the opt-in: status, timestamp, source, and the disclosure version shown. A bare boolean loses that evidence.
- Treat Convex as the consent source of truth. Sync consented Users to Resend Contacts and the Product updates Topic.
- Sync Google Account Email changes. Resend Contacts are global by email and their email address cannot be edited, so an email change needs deliberate old-Contact removal and new-Contact creation without silently converting an opt-out into an opt-in. [Resend Contacts](https://resend.com/docs/dashboard/audiences/contacts)
- Remove the Resend Contact during Account Deletion. Importing Contacts creates external profile state that the current deletion workflow does not know about.
- Receive Resend Contact update webhooks if the in-app setting must reflect unsubscribes made on Resend's page. Verify each webhook against its raw body and deduplicate it because Resend provides at-least-once, unordered webhook delivery. [Contact updated webhook](https://resend.com/docs/webhooks/contacts/updated), [webhook verification](https://resend.com/docs/webhooks/verify-webhooks-requests), [webhook delivery](https://resend.com/docs/webhooks/introduction)
- Store a Broadcast ID and campaign status only if PocketCircle starts creating Broadcasts through the API. Resend documents idempotency for Email and Batch Email endpoints, not Broadcast creation. The Resend dashboard is the simpler operator control until automation has a real benefit. [Resend idempotency keys](https://resend.com/docs/dashboard/emails/idempotency-keys), [Broadcast API](https://resend.com/docs/api-reference/broadcasts/create-broadcast)

Delivery/open/click webhooks are unnecessary for the first manual campaign because the Resend dashboard already reports campaign results. Add them only if PocketCircle needs its own delivery ledger. Resend webhooks are at-least-once and may arrive out of order, so such a ledger must deduplicate `svix-id` and compare event timestamps. [Resend webhook delivery](https://resend.com/docs/webhooks/introduction)

## Compliance boundary

This is the part that makes email materially larger than the in-app announcement.

### Canada

CASL normally requires prior express or implied consent, sender identification, and an unsubscribe mechanism for a commercial electronic message. Express consent requires a proactive opt-in, does not expire until withdrawal, and must be provable by the sender. [CRTC CASL requirements](https://web.crtc.gc.ca/eng/internet/anti/reg.htm), [CRTC consent guidance](https://web.crtc.gc.ca/eng/com500/guide.htm)

Section 6(6) removes the prior-consent requirement when a message **solely** provides factual information about an ongoing account or delivers a product update that the recipient is already entitled to receive. It does not remove the identification and unsubscribe requirements. Promotional framing, mixed content, or an upsell makes this exception harder to rely on. [CASL section 6](https://laws-lois.justice.gc.ca/eng/acts/E-1.6/section-6.html)

A compliant message must identify the sender, give a mailing address and another contact method, and keep that contact information valid for at least 60 days. The unsubscribe mechanism must be free and readily performed, remain available for at least 60 days, and take effect without delay or within 10 business days. [CRTC identification rules](https://laws-lois.justice.gc.ca/eng/regulations/SOR-2012-36/section-2.html), [CASL unsubscribe rules](https://laws-lois.justice.gc.ca/eng/acts/E-1.6/section-11.html)

The conservative decision is to treat recurring Feature Announcement email as commercial Product updates email and require express opt-in. If the first Duplicate message will go to Users without that opt-in, have its exact copy and recipient basis reviewed against the narrow factual-account exception before sending.

### United States

The FTC says CAN-SPAM applies based on a message's primary purpose, not whether it is sent in bulk. Commercial messages require accurate headers and subjects, clear identification as an advertisement, a valid physical postal address, a clear opt-out, and timely opt-out processing. A message only about changed features of an ongoing account may be transactional or relationship mail, but the FTC says to read that category narrowly. [FTC CAN-SPAM guide](https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business)

Resend does not take this responsibility from PocketCircle. Use the stricter campaign footer and unsubscribe behavior for every recipient rather than trying to infer a recipient's country from data PocketCircle does not collect.

## Decisions still needed

1. Is the first email a narrowly factual service update, or the start of recurring Product updates marketing?
2. Should the recipient snapshot exclude Users who already acknowledged the in-app announcement? Recommended: yes.
3. Should the snapshot require at least one eligible Transaction? Recommended: yes for relevance, but this adds a recipient query beyond the User cutoff.
4. What legal sender name, physical mailing address, and monitored contact method go in the footer?
5. Should future Users be offered an explicit Product updates opt-in in Onboarding, Settings, or both? Recommended: optional in Onboarding and editable in Settings.

## Issue placement

Issue #282 should say that Feature Announcement email is out of scope and link a follow-up. That follow-up should own consent, recipient selection, Resend Contact lifecycle, the Broadcast runbook, legal copy, account deletion, and any webhook sync. This keeps the first in-app layer shippable and prevents a marketing-email system from being smuggled into a card implementation.
