# Last-used Google Account Email on sign-in

Research date: 2026-08-19. Sources are first-party specs and product docs. Written for GitHub issue [#208](https://github.com/arpitdalal/PocketCircle/issues/208) (needs grilling).

## What #208 asks

Help a returning User remember which **Google Account Email** they used. The ticket suggests showing a masked last-used address on login. No comments. Labels: `enhancement`, `needs-info`.

## PocketCircle baseline

- V1 is Google-only Better Auth (ADR 0002). Identity is Google `sub`; **Google Account Email** stays live-synced and is what Invitation acceptance matches (ADR 0024, glossary).
- `/signin` is a custom "Continue with Google" button. It calls `authClient.signIn.social({ provider: "google", callbackURL })` with no `login_hint` and no `prompt`. See [`signin.tsx`](../../apps/web-app/app/routes/signin.tsx) and [`auth-client.ts`](../../apps/web-app/app/lib/auth-client.ts).
- Invitation landing already shows the invited address in full and then signs in with the same unhinted Google flow. See [`invite.tsx`](../../apps/web-app/app/routes/invite.tsx).
- Failed Invitation Link attempts must not reveal whether an email belongs to a User (ADR 0015 / PRD). Unauthenticated lookups of "does this email have an account?" are out.
- Better Auth is pinned at `1.6.16`. In this version, `signIn.social` accepts **`loginHint`** but not call-time **`additionalParams`** (that lands in a later release). Use provider-level `prompt: "select_account"` in `packages/convex/convex/auth.ts`. [Better Auth Google](https://better-auth.com/docs/authentication/google)

There are two different returning-user failures. They want different fixes.

1. **Wrong Google session.** The browser still has a Google login. PocketCircle (or Google) silently continues as the last Google session, which is not the PocketCircle User. The User did not forget the email. The chooser never appeared.
2. **Forgot which address.** No useful Google session, or several personal/work addresses, and the User cannot remember which one created the PocketCircle account.

A masked string on our card only helps (2), and only if we also drive Google with the real address. It does nothing for (1) unless we change OAuth `prompt` / `login_hint`.

## What the specs actually do

### OpenID Connect `login_hint`

`login_hint` is an optional hint to the IdP about which End-User to authenticate. Typical value is an email collected by the RP before redirect. [OIDC Core §3.1.2.1 / third-party initiated](https://openid.net/specs/openid-connect-core-1_0.html)

### Google authorization endpoint

Google documents two knobs PocketCircle does not set today:

- `login_hint`: email or Google `sub`. Google says this **suppresses the account chooser** and either prefills the email box or selects the matching multi-login session, specifically to avoid the wrong account. [Google OIDC](https://developers.google.com/identity/openid-connect/openid-connect)
- `prompt=select_account`: always show the account chooser, including when only one Google session exists. [Google OIDC `prompt`](https://developers.google.com/identity/openid-connect/openid-connect)

Better Auth's Google provider can set `prompt: "select_account"` on the provider config, and can forward `loginHint` / `additionalParams` on the social call. [Better Auth Google](https://better-auth.com/docs/authentication/google)

Practical catch: Google's docs claim `sub` works as `login_hint`. Client bugs have reported email working and `sub` not. Prefer the live **Google Account Email** if we pass a hint. Email can change (ADR 0024); refresh the stored hint after every successful sign-in.

`login_hint` without `select_account` is the fast path and the dangerous one on a shared browser: Continue can skip the chooser and land in the previous User's session if that Google account is still signed in.

### Google's own "last used" UI (GIS personalized button + FedCM)

The industry feature #208 is reaching for already exists inside **Google Identity Services**, not as an RP-drawn mask:

- A **personalized Sign in with Google button** shows name/email for a Google session that has already approved the site, so occasional users remember they used Google and which account. Icon/small buttons and sub-200px widths disable personalization. [GIS button UX](https://developers.google.com/identity/gsi/web/guides/personalized-button)
- **One Tap** is the "Continue as …" chip. Google draws it. The RP does not store the email. [One Tap UX](https://developers.google.com/identity/gsi/web/guides/features)
- **FedCM** is the current browser-mediated path (no third-party cookies). Chrome owns prompt placement and settings. GIS documents a transition that made FedCM mandatory for the older Google Sign-in platform library (August 2025). PocketCircle is on Better Auth's OAuth **code redirect** to `*.convex.site`, not that library. Adopting the personalized button means GIS on the app origin plus Better Auth **ID token** sign-in (`signIn.social({ idToken })`), which is a different auth shape than today's redirect. [FedCM migration](https://developers.google.com/identity/gsi/web/guides/fedcm-migration), [Better Auth Google ID token](https://better-auth.com/docs/authentication/google)

GIS is the latest *Google-native* convenience. It is not a small patch on the current button.

## Security and privacy

### Do not put last-used email on the server for anonymous visitors

An unauthenticated "last email for this device/IP" API, or a public Convex query, is account enumeration with extra steps. That fights ADR 0015.

If we persist a hint, it belongs on **this origin, this browser**, written only after a real session, never sent to PostHog as a distinct id.

### Masking is for shoulders, not for secrecy

A mask (`j***@gmail.com`) stops a glance at a laptop in a cafe. It does not hide household identity. Domain is often the useful bit (work vs personal Gmail). Over-masking (`***@***.***`) makes the feature pointless.

Store the **full** address if we need `login_hint`. Render a mask. Keep the full value out of the accessibility tree and screenshots of DOM text. XSS on the app origin can read `localStorage`; that is the same class as any client session helper, not a new vault.

Sign-out should **keep** the hint (that is the point). "Use a different account" and Account Deletion on this device should **clear** it. Incognito already does.

### Shared device vs personal device

| Choice | Convenience | Shared-browser risk |
| --- | --- | --- |
| `prompt=select_account` always, no stored email | User always sees Google's list | Low. Google still shows full emails in *its* UI |
| Masked label only, no `login_hint` | Reminds the human, Google still auto-picks | Low extra risk, weak fix |
| `login_hint` that skips the chooser | Fast return | High if the previous Google session is still live |
| Masked "Continue as …" + `login_hint` + obvious "Use a different account" (`select_account`, no hint) | Fast when they mean it | Acceptable if switch is one tap and default is not silent skip |

OWASP's authentication sheet is about usernames, generic failures, and step-up for sensitive actions, not about painting emails on a login card. The relevant PocketCircle rule is still: do not leak whether an email is a User. [OWASP Authentication](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)

This is not "Remember me" (a long-lived session token). Do not copy that cookie design.

## What I would actually ship, in order

Stay on Better Auth's redirect. Do not take GIS/FedCM unless we are ready to change the auth client for web (and later native ID tokens).

**1. Invitation sign-in should pass `loginHint`.**
The page already discloses `preview.invitedEmail`. Acceptance requires that exact **Google Account Email**. Hinting Google is the product; a mask on `/signin` is not. Use the live invited address, not a stale last-used store.

**2. Set Google `prompt: "select_account"` on the Better Auth provider** in `auth.ts` (required for 1.6.16; client cannot pass `prompt`).

**3. Device-local last-used chip on `/signin`.**
Write Google Account Email when `useAppSession()` is `ready`. Mask for display; primary passes client `loginHint` when stored. "Use a different account" omits `loginHint`; successful sign-in overwrites storage with the new email.

If grilling wants maximum convenience on a personal phone, allow skip-chooser `login_hint` only after we have a "Not you" control that is impossible to miss. I would not skip the chooser as the v1 default. Shared tablets and leftover Google sessions are more common than we pretend.

**4. Do not build GIS One Tap for this ticket.**
It solves the same job better when Google is signed in, and not at all when Google is signed out (then last-used + prefill still wins). It also pulls FedCM iframe/CSP rules and a new ID-token verification path on Convex.

## Questions for the grilling session

- Is the reported pain "Google signed me into the wrong account" or "I cannot remember the address"? Ship (2) vs (3) depends on that.
- After sign-out, should `/signin` still name the last User on this browser? That is a household-privacy choice, not a coding one.
- Invite path: hint the invited email even when last-used on the device is a different address? Yes. Invitation matching wins.
- If Google Account Email changed since last visit, stale `login_hint` prefills the old box. Accept "Use a different account", or stop persisting email and persist nothing?
- Keep `/signin` copy Google-branded and legally wrapped (ADR 0014) if the button subtitle becomes an email chip.

## Implications

A masked last-used label without OAuth parameters is decoration. The durable controls are Google's `login_hint` and `prompt=select_account`, Invitation-aware hinting, and refusing to serve last-used email from the backend to a signed-out visitor.
