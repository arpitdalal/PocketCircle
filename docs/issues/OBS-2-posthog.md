# OBS-2 · PostHog product analytics

|                 |                                                                                |
| --------------- | ------------------------------------------------------------------------------ |
| **Status**      | Done                                                                           |
| **Issue**       | [#48](https://github.com/arpitdalal/PocketCircle/issues/48)                    |
| **Labels**      | `enhancement`, `area:observability`, `frontend`, `security`, `ready-for-agent` |
| **Depends on**  | SET-1 (done), OBS-1 (done)                                                     |
| **Related**     | FBK-1 (done; optional `feedback_submitted` event)                              |
| **PRD stories** | 93, 91, 184                                                                    |
| **ADRs**        | 0013, 0006, 0017                                                               |
| **Glossary**    | User, Feedback, Transaction, Ledger Filter, Transaction Search, Export         |

## Intent

Add PostHog product analytics for coarse feature usage only. Product analytics are **default-on**
after legal acceptance because every bootstrapped User has `analyticsOptOut: false` by default, and
users can later opt out in Settings. Respect that preference completely. Do **not** affect Sentry:
OBS-1 made Sentry always-on and independent of `analyticsOptOut`.

Hard privacy rule: never send financial content or free text to PostHog. No Transaction Title, Note,
exact Amount/min/max, Feedback message, search query text, Circle/Category/Member names, emails,
Display Names, refs, ids, or raw URLs. Only event names and whitelisted coarse props.

## Implementation summary

### Analytics seam (`apps/web-app/app/lib/analytics.ts`)

- Sole importer of `posthog-js`.
- `initAnalytics(user)` — browser-only, requires `VITE_POSTHOG_KEY`, skips when `analyticsOptOut`.
- `setAnalyticsOptOut(optOut)` — opts out/in via PostHog browser API without reload.
- `track(event, props?)` — whitelisted events only; forbidden keys stripped before capture.
- Session Replay disabled via `disable_session_recording: true` plus `stopSessionRecording()`.
- No `identify` in v1.

### Env

- `VITE_POSTHOG_KEY` / `VITE_POSTHOG_HOST` wired through `app/lib/env.ts`, `app/env.d.ts`, `.env.example`.
- Missing key → analytics no-op.

### Lifecycle

- `protected-layout.tsx` calls `initAnalytics` + `setAnalyticsOptOut` when session is ready and
  onboarding is complete. Settings persists opt-out only; analytics reacts via session updates.

### v1 events (wired)

| Event                             | Call site                                                    |
| --------------------------------- | ------------------------------------------------------------ |
| `circle_created`                  | `circle-new.tsx`                                             |
| `transaction_added`               | `transaction-form.tsx` (create only)                         |
| `category_created`                | `category-form.tsx`, `transaction-form-category-section.tsx` |
| `ledger_filter_applied`           | `transactions.tsx` (Apply)                                   |
| `transaction_search_submitted`    | `search.tsx` (debounced search + filter Apply)               |
| `transaction_search_page_changed` | `search.tsx` (pagination)                                    |
| `export_performed`                | `search.tsx` (downloaded / too_many / inaccessible / failed) |
| `feedback_submitted`              | `settings.tsx` (after mutation success)                      |

Coarse prop helpers live in `app/lib/analytics-props.ts`. Event/prop allowlists in
`app/lib/analytics-events.ts`.

### Tests

- Unit: `analytics.test.ts`, `analytics-props.test.ts` — opt-out, no replay, whitelist, Sentry independence.
- Route/component: call-site `track` assertions via `app/test/analytics-mock.ts`.
- MSW PostHog handler reused from `packages/mocks` for future integration tests.

## Done when

- [x] PostHog installed and initialized only through the app analytics seam.
- [x] Product analytics honor `analyticsOptOut`, default on for fresh Users, disable/enable from Settings.
- [x] Session Replay disabled for PostHog v1.
- [x] All analytics payloads pass the event/prop whitelist.
- [x] Representative feature events wired.
- [x] Tests prove opt-out, no replay, whitelist enforcement, Sentry independence, call-site events.
- [x] Gates pass: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`.

## Out of scope

- Building or changing the opt-out storage/UI (SET-1 is done).
- Sentry setup or Sentry replay behavior (OBS-1 is done and independent).
- PostHog Session Replay.
- User identity/group analytics, `identify`, email/name/user id capture, or Circle id/ref capture.
- Backend/Convex analytics events.
- Tracking edits, archives/restores, notifications, invitations, or dashboard chart interactions unless
  a future issue defines their safe event contract.
