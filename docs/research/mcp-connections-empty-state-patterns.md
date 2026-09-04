# MCP Connections empty-state patterns

Research date: 2026-09-03. Sources are PocketCircle repo code/docs plus first-party MCP publisher docs, Anthropic/Claude connector help, Cursor MCP docs, Cloudflare Agents MCP guides, and comparable OAuth/webhook product help. No implementation.

## Verdict

PocketCircle Connections is a **post-consent ledger**. Empty state tells Users connections appear after approval and never shows the MCP resource URL or client setup steps. Comparable hosted MCP products split two jobs: (1) **publisher setup** — copyable/canonical server URL + client-specific steps in docs or a connect panel; (2) **session ledger** — list + revoke after OAuth. PocketCircle already owns (2); empty-state gap is (1).

Users must paste **`{VITE_MCP_WORKER_ORIGIN origin}/mcp`** into an MCP client (Claude custom connector, Cursor `mcp.json`, etc.). Bare origin is the auth server / discovery host, not the Streamable HTTP resource clients should configure.

## 1. PocketCircle status

### What the UI shows today

| Surface | Shows MCP URL? | What it does |
| --- | --- | --- |
| Connections empty | No | “No connected clients” + “When you approve an MCP client, its access appears here…” [`connections.tsx` EmptyConnections](../../apps/web-app/app/routes/connections.tsx) |
| Connections with rows | No | Client name/id, scopes, Circles, revoke / retry cleanup |
| `/mcp/authorize` | No | Consent after **client-initiated** OAuth; Worker origin used for handoff fetch + complete/deny posts [`mcp-authorize.tsx`](../../apps/web-app/app/routes/mcp-authorize.tsx) |
| Account menu | Link only | “Connections” nav [`account-menu.tsx`](../../apps/web-app/app/components/account-menu.tsx) |
| What's New / Feature Announcements | No MCP entry | Catalog is Duplicate-only [`feature-announcements.ts`](../../apps/web-app/app/lib/feature-announcements.ts); `CHANGELOG.md` has no MCP section yet |
| Settings | N/A | No MCP URL surface found |

`mcpWorkerOrigin()` reads `VITE_MCP_WORKER_ORIGIN`, returns HTTPS origin (or local HTTP in DEV). Used for revoke cleanup and consent Worker calls — **not** rendered as a user-facing copy field. [`env.ts`](../../apps/web-app/app/lib/env.ts)

Grep across web-app routes/components: no user-facing copy of `{origin}/mcp`, “MCP server URL”, or clipboard helpers for MCP. Tests stub `https://mcp.pocketcircle.app` for Worker fetches only.

### URL Users actually need

Deploy verifies protected-resource metadata as:

- **Resource (paste into clients):** `{origin}/mcp`
- **Authorization server (origin):** `{origin}` — `authorization_endpoint` `{origin}/authorize`, `token_endpoint` `{origin}/token`

[`.github/workflows/deploy.yml` “Verify MCP Worker discovery”](../../.github/workflows/deploy.yml), [hosted MCP research](./hosted-mcp-server.md), Worker tests (`resource: …/mcp`).

Consent SPA path is **`https://pocketcircle.app/mcp/authorize`** (app origin), reached only after the MCP client hits the Worker and gets redirected — Users do not start there with a blank URL.

### Production origin risk

`packages/mcp-worker/wrangler.jsonc`: `workers_dev: true`; comment says custom domain disabled until #318 verified end-to-end. Target brand URL in research/tests is `https://mcp.pocketcircle.app`; live `VITE_MCP_WORKER_ORIGIN` may still be `https://pocketcircle-mcp-worker.<account>.workers.dev`. UI must show **whatever origin deploy baked in**, not a hard-coded custom domain.

## 2. Pattern catalog

### A. MCP publishers (docs → client paste → OAuth → dashboard revoke)

Shared shape across Stripe, Notion, Linear, GitHub:

