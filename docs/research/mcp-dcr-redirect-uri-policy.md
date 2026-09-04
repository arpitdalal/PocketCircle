# MCP DCR redirect URI policy

Research date: 2026-09-04. Primary sources: MCP authorization specs, RFC 7591 / RFC 8252 / OAuth 2.1 / OIDC Dynamic Registration, `@cloudflare/workers-oauth-provider` (installed + upstream), first-party client/server docs and library source. Not blog roundups.

## Question / context

PocketCircle MCP Worker DCR (`clientRegistrationCallback` → `evaluateClientRegistrationPolicy`) currently allows any `https:` redirect, loopback `http:` (`localhost`, `127.0.0.1`, `[::1]`), and a **Cursor-only** private-use host `cursor://anysphere.cursor-mcp/…`. Product rejects that hardcode. Goal: a general redirect allowlist / policy that covers Cursor, VS Code, Claude Code, MCP Inspector, and similar native clients without one-off client branding — or a principled configurable allowlist if pure generality is unsafe.

Current policy: `packages/mcp-worker/src/client-registration-policy.ts`. DCR is rate-limited (`MCP_DCR_RATE_LIMITER`, #354); CIMD preferred. Users paste the MCP resource URL into clients (`docs/research/mcp-connections-empty-state-patterns.md`).

## Spec requirements

### MCP authorization

| Spec | Client registration | Redirect MUST / SHOULD |
| --- | --- | --- |
| [2025-06-18 Authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization) | DCR **SHOULD** | Security: redirect URIs **MUST** be `localhost` or HTTPS. Exact match vs pre-registered. |
| [2025-11-25 Authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) | CIMD **SHOULD**; DCR fallback | Same Communication Security rule. CIMD examples use loopback `http://127.0.0.1` / `http://localhost`. |
| [2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization) + [client-registration](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration) + [security-considerations](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/security-considerations) | Priority: pre-reg → **CIMD** → DCR. **DCR deprecated** (MAY for back-compat). | Redirect **MUST** be `localhost` or HTTPS. Native clients **SHOULD** use `application_type: "native"` (omit defaults to `"web"` under OIDC → can reject native redirects). Example CIMD `redirect_uris` are **loopback http only**. |

MCP never requires private-use / custom schemes. Its security text is narrower than RFC 8252’s native-app checklist.

### OAuth / OIDC

| Spec | What servers must accept for redirects |
| --- | --- |
| [RFC 7591 §5](https://www.rfc-editor.org/rfc/rfc7591.html#section-5) | Registered redirects **MUST** be one of: TLS remote (`https:`), local-machine HTTP (e.g. `http://localhost:…`), **or** non-HTTP application-specific URL (e.g. `exampleapp://oauth_redirect`). AS may refuse. |
| [RFC 8252 §7.1](https://www.rfc-editor.org/rfc/rfc8252.html#section-7.1) | Private-use URI schemes: apps **MUST** use reverse-DNS under their control (`com.example.app`). Example shape: `com.example.app:/oauth2redirect/…` (scheme is the reverse domain; typically **no** authority / single slash after scheme). |
| [RFC 8252 §7.3](https://www.rfc-editor.org/rfc/rfc8252.html#section-7.3) | Loopback `http` with IP literals; AS **MUST** allow any port at request time. |
| [RFC 8252 §8.4](https://www.rfc-editor.org/rfc/rfc8252.html#section-8.4) | Schemes without `.` **SHOULD** be rejected. |
| [OAuth 2.1 draft §1.5 / §2.3.1 / §8.4.3](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1) | Protocol URLs **MUST** use `https` except loopback **MAY** use `http`. Exact match except loopback port. Private-use documented; reverse-DNS SHOULD; schemes without `.` SHOULD reject. |
| [OIDC Dynamic Client Registration 1.0](https://openid.net/specs/openid-connect-registration-1_0.html) | `application_type` default `web`. **Web:** `https` only; no `localhost`. **Native:** custom schemes **or** loopback `http`. AS **MUST** verify redirects match type. |

**Cursor vs RFC 8252 shape:** `cursor://anysphere.cursor-mcp/oauth/callback` is **not** the RFC-preferred form. Preferred: reverse-DNS **scheme** like `com.anysphere.cursor-mcp:/oauth/callback`. Cursor uses short scheme `cursor` (no `.` → RFC 8252 SHOULD reject) plus an authority (`://host/path`). Forum reports confirm Cursor also omits `application_type: "native"` on DCR. ([Forum #167608](https://forum.cursor.com/t/cursor-mcp-dcr-still-omits-application-type-and-uses-a-non-rfc-8252-compliant-private-redirect-uri-3-14-27/167608))

**Tension:** MCP’s “localhost or HTTPS” MUST conflicts with RFC 7591 / RFC 8252 / OIDC native custom schemes. An MCP AS that only allows `https` + loopback still satisfies MCP security and OAuth 2.1 §1.5, and covers every major desktop MCP client’s **preferred** callback. Custom schemes are optional interop.

`@cloudflare/workers-oauth-provider` does not implement `application_type` (no matches in installed `0.10.3`).

## What popular MCP servers / libraries actually do

| Product / library | Policy | Source |
| --- | --- | --- |
| **`@cloudflare/workers-oauth-provider` 0.10.3** | `validateRedirectUriScheme` denylists only `javascript:`, `data:`, `vbscript:`, `file:`, `mailto:`, `blob:` (+ control chars). **Does not** require https/loopback. Custom schemes and non-loopback `http:` pass. Auth-time: exact match + RFC 8252 loopback port flex. App policy via `clientRegistrationCallback`. | Installed `dist/oauth-provider.js`; upstream [`oauth-client-metadata.ts`](https://github.com/cloudflare/workers-oauth-provider/blob/main/src/oauth-client-metadata.ts) |
| **PocketCircle today** | https ∨ loopback http ∨ hardcoded `cursor://anysphere.cursor-mcp/…`. Cap 20 URIs. | `packages/mcp-worker/src/client-registration-policy.ts` |
| **Laravel MCP** | Default: standard URL validation (http/https). Opt-in `custom_schemes` / `allowed_custom_schemes` (empty by default; e.g. `cursor`, `vscode`, `claude`). Empty = “strict MCP spec compliance.” | [`config/mcp.php`](https://github.com/laravel/mcp/blob/main/config/mcp.php); [PR #181](https://github.com/laravel/mcp/pull/181) |
| **http_mcp** (`yeison-liscano`) | https + loopback http by default. Opt-in `allowed_custom_redirect_schemes`. Hard `DISALLOWED_REDIRECT_SCHEMES` (javascript/data/file/intent/view-source/…) **cannot** be bypassed via allowlist. | [PR #85](https://github.com/yeison-liscano/http_mcp/pull/85); [commit a423ddb](https://github.com/yeison-liscano/http_mcp/commit/a423ddba6a45d4646ebba3d77542270c19971153) |
| **wille/mcp-oauth-server** | https + loopback http. **Any** non-`http` scheme always allowed (treats as private-use). Explicitly: scheme shape not used — real clients use `vscode://` / `cursor://`. Dangerous schemes blocked earlier by `SafeUrlSchema`. | [`src/redirect-uri.ts`](https://raw.githubusercontent.com/wille/mcp-oauth-server/master/src/redirect-uri.ts); [commit f0e1200](https://github.com/wille/mcp-oauth-server/commit/f0e12004612764c2e85f92e9089b1c4273be3275); [README](https://github.com/wille/mcp-oauth-server/) |
| **OutSystems MCP** | Loopback-http-only DCR → rejects `cursor://…` (“must use scheme http for loopback”). Issue asks for private-use or allowlist. | [outsystems-mcp#16](https://github.com/OutSystems/outsystems-mcp/issues/16) |
| **fastmail-mcp-remote PR #21** | Attempted “allow any non-http/https as custom scheme.” Review warned: that is equivalent to allowing everything except cleartext non-loopback http — `javascript:` / `file:` / `data:` pass. RFC 8252 means private-use schemes, not arbitrary non-http. | [PR #21 review](https://github.com/omarshahine/fastmail-mcp-remote/pull/21) |
| **Fastmail (as OAuth AS)** | Registered redirects: claimed https, reverse-DNS private-use (scheme **MUST** contain `.`), or `http://localhost/` (port/`127.0.0.1`/`::1` flexible). Would reject `cursor://`. | [fastmail.com/for-developers/oauth](https://www.fastmail.com/for-developers/oauth/) |
| **Linear / Stripe MCP** | Use OAuth + (Linear) DCR; no published redirect-scheme allowlist. Stripe authorize URLs use client loopback (e.g. VS Code `127.0.0.1:33418`). | [linear.app/docs/mcp](https://linear.app/docs/mcp); [docs.stripe.com/mcp](https://docs.stripe.com/mcp); [stripe/ai#288](https://github.com/stripe/ai/issues/288) |
| **HubSpot MCP Auth Apps** | http(s) only; rejects `cursor://`. | [Cursor forum #167935](https://forum.cursor.com/t/mcp-oauth-still-uses-cursor-redirect-hubspot-and-other-http-s-only-providers-cannot-connect/167935) |
| **Auth0 MCP guidance** | Prefer CIMD over open DCR for prod. | [Auth0 MCP DCR](https://auth0.com/ai/docs/mcp/guides/registering-your-mcp-client-application/dynamic-client-registration) |

Industry split: **opt-in scheme allowlist** (Laravel, http_mcp) vs **always allow non-http** (wille) vs **https+loopback only** (OutSystems today, HubSpot, MCP MUST text). Nobody credible hardcodes only Cursor in published config — they either stay strict or expose a general allowlist. Blind “any non-http” is explicitly warned against (fastmail-mcp-remote review).

## Client redirect patterns observed

| Client | Redirect pattern | Notes | Source |
| --- | --- | --- | --- |
| **Cursor** | Preferred: `http://localhost:8787/callback`. Fallback: `cursor://anysphere.cursor-mcp/oauth/callback`. Cloud: `https://www.cursor.com/agents/mcp/oauth/callback`. | Staff: moved to loopback because many providers reject `cursor://`; still falls back (port 8787 busy / cloud). Non-RFC-8252 scheme shape; often omits `application_type`. | [Forum #165019](https://forum.cursor.com/t/oauth-redirect-uri-changed-from-cursor-to-http-localhost-for-streamable-http-mcp/165019), [#165752](https://forum.cursor.com/t/mcp-oauth-callback-changed-to-http-localhost-8787-callback-and-authentication-still-fails/165752), [#167935](https://forum.cursor.com/t/mcp-oauth-still-uses-cursor-redirect-hubspot-and-other-http-s-only-providers-cannot-connect/167935), [#167608](https://forum.cursor.com/t/cursor-mcp-dcr-still-omits-application-type-and-uses-a-non-rfc-8252-compliant-private-redirect-uri-3-14-27/167608) |
| **VS Code** | `http://127.0.0.1:33418`, `https://vscode.dev/redirect` (+ insiders / ephemeral port). | [MCP developer guide](https://code.visualstudio.com/api/extension-guides/ai/mcp); [vscode#278512](https://github.com/microsoft/vscode/issues/278512) |
| **Claude Code** | `http://localhost:PORT/callback` (random or `--callback-port`). Paste callback URL when loopback unreachable. | [code.claude.com/docs/en/mcp](https://code.claude.com/docs/en/mcp) |
| **MCP Inspector** | Origin + `/oauth/callback` and `/oauth/callback/debug`. | [inspector#930](https://github.com/modelcontextprotocol/inspector/issues/930) |
| **CIMD example (MCP)** | `http://127.0.0.1:3000/callback`, `http://localhost:3000/callback` | [2026-07-28 client-registration](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration) |

**Paste-URL note:** PocketCircle paste is the **MCP resource** (`…/mcp`), not the OAuth redirect.

## Options for PocketCircle

Most general → most restrictive. Library dangerous-scheme denylist stays underneath. Policy in `clientRegistrationCallback` before KV write.

### A. HTTPS + loopback only

- **Rule:** `https:` any host; `http:` only for `localhost` / `127.0.0.1` / `[::1]` (optionally `127.0.0.0/8` to match workers-oauth-provider). Reject all other schemes. Cap 20 URIs. Library handles loopback port match at authorize time.
- **Pros:** Matches MCP Communication Security MUST + OAuth 2.1 §1.5. Covers Cursor preferred loopback, Claude, VS Code loopback, Inspector, Stripe flows. No client branding. Best Free KV / open-DCR posture.
- **Cons:** Breaks Cursor installs that still send only `cursor://` (port conflict / cloud fallback). Same class of failure as OutSystems #16 / HubSpot.
- **Config:** None.
- **Fit:** **Default for prod.** Document: free port 8787; Cursor cloud https already allowed via `https:`.

### B. HTTPS + loopback + RFC 8252-shaped private-use schemes

- **Rule:** A, plus schemes matching reverse-DNS (contain `.`, not dangerous). Optionally require `application_type: "native"` when custom scheme present. Prefer authority-free `scheme:/path` shape if validating strictly.
- **Pros:** Principled; aligns RFC 8252 / Fastmail AS rules / OAuth 2.1 SHOULD.
- **Cons:** **Still rejects `cursor://`** (scheme has no `.`). Does not fix the Cursor fallback PocketCircle cares about. Few MCP clients use reverse-DNS schemes today.
- **Config:** Optional `application_type` gate.
- **Fit:** Spec-pure; weak interop for current IDEs.

### C. HTTPS + loopback + configurable scheme allowlist (env / Wrangler)

- **Rule:** A as base. Plus schemes listed in config (e.g. `cursor`, `vscode`). Hard denylist of dangerous schemes never overridable (http_mcp pattern). Laravel’s empty-by-default model.
- **Pros:** No Cursor hardcode in source. Ops add `cursor` when needed. Empty = MCP-strict. Matches Laravel + http_mcp industry pattern.
- **Cons:** Must maintain list; short schemes remain spoofable (RFC 8252 acknowledges this).
- **Config:** `MCP_DCR_EXTRA_REDIRECT_SCHEMES=cursor` (comma-separated). Wrangler var preferred.
- **Fit:** Prod escape hatch when Cursor fallback still appears.

### D. HTTPS + loopback + configurable exact URI / host / prefix allowlist

- **Rule:** A as base. Plus exact URIs or prefixes (e.g. `cursor://anysphere.cursor-mcp/`).
- **Pros:** Tighter than whole-scheme allow. Still configurable, not source hardcode.
- **Cons:** More brittle when Cursor path variants appear (`/oauth/callback` vs `/oauth/app/…/callback`).
- **Config:** `MCP_DCR_EXTRA_REDIRECT_URI_PREFIXES=cursor://anysphere.cursor-mcp/`
- **Fit:** If scheme-wide `cursor` feels too wide; combine with C.

### E. Cursor-hardcode — **reject**

- **Rule:** Special-case `cursor://anysphere.cursor-mcp/…` in application code (current state).
- **Pros:** Unblocks known Cursor fallback with one if.
- **Cons:** Product rejected. Does not scale (VS Code, Claude desktop schemes, future IDEs). Encodes Anysphere into PocketCircle policy. Same problem repeats per client.
- **Config:** Code constant.
- **Fit:** **Do not ship.** Prefer C/D if interop needed.

### Related (not A–E primary)

- **Library-default only** (dangerous denylist, no https/loopback): too open for Free DCR (`http://evil.example`). Not prod.
- **wille-style always-allow non-http:** covers Cursor without config; same class of mistake the fastmail-mcp-remote review called out unless paired with a strong dangerous denylist — still allows arbitrary app schemes. Prefer explicit allowlist (C).
- **Disable open DCR:** CIMD/admin only. Best KV hygiene long-term; premature while Cursor still needs DCR (#354).

## Recommendation

1. **Ship A as default** (https + loopback only). Drop E from application code. Matches MCP MUST, CIMD examples, Cursor’s *preferred* loopback, and Free KV caution.
2. **Add C (and optionally D) as empty Wrangler allowlist** — same pattern as Laravel `custom_schemes` / http_mcp `allowed_custom_redirect_schemes`. If beta hits Cursor `cursor://` rejection, set `MCP_DCR_EXTRA_REDIRECT_SCHEMES=cursor` without baking Anysphere into the module.
3. **Reject E.** Reject B as the sole interop story (looks principled, still fails Cursor). Reject blind “any non-http” (fastmail-mcp-remote review; prefer hard denylist + opt-in allowlist).

Keep CIMD preferred, DCR rate-limited, consent UI showing full redirect URI.

## Sources

- MCP 2025-06-18 / 2025-11-25 / 2026-07-28 Authorization + client-registration + security-considerations — https://modelcontextprotocol.io/specification/
- RFC 7591 — https://www.rfc-editor.org/rfc/rfc7591.html
- RFC 8252 — https://www.rfc-editor.org/rfc/rfc8252.html
- OAuth 2.1 draft — https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1
- OIDC Dynamic Client Registration 1.0 — https://openid.net/specs/openid-connect-registration-1_0.html
- Cloudflare workers-oauth-provider — https://github.com/cloudflare/workers-oauth-provider ; installed `@cloudflare/workers-oauth-provider@0.10.3`
- PocketCircle — `packages/mcp-worker/src/client-registration-policy.ts`, `docs/research/mcp-capacity-gates.md`, `docs/research/hosted-mcp-server.md`
- Laravel MCP config + PR #181 — https://github.com/laravel/mcp/blob/main/config/mcp.php ; https://github.com/laravel/mcp/pull/181
- http_mcp PR #85 — https://github.com/yeison-liscano/http_mcp/pull/85
- wille/mcp-oauth-server redirect-uri.ts — https://github.com/wille/mcp-oauth-server
- OutSystems MCP #16 — https://github.com/OutSystems/outsystems-mcp/issues/16
- fastmail-mcp-remote PR #21 review — https://github.com/omarshahine/fastmail-mcp-remote/pull/21
- Fastmail OAuth redirect rules — https://www.fastmail.com/for-developers/oauth/
- Linear / Stripe / Auth0 / VS Code / Claude Code / Cursor forum / Inspector — URLs in tables above