1. Publish one canonical HTTPS MCP URL.
2. Per-client install: one-click deep link **or** JSON/CLI snippet with that URL (no API secret for OAuth path).
3. Client opens browser OAuth; User consents on publisher domain.
4. Dashboard “OAuth sessions / Connections” lists clients for revoke — setup lives in docs or a connect panel, not only the empty ledger.

| Product | URL shown to Users | How presented | Setup steps | Session / revoke | Source |
| --- | --- | --- | --- | --- | --- |
| **Stripe** | `https://mcp.stripe.com` (no `/mcp` path) | Docs: Install in Cursor / VS Code buttons; JSON `url`; Claude `claude mcp add --transport http …`; “Other” = use this URL | Add server → authenticate OAuth (or restricted key header fallback) | Dashboard **OAuth sessions** → Revoke access | [docs.stripe.com/mcp](https://docs.stripe.com/mcp) |
| **Notion** | `https://mcp.notion.com/mcp` (+ SSE fallback `/sse`) | Per-client pages: Codex toml, Claude CLI, Cursor `mcp.json`, VS Code, Devin “paste server URL”, Antigravity `serverUrl` | Add URL → enable/Connect → OAuth; FAQ: interactive OAuth required | Workspace **Settings → Connections**; org Admin API revoke | [Connect to Notion MCP](https://developers.notion.com/guides/mcp/get-started-with-mcp), [MCP security](https://developers.notion.com/guides/mcp/mcp-security-best-practices) |
| **Linear** | `https://mcp.linear.app/mcp` (readonly variant `/mcp/readonly`) | Docs “General” leads with address; Claude directory connector (no paste) vs Cursor one-click / `mcp-remote` bridge | Add → `/mcp` or Connect → OAuth 2.1 DCR; API key header alternative in FAQ | Auth session in client; Linear Security & Access for API keys | [linear.app/docs/mcp](https://linear.app/docs/mcp), [Cursor integration](https://linear.app/integrations/cursor-mcp) |
| **GitHub** | `https://api.githubcopilot.com/mcp/` (+ `/readonly`, toolset paths) | README + remote-server.md: VS Code Install badges, JSON `type: http` + `url`; PAT via headers/`inputs` password prompt | OAuth preferred; PAT optional | Host obtains GitHub tokens; honor `WWW-Authenticate` discovery | [github-mcp-server](https://github.com/github/github-mcp-server), [remote-server.md](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md) |
| **Cloudflare (publisher guide)** | `https://<worker>.workers.dev/mcp` | Deploy guide: print endpoint; MCP Inspector “enter URL → Connect”; Claude Desktop `mcp-remote` args with full `/mcp` URL | Local/prod URL into inspector or client config; OAuth templates add GitHub login | N/A (builder-focused) | [Remote MCP server](https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/) |

**URL path convention:** Notion, Linear, GitHub, Cloudflare templates, Claude’s example `https://mcp.example.com/mcp` all use an **`/mcp` resource path**. Stripe is the notable bare-host exception. PocketCircle matches the `/mcp` majority.

### B. MCP *clients* (where Users paste PocketCircle’s URL)

| Client | Empty / add UX | What User pastes | Auth after paste | Source |
| --- | --- | --- | --- | --- |
| **Claude (custom connector)** | Customize → Connectors → Add custom connector; Team/Enterprise: Owner adds URL first, members Connect | **Remote MCP server URL** (ex. `https://mcp.example.com/mcp`); optional OAuth client id/secret Advanced | OAuth when server requires; Claude probes URL and marks auth “Detected” | [claude.com custom remote MCP](https://claude.com/docs/connectors/custom/remote-mcp), [Help Center](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp) |
| **Cursor** | Customize → MCPs / `mcp.json`; Marketplace one-click; remote `url` (+ optional `headers` / static `auth`) | Remote HTTP/SSE URL | OAuth when server requires; tool approval defaults on | [cursor.com/docs/context/mcp](https://cursor.com/docs/context/mcp), [Help MCP](https://cursor.com/help/customization/mcp) |
| **Claude Code / Codex** | CLI `mcp add` + `/mcp` or `mcp login` | Same HTTPS resource URL | Browser OAuth | Notion/Stripe/Linear client sections above |

Implication: PocketCircle empty state should **speak client language** (“paste this URL into your assistant”) — setup starts in Cursor/Claude, consent lands back on PocketCircle.

### C. Non-MCP “copy a URL then finish elsewhere” (closest empty-state UX)

| Product | Pattern | Relevance |
| --- | --- | --- |
| **Zapier Catch Hook** | Empty/setup step shows unique webhook URL + **Copy**; User pastes into external app; then test | Strong analog: publisher shows copyable endpoint before anything arrives. [Zapier Catch Hook help](https://help.zapier.com/hc/en-us/articles/8496288690317-Trigger-Zap-workflows-from-webhooks) |
| **GitHub Apps / Smee** | Dev webhook proxy URL copy → paste into App settings | Copyable URL as first setup artifact. [GitHub Apps webhooks](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/using-webhooks-with-github-apps) |
| **Slack incoming webhooks** | OAuth install yields webhook URL in API response / app config (secret-ish) | Opposite security model: URL **is** credential. Do **not** copy this for MCP resource URLs. [Slack incoming webhooks](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks) |

### D. Ledger-only empty states (manage after connect)

| Product | Empty / list role | Source |
| --- | --- | --- |
| **Google linked apps** | Review/remove existing links; no “here’s how to connect app X” URL on that page | [Google Account Help](https://support.google.com/accounts/answer/13533235) |
| **Stripe OAuth sessions** | Post-connect revoke UI; setup is docs | [docs.stripe.com/mcp](https://docs.stripe.com/mcp) Manage sessions |
| **PocketCircle Connections (today)** | Same family: ledger empty copy only | [`connections.tsx`](../../apps/web-app/app/routes/connections.tsx) |

Ledger-only works when discovery is directory/marketplace. PocketCircle is **custom URL** until listed in Claude/Cursor directories → empty ledger alone is insufficient.

### E. Accessibility / security notes from primary sources

- **Public discovery URL ≠ secret.** MCP resource URL is meant to be configured in clients. Secrets are OAuth tokens or (fallback) API keys in headers — never paste refresh tokens / Worker HMAC / approval tokens into UI copy fields. Claude stores request-header secrets and does not show them again after save. [Claude remote MCP](https://claude.com/docs/connectors/custom/remote-mcp)
- **Prefer OAuth over long-lived keys** when the client supports it (Stripe, Notion, Linear, GitHub). PocketCircle is OAuth-only for end Users — good fit; do not invent a pasteable API key for v1.
- **Consent hygiene:** Anthropic/Notion warn: review scopes, only trust known servers, confirm destructive tools, revoke unused connectors. PocketCircle already surfaces client label (not proof), scopes, Circles, refresh duration on consent.
- **Revoke messaging:** Stripe separates OAuth revoke from API keys; Notion Admin can revoke member MCP connections. PocketCircle Connections already: revoke Convex first, Worker cleanup may pending — keep that clarity on empty-state “manage later” copy.
- **Network:** Claude remote connectors call MCP **from Anthropic IPs**, not the User’s laptop — public Worker required (workers.dev or custom domain). [Claude custom connector network](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)
- **a11y:** Copy control needs a real button name (“Copy MCP server URL”), success via polite live region / snackbar (PocketCircle already has snackbar on revoke). Prefer selectable `readonly` text field + Copy over icon-only. Don’t put secrets in `aria` labels.

## 3. Recommended options for PocketCircle

### Option 1 — Connections “Connect an assistant” setup panel (recommended default)

Always show a setup card **above** the ledger (or as the empty-state body): copyable `{origin}/mcp`, 3–5 steps, short client tips (Claude / Cursor), note that approved clients appear below.

| Pros | Cons |
| --- | --- |
| Matches Zapier “URL first” + Stripe/Notion “URL is the product”; fixes empty-state gap at the natural Settings surface | Page does two jobs (setup + ledger); need clear visual hierarchy |
| Uses existing `mcpWorkerOrigin()`; no new backend | If origin unset, must show config error (same as consent) |
| Works with Feature Announcement CTA → `/connections` | Client UIs change; keep steps high-level + “see client docs” |

### Option 2 — Empty-only setup; collapse to link when connected

Full setup panel only when `connections.length === 0`; non-empty shows “Add another assistant” disclosure or docs link.

| Pros | Cons |
| --- | --- |
| Quieter once Users are connected | Users with one client who want a second lose the URL unless they revoke all |
| Smaller change to filled layout | Power Users still need URL for a second client (Cursor + Claude) |

Prefer Option 1’s always-visible compact URL row if multi-client is expected.

### Option 3 — Docs / What’s New primary; Connections stays ledger

Ship public help (or What’s New body) with URL + steps; empty state only links “How to connect”.

| Pros | Cons |
| --- | --- |
| Matches Stripe/Linear docs-heavy publishers | Extra hop; mobile Users bounce; URL not next to revoke UI |
| Minimal Connections UI change | Feature Announcement can deep-link docs, but in-app copy is still better for OAuth products Users already signed into |

Use as **supplement**, not sole surface.

### Option 4 — Client deep links / “Install in Cursor” when available

Stripe/Linear/GitHub ship marketplace or `cursor://` / VS Code install URLs.

| Pros | Cons |
| --- | --- |
| Lowest friction for listed clients | PocketCircle not in directories yet; deep-link formats vary; workers.dev branding weaker |
| Good later layer on Option 1 | Don’t block v1 on marketplace approval |

### Option 5 — Feature Announcement CTA → Connections setup

When MCP launches: announcement “Connect an AI assistant” CTA → `/connections` (Option 1 panel). Catalog pattern already exists for Duplicate.

| Pros | Cons |
| --- | --- |
| Discovers capability for pre-cutoff Users | Announcement eligibility rules (#282) — new Users may never see it; Connections must still self-serve |
| Doesn’t replace in-page URL | Needs released changelog + catalog entry |

**Stack for launch:** Option 1 + Option 5 + thin Option 3 help link. Option 4 later.

## 4. Recommended copy outline

Grounded in PocketCircle OAuth: client → `{origin}/mcp` → Worker authorize → SPA `/mcp/authorize` → Circles/scopes → client continues with tokens → row on Connections.

### URL to show

- **Primary (copy):** `{mcpWorkerOrigin()}/mcp`  
  Example target: `https://mcp.pocketcircle.app/mcp` (or current workers.dev equivalent).
- **Do not lead with:** bare origin, `/authorize`, `/mcp/authorize`, Convex site URL, or any token.
- **If `mcpWorkerOrigin()` undefined:** same hard fail as consent — “MCP is not configured” — don’t invent a URL.

### Empty / setup panel structure

1. **Eyebrow / title:** Connect an AI assistant  
2. **One line why:** Let Claude, Cursor, or other MCP clients read and record spending in Circles you choose.  
3. **Field label:** MCP server URL  
4. **Value + Copy** (mono, break-all): `{origin}/mcp`  
5. **Helper:** This address is public. Access starts only after you approve the client and selected Circles.  
6. **Steps (numbered):**  
   1. Open your AI client’s MCP / Connectors settings.  
   2. Add a remote MCP server and paste the URL above (Claude: Add custom connector; Cursor: Tools & MCP / `mcp.json` `url`).  
   3. When the browser opens PocketCircle, sign in with Google if needed.  
   4. Review the client, choose Circles and scopes, Allow.  
   5. Return here — the connection appears under Connected clients; Revoke anytime.  
7. **Secondary:** Link “Client-specific tips” (Claude / Cursor / Claude Code one-liners) or external help.  
8. **Security line:** Never paste API keys or tokens into chat to “connect.” PocketCircle uses sign-in + approval only.

### Announcement CTA sketch

- Title: Connect PocketCircle to your AI assistant  
- Body: Paste the MCP server URL from Connections, approve Circles, then ask your assistant about shared spending.  
- CTA: Open Connections → `/connections`

### JSON snippet (optional, advanced disclosure)

```json
{
  "mcpServers": {
    "pocketcircle": {
      "url": "https://mcp.pocketcircle.app/mcp"
    }
  }
}
```

Interpolate real origin. Prefer Cursor-shaped `mcpServers` + note Claude uses Connectors UI / `claude mcp add --transport http pocketcircle <url>`.

## 5. Open questions / risks

1. **Canonical host:** Until custom domain is enabled, shipping `workers.dev` in copy is correct but uglier; switching origin later invalidates saved client configs — plan a redirect or dual-origin window, or wait for `mcp.pocketcircle.app` before loud announcement.
2. **`VITE_MCP_WORKER_ORIGIN` drift:** SPA and Worker discovery must stay identical (deploy already verifies). Copy URL must come from the same helper as revoke/consent.
3. **Which clients to name in v1 UI:** Claude custom connector + Cursor cover most “paste URL” paths; Linear-style directory listing is N/A until submitted.
4. **Stripe-style bare URL vs `/mcp`:** Stick to `/mcp`; don’t drop the path to look like Stripe — discovery and token audience are path-specific.
5. **SSE fallback:** Notion documents `/sse`; PocketCircle Streamable HTTP at `/mcp` only — don’t advertise SSE unless shipped.
6. **QR codes:** Rare in MCP first-party docs; skip unless mobile Claude install becomes primary.
7. **Empty ledger vs pending grants:** If a User abandons consent, empty state still correct; avoid implying a half-created connection.
8. **Secrets confusion:** Slack-style “URL is the secret” mental model — helper text must say the MCP URL is not a password.
9. **Anthropic IP allowlists:** If any User puts Worker behind Access/WAF, Claude remote connectors break; document public reachability.
10. **Announcement vs Settings routes:** Current Feature Announcement allowlist excludes Settings/Connections — CTA navigation is fine; card itself may not render on `/connections` (see #282 catalog rules).

## Source index

- PocketCircle: [`connections.tsx`](../../apps/web-app/app/routes/connections.tsx), [`env.ts`](../../apps/web-app/app/lib/env.ts), [`mcp-authorize.tsx`](../../apps/web-app/app/routes/mcp-authorize.tsx), [`wrangler.jsonc`](../../packages/mcp-worker/wrangler.jsonc), [deploy discovery check](../../.github/workflows/deploy.yml), [hosted-mcp-server.md](./hosted-mcp-server.md)
- [Stripe MCP](https://docs.stripe.com/mcp)
- [Notion MCP get started](https://developers.notion.com/guides/mcp/get-started-with-mcp) / [security](https://developers.notion.com/guides/mcp/mcp-security-best-practices)
- [Linear MCP](https://linear.app/docs/mcp)
- [GitHub MCP server](https://github.com/github/github-mcp-server)
- [Cloudflare remote MCP guide](https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/)
- [Claude custom remote MCP](https://claude.com/docs/connectors/custom/remote-mcp) / [Help Center](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)
- [Cursor MCP docs](https://cursor.com/docs/context/mcp)
- [Zapier Catch Hook](https://help.zapier.com/hc/en-us/articles/8496288690317-Trigger-Zap-workflows-from-webhooks)
- [Google linked apps](https://support.google.com/accounts/answer/13533235)
