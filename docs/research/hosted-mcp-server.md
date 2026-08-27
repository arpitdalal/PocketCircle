# Hosted MCP server for PocketCircle

Research date: 2026-08-27. Sources are the PocketCircle repository and primary MCP, Cloudflare, Better Auth, Google, and Convex documentation.

## Recommendation

Yes. PocketCircle can expose most useful product operations over hosted MCP.

Build a dedicated Cloudflare Worker at `https://mcp.pocketcircle.app`, using `@cloudflare/workers-oauth-provider`, Cloudflare Agents' stateless `createMcpHandler`, and the current MCP TypeScript SDK v2. Keep Google and Better Auth as the web login. The Worker becomes PocketCircle's MCP authorization server and issues its own MCP tokens after the signed-in User approves access in the PocketCircle SPA. Pin the mutually compatible `agents`, `@modelcontextprotocol/server`, and OAuth provider versions. Cloudflare warns that each Agents release expects specific MCP package versions. [Cloudflare handler API](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/)

Do not add `@better-auth/mcp` to the current Convex auth component. PocketCircle uses Better Auth `1.6.16` and `@convex-dev/better-auth` `0.12.5`; that integration declares Better Auth `>=1.6.11 <1.7.0`. The current Better Auth MCP package targets Better Auth 1.7. MCP/OAuth Provider is not on the Convex integration's supported plugin list. Convex does not call every unlisted plugin incompatible, but schema-changing plugins require a local component install and generated schema. An open report against the same Convex integration line says adding the OAuth Provider plugin breaks `/api/auth/convex/token`. The report is not a confirmed universal incompatibility, but the current matrix is a poor production base. [PocketCircle dependencies](../../packages/convex/package.json), [lockfile](../../pnpm-lock.yaml), [Convex Better Auth 0.12 guide](https://labs.convex.dev/better-auth/migrations/migrate-to-0-12), [supported Convex plugins](https://labs.convex.dev/better-auth/supported-plugins), [Convex local install](https://labs.convex.dev/better-auth/features/local-install), [Better Auth 1.7 MCP migration](https://better-auth.com/docs/guides/1-7-upgrade-guide), [get-convex/better-auth issue 395](https://github.com/get-convex/better-auth/issues/395)

This is the target split:

| Boundary | Responsibility |
| --- | --- |
| Existing PocketCircle SPA | Google sign-in, onboarding, consent, Circle selection, Connections UI |
| Existing Better Auth in Convex | Browser session and stable Better Auth User to PocketCircle User mapping |
| New MCP Worker | MCP transport, OAuth discovery, client registration, authorization codes, MCP access and refresh tokens, protocol schemas |
| New narrow Convex bridge | Worker authentication, live MCP grant enforcement, existing Circle permissions, and domain reads and writes |

The current asset-only Worker can stay separate. A dedicated Worker gives the MCP protocol, OAuth KV, secrets, rate limits, logs, and deploy cadence an isolated boundary. [Current Worker config](../../wrangler.jsonc), [deployment ADR](../adr/0007-vercel-and-convex-cloud-deployment.md), [Cloudflare remote MCP guide](https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/)

## What PocketCircle already has

The data and authorization model are ready to support another trusted entry point:

- Better Auth is mounted at `*.convex.site/api/auth/*` and Google is the production sign-in provider. Its `convex` plugin creates a separate web-client JWT with audience `convex`. [Auth setup](../../packages/convex/convex/auth.ts), [auth config](../../packages/convex/convex/auth.config.ts), [HTTP routes](../../packages/convex/convex/http.ts)
- Better Auth owns its User and Session rows. PocketCircle owns a separate `users` row; the Better Auth User stores the stable mapping to it. [Schema](../../packages/convex/convex/schema.ts)
- Convex guards enforce active membership, owner-only actions, entity ownership, archived state, setup state, and missing-equals-inaccessible behavior. `resolveCircleAccessForUser` already supports a trusted, explicit User instead of reading browser auth. [Access guards](../../packages/convex/convex/guard.ts), [security ADR](../adr/0015-server-side-permissions-and-security-baseline.md)
- Existing functions cover Users, Circles, Transactions, Categories, Members, Invitations, histories, dashboards, reports, export, and notifications. They are a capability inventory, not the MCP wire contract.

The current public Convex functions cannot simply receive an MCP token. `safeGetAuthUser` resolves the browser identity through a live Better Auth Session ID. MCP authorization is a separate grant that may outlive that browser session. The bridge must load the PocketCircle User from a verified, live MCP grant and call shared domain operations with that explicit User.

## Authentication and authorization flow

Google login and MCP OAuth solve different problems:

1. Google authenticates the human to PocketCircle.
2. PocketCircle records which MCP client the User approved, for which scopes and Circles.
3. The MCP Worker issues and verifies its own resource-bound tokens.
4. Convex enforces that stored grant and the User's current app permissions on every call.

Never give an MCP client a Google token, Better Auth cookie, Better Auth token, or Convex web JWT. Never forward the Worker's MCP token to Convex. MCP forbids token passthrough to a different resource, and the existing Convex token has the wrong audience and session semantics. [MCP token handling](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization#token-handling), [Cloudflare OAuth architecture](https://developers.cloudflare.com/agents/model-context-protocol/protocol/authorization/), [Google OIDC](https://developers.google.com/identity/openid-connect/openid-connect)

### Browser handoff

Use this flow:

1. An MCP client reaches `/mcp` without a token. The Worker returns `401` with RFC 9728 discovery information.
2. The client starts authorization code with PKCE at the Worker, including `resource=https://mcp.pocketcircle.app/mcp`.
3. `@cloudflare/workers-oauth-provider` validates the OAuth request with `parseAuthRequest()`. The Worker stores that exact parsed `AuthRequest` server-side. It creates a short-lived, Worker-signed approval envelope and redirects the browser to the protected SPA route `/mcp/authorize?handoff=...`.
4. The SPA uses the existing Better Auth session. If absent, the normal Google flow runs. The User must finish normal PocketCircle onboarding before granting access.
5. The page shows the client ID, redirect URI, requested scopes, and the User's Circles. It may show `client_name` and logo as client-provided labels, not proof of identity. The User explicitly selects Circles and allows or denies.
6. An authenticated Convex mutation verifies the Worker's signed approval envelope. It creates a pending `mcpGrant` and a short-lived, signed, single-use application approval token bound to the handoff, OAuth client, redirect URI, resource, scopes, selected Circles, and PocketCircle User. Convex stores the token ID and consumed state. This is not the OAuth authorization code.
7. The browser returns the application approval token to the Worker. The Worker redeems it through a service-authenticated Convex endpoint. Convex consumes it atomically and returns the pending `mcpGrantId`, an opaque MCP principal ID, and approved scopes. None is a browser credential.
8. The Worker calls `completeAuthorization()` with the original server-stored `AuthRequest`, Convex's approved scopes, the opaque principal as `userId`, `metadata: { mcpGrantId }`, and `props: { mcpGrantId }`. It must not rebuild an `AuthRequest` from browser or Convex fields. The opaque IDs are acceptable in storage-visible Worker fields; raw Convex User and Circle IDs and profile data are not. Convex retains the principal-to-User mapping. Cloudflare repeats validation during completion and warns against redirects built from reconstructed, untrusted requests. [Cloudflare authorization endpoint](https://github.com/cloudflare/workers-oauth-provider#authorization-endpoint), [Cloudflare KV storage](https://github.com/cloudflare/workers-oauth-provider#kv-storage-and-cleanup)
9. `completeAuthorization()` creates the Worker grant and OAuth authorization code, then the Worker uses its returned `redirectTo`. The Convex grant remains pending. When the client exchanges that code, configure `tokenExchangeCallback` to receive the Worker `grantId`, `userId`, grant scope, requested token scope, and `props`. The callback records the Worker identifiers and activates the matching pending Convex grant before token issuance completes. It also verifies the grant on refresh. If Convex activation or validation fails, fail token issuance. Cleanup later calls `revokeGrant()` on the orphaned Worker grant. Integration tests must confirm failure and retry behavior because this callback spans Worker KV and Convex, not one transaction. [Cloudflare token exchange callback source](https://github.com/cloudflare/workers-oauth-provider/blob/main/src/oauth-provider.ts)
10. Each tool call yields a verified `mcpGrantId`. The Worker sends it, the effective token scope, OAuth client ID, resource, and exact operation to the Convex bridge under a short-lived Worker assertion. Convex loads the live grant before executing.

The handoff must bind the browser approval to the Worker's validated OAuth request and expire within minutes. Preserve the client's OAuth `state` only inside that stored request and let `completeAuthorization()` return it. Application approval tokens must be one-time even under concurrent redemption. The existing cross-domain Better Auth exchange remains a browser-to-Convex session mechanism; it does not create a Worker session. Do not map Users by email. The authenticated Convex mutation already has the stable app User ID created by the Better Auth trigger. [PocketCircle identity ADR](../adr/0024-google-as-one-time-identity-seed.md)

### Grant model

Convex should own the application authorization record because it must be checked with live membership and lifecycle state. An `mcpGrant` needs at least:

- PocketCircle User ID
- opaque MCP principal ID used as the Worker's OAuth `userId`
- OAuth client ID and display metadata snapshot
- granted scopes
- explicit `allowedCircleIds`
- active or revoked state, timestamps, and last-use metadata
- Worker OAuth grant linkage needed for coordinated revocation

Circle selection is an authorization boundary, not a client-side filter. A call may access a Circle only when all three are true: the Circle is in `allowedCircleIds`, the grant has the required scope, and the User is still an active Member with the required app permission. New Circles are not added automatically; the User reauthorizes to add them.

Revocation must be live. Every bridge request checks `mcpGrant`, so disabling it blocks data access even if a Worker token still validates. Store the Worker OAuth `grantId` and `userId` after activation. The Connections UI should revoke Convex first, then ask a service-authenticated Worker endpoint to call `revokeGrant(grantId, userId)`. Revoking one presented token through RFC 7009 is not the same as revoking the whole connection. Retry Worker grant revocation until it succeeds. This ordering fails closed across Convex and Workers KV. Removing a Member or changing ownership takes effect on the next call through the normal Convex guards. [Cloudflare OAuth helpers](https://github.com/cloudflare/workers-oauth-provider#oauth-helpers)

Authorization also crosses those two stores. Keep a Convex grant pending until the token-exchange callback identifies the Worker grant and activates it. During activation, supersede the same older Convex grants that Cloudflare revokes by default for that User and client. Mirror Cloudflare's CIMD redirect-URI distinction. A reconciliation job must find and revoke pending or orphaned records after partial failures. Do not set `revokeExistingGrants: false` merely to avoid this coordination problem. [Cloudflare grant replacement](https://github.com/cloudflare/workers-oauth-provider#authorization-endpoint)

### Worker to Convex trust

Expose one narrow Convex HTTP bridge, not the public Convex API and not a generic `runFunction` endpoint. Its operation field is a closed discriminated union of MCP operations.

Convex HTTP actions accept standard `Request` and `Response` objects and can call internal queries and mutations, which fits this bridge. [Convex HTTP actions](https://docs.convex.dev/functions/http-actions)

The Worker authenticates with a short-lived, audience-, method-, and body-bound assertion. Prefer asymmetric signing so Convex holds only a public verification key. Include issued-at, expiry, nonce, and request-body digest; reject replays and rotate keys. The caller-supplied `mcpGrantId` has no authority until that assertion verifies and Convex loads the live grant.

There is a separate scope trap. `@cloudflare/workers-oauth-provider` validates an internal bearer token and audience before entering the protected handler, but grant `props` do not state the access token's effective scope. Token and refresh requests can narrow scopes. A read-only token issued from a read-write grant must not regain write access from `mcpGrant`. After provider validation, extract the bearer token, call `env.OAUTH_PROVIDER.unwrapToken()`, and validate its token summary, resource, client, and effective scope. Cross-check Cloudflare Agents' `context.http.authInfo` when the pinned integration supplies it. Pass the effective scope in the signed bridge request. Convex enforces the intersection of effective token scope and live grant scope. Reject a missing or inconsistent summary. Never log the token, `authInfo.token`, or summary props. Cloudflare states that the provider does not enforce operation-level scope policy. [Cloudflare scope behavior and `unwrapToken`](https://github.com/cloudflare/workers-oauth-provider#scopes-and-step-up-authorization), [Cloudflare OAuth helper source](https://github.com/cloudflare/workers-oauth-provider/blob/main/src/oauth-provider.ts), [Cloudflare MCP auth context](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/#authentication-context)

Inside Convex, refactor web and MCP handlers onto shared business functions. Those functions accept a resolved PocketCircle User and retain the existing invariants. Use `resolveCircleAccessForUser` and add equivalent explicit-User entity guards where needed. Do not create a parallel permission system in the Worker.

## Hosted MCP protocol

Use one HTTPS Streamable HTTP endpoint at `https://mcp.pocketcircle.app/mcp`. In MCP `2026-07-28`, every JSON-RPC message is an independent `POST`, returning JSON or request-scoped SSE. There is no initialization handshake, `Mcp-Session-Id`, sticky session, standalone GET event stream, or DELETE teardown. A fresh MCP server instance per request is appropriate. [MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http), [official TypeScript SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/)

Each request must validate:

- `Origin`, when present
- `MCP-Protocol-Version` and `Mcp-Method`
- `Mcp-Name` for named operations, including agreement with the JSON-RPC body
- the Worker's verified authorization context and canonical resource
- the access token's effective scopes before dispatching the named tool

The modern body `_meta` must carry matching protocol version, client info, and capabilities. Missing or mismatched mirrored headers produce HTTP 400 with MCP `HeaderMismatch`; an unsupported method produces HTTP 404 with JSON-RPC `-32601`; an accepted notification produces 202 with no body. Let the SDK own these wire rules instead of duplicating them in middleware.

Start with JSON responses. PocketCircle does not need subscriptions, tool-list change streams, or legacy MCP transports in v1. Configure `createMcpHandler` with `legacy: "reject"`. Put bearer credentials only in the `Authorization` header. Do not accept them in URLs. Clients must send an `Accept` header for both `application/json` and `text/event-stream`.

## OAuth discovery and client registration

The MCP endpoint is the protected resource. Publish RFC 9728 metadata and reference it in the initial `WWW-Authenticate` challenge. The Worker is also the authorization server and publishes RFC 8414 metadata. Configure `resourceMetadata.resource` as exactly `https://mcp.pocketcircle.app/mcp`; this pins grants and token audiences. MCP requires clients to send that resource in authorization and token requests. The Cloudflare provider tolerates omission for compatibility when a canonical resource is configured, but it still binds the resulting token to that resource. Reject any explicit mismatch and any token summary for another resource. [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization), [Cloudflare resource binding](https://github.com/cloudflare/workers-oauth-provider#resources-and-token-audiences), [RFC 9728](https://datatracker.ietf.org/doc/html/rfc9728), [RFC 8707](https://datatracker.ietf.org/doc/html/rfc8707)

Use `@cloudflare/workers-oauth-provider` for OAuth endpoints, PKCE, clients, grants, tokens, revocation, and resource metadata. It supports the current MCP authorization profile and gives protected handlers verified auth context. [Cloudflare Workers OAuth Provider](https://github.com/cloudflare/workers-oauth-provider), [Cloudflare authorization guide](https://developers.cloudflare.com/agents/model-context-protocol/protocol/authorization/), [Cloudflare MCP handler auth context](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/)

Configure both scope lists. `scopesSupported` is the authorization server's full supported set. `resourceMetadata.scopes_supported` is the protected resource's minimal baseline guidance and need not list every step-up scope. Also set `authorization_servers: ["https://mcp.pocketcircle.app"]`, `bearer_methods_supported: ["header"]`, and leave `resourceMatchOriginOnly: false`. [Cloudflare scope configuration](https://github.com/cloudflare/workers-oauth-provider#scopes-and-step-up-authorization)

Set an access-token lifetime around 10 to 15 minutes instead of the library's one-hour default. Choose refresh behavior explicitly. `refreshTokenTTL: 0` disables refresh tokens; a finite value enables them. The Cloudflare provider does not condition issuance on `offline_access`, and it defaults to a 30-day refresh lifetime. Persistent hosted connections need refresh tokens, so disclose that duration during consent and keep it finite. The library rotates them. Run `purgeExpiredData()` on a scheduled Worker trigger to remove expired or orphaned KV records. Short access-token life limits exposure, but the live Convex grant remains the immediate revocation control. [Cloudflare token lifecycle](https://github.com/cloudflare/workers-oauth-provider#pkce-and-token-lifecycle), [KV cleanup](https://github.com/cloudflare/workers-oauth-provider#kv-storage-and-cleanup)

Client registration rollout:

1. Pre-register development and launch clients.
2. Enable Client ID Metadata Documents, or CIMD, for general interoperability.
3. Enable Dynamic Client Registration only for clients that still require it. DCR is deprecated in MCP `2026-07-28`.

CIMD fetches a client-controlled URL. In the Worker, explicitly set `clientIdMetadataDocumentEnabled: true`, `global_fetch_strictly_public`, and a compatibility date at least `2024-11-11`; PocketCircle's current date already clears that floor. The Cloudflare library then applies HTTPS and redirect URI validation, size and timeout bounds, and safe public fetch behavior. Its current CIMD path supports public clients using `token_endpoint_auth_method: "none"`; a client offering only `private_key_jwt` will fail. Keep DCR disabled by default; if enabled, rate-limit and constrain its callback policy. [MCP client registration](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration), [Cloudflare registration support](https://github.com/cloudflare/workers-oauth-provider#client-registration)

## Scopes and Circle grants

Start with two scopes. Convex remains responsible for per-record authorization.

| Scope | Capability |
| --- | --- |
| `pocketcircle:read` | Read the approved Circles, Members, Transactions, Categories, histories, dashboards, and reports |
| `pocketcircle:write` | Create or edit Transactions and Categories inside approved Circles |

Reserve `pocketcircle:manage` for a later design. Do not grant it or publish management tools in v1.

Return `403` with `insufficient_scope` only when another OAuth scope could fix the denial. A Circle not selected in the grant, inactive membership, ownership failure, or inaccessible record stays a normal tool error. Sending the User through scope consent again does not fix current app permissions. Do not advertise `offline_access` as a resource scope. The MCP spec allows clients to request it from the authorization server, but the chosen Cloudflare provider's refresh-token switch is `refreshTokenTTL`, not that scope. [MCP refresh tokens](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization#refresh-tokens)

## Product research

Established hosted MCP servers expose meaningful writes without a common retry, concurrency, confirmation, or audit contract.

| Product | Published write surface | Confirmation | Idempotency and concurrency | Audit visibility |
| --- | --- | --- | --- | --- |
| Stripe | `stripe_api_write` can call write API methods; `create_refund` is also explicit | Stripe recommends enabling human confirmation in the client | The MCP documentation does not expose a standard idempotency-key or version field for these tools. Stripe's HTTP API supports idempotency separately, but that is not an MCP convention | Users can review and revoke OAuth sessions; no per-tool MCP audit contract is documented |
| GitHub | Issues, comments, pull requests, files, repositories, workflows, and other mutations | Mostly client policy. One Copilot pull-request tool description asks the agent to confirm inferred owner and repository | No generic key or version field. Concurrency is operation-specific: replacing a file takes its current blob `sha`, and updating a PR branch can take `expectedHeadSha` | Mutations create normal GitHub artifacts and history; the server documents no separate MCP audit stream |
| Linear | Create and update issues, projects, and comments; a separate read-only endpoint is available | Example prompts ask the client to preview proposed creates and updates | No idempotency key or optimistic-version parameter is documented for the hosted tools | Changes appear in normal issue activity. Enterprise audit logs cover account and settings events, not a dedicated MCP-call ledger |
| Notion | Create, update, move, and duplicate pages; create and update databases, data sources, views, and comments | Notion tells operators to enable human confirmation in the client | No caller key or general entity version is documented. Batch search-and-replace aborts if the expected old text does not match exactly, a tool-specific concurrency guard | Enterprise audit logs attribute page and comment actions to users, integrations, or external AI tools; this is product audit, not an MCP contract |

Sources: [Stripe MCP tools and confirmation guidance](https://docs.stripe.com/mcp), [Stripe API idempotent requests](https://docs.stripe.com/api/idempotent_requests), [GitHub MCP server tool catalog](https://github.com/github/github-mcp-server#tools), [Linear MCP](https://linear.app/docs/mcp), [Linear activity and audit](https://linear.app/docs/audit-log), [Notion MCP supported tools](https://developers.notion.com/guides/mcp/mcp-supported-tools), [Notion MCP security guidance](https://developers.notion.com/guides/mcp/mcp-security-best-practices), [Notion audit log](https://www.notion.com/help/audit-log).

MCP itself standardizes only an `idempotentHint` tool annotation. It states that annotations are untrusted hints, not enforcement, and defines no idempotency-key field, optimistic version/precondition field, durable retry behavior, or server audit-log schema. MCP logging is a server-to-client diagnostic facility, not an audit record. The tools guidance recommends that applications let humans deny calls and show confirmation prompts, but leaves the interaction model to implementations. The newer input-request result can support a server-originated approval round; it does not mandate one. [MCP tool annotations](https://modelcontextprotocol.io/specification/2026-07-28/schema#toolannotations), [MCP tools and user interaction](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#user-interaction-model), [MCP input requests](https://modelcontextprotocol.io/specification/2026-07-28/server/tools#input-required-tool-results).

Therefore these controls are risk decisions, not protocol prerequisites. For PocketCircle, live authorization and scope enforcement remain mandatory security boundaries. Existing domain mutations already append immutable `histories` events for Circle, Transaction, and Category writes in the same Convex transaction, with actor, action, changes, and time. That is the business audit trail; a separate MCP audit subsystem must not gate writes. Optional MCP provenance can be added to those events later if it answers a concrete support or security question. A narrow operational access log may record request outcome and latency, without financial payloads. Optimistic checks should be added only to operations where the domain exposes a meaningful revision. A generic caller-supplied idempotency key should not block the write milestone: there is no interoperable client convention for supplying or reusing one. If retry testing shows duplicate-Transaction risk, add an optional logical operation ID to `create_transaction`, document retry reuse, and persist its result atomically. Category uniqueness and existing domain guards should handle their own semantics. [History schema](../../packages/convex/convex/schema.ts)

## Tool contract

Do not expose raw Convex names or a generic query tool. Publish stable, task-oriented tools with Zod input and output schemas, cursor pagination, structured results, and honest annotations. Stored titles, notes, Circle names, and emails are untrusted data, never instructions. [MCP tools](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)

### Final launch catalog

All rows require an active grant and a selected Circle where applicable. `get_current_user` through `list_circle_history` require `pocketcircle:read`; every create, update, archive, and restore requires `pocketcircle:write`. “Existing operation” means reuse its validation, bounded reads, permission checks, history writes, and side effects through a shared explicit-User function. It does not mean calling the browser-authenticated public Convex function from the Worker.

| MCP tool | Existing operation | App permission | Missing code |
| --- | --- | --- | --- |
| `get_current_user` | `users.getCurrentUser` | Current granted User | Explicit-User adapter; omit email unless the response needs it |
| `list_authorized_circles` | `circles.listMyCircles` | Active membership | Explicit-User read intersected with `allowedCircleIds` |
| `get_circle` | `circles.getCircle` | Active membership | Explicit-User adapter plus grant filter |
| `list_members` | `members.listMembers` | Active membership | Explicit-User adapter; return display identity, role, and status only |
| `search_transactions` | `search.searchTransactions` and `filterLedgerTransactions` | Active membership | One explicit-User schema supporting optional month/date window; preserve indexed ceiling, filters, and cursor pagination |
| `get_transaction` | `transactions.getTransaction` | Active membership | Explicit-User entity guard |
| `list_transaction_history` | `transactions.listTransactionHistory` | Active membership | Explicit-User entity guard; preserve history pagination |
| `get_monthly_ledger` | `ledger.getMonthlyLedger` | Active membership | Explicit-User adapter |
| `get_dashboard` | `dashboard.getDashboard` | Active membership | Explicit-User adapter |
| `get_monthly_comparison` | `dashboard.getMonthlyComparison` | Active membership | Explicit-User adapter; keep the 1/3/6/12-month validator |
| `get_category_analytics` | `dashboard.getCategoryAnalytics` | Active membership | Explicit-User adapter and existing bounded month read |
| `list_categories` | `categories.listCategories` or `filterCategories` | Active membership | One stable schema over existing status/type/search modes and pagination |
| `get_category` | `categories.getCategory` | Active membership | Explicit-User entity guard |
| `list_category_transactions` | `categories.listRecentCategoryTransactions` | Active membership | Explicit-User adapter; preserve its bounded result |
| `list_category_history` | `categories.listCategoryHistory` | Active membership | Explicit-User entity guard; preserve pagination |
| `list_circle_history` | `circles.listCircleHistory` | Active membership | Explicit-User adapter; preserve pagination |
| `create_transaction` | `transactions.createTransaction` | Any active Member; active, setup-complete Circle | Shared explicit-User mutation; `pocketcircle:write` |
| `update_transaction` | `transactions.updateTransaction` | Recorded By Member; active, setup-complete Circle | Shared explicit-User mutation; `pocketcircle:write` |
| `archive_transaction` | `transactions.archiveTransaction` | Recorded By Member or Circle Owner | Shared explicit-User mutation; `pocketcircle:write`; mark destructive and require client confirmation |
| `restore_transaction` | `transactions.restoreTransaction` | Recorded By Member or Circle Owner | Shared explicit-User mutation; `pocketcircle:write` |
| `create_category` | `categories.createCategory` | Any active Member; active, setup-complete Circle | Shared explicit-User mutation; `pocketcircle:write` |
| `update_category` | `categories.updateCategory` | Category creator; active, setup-complete Circle | Shared explicit-User mutation; `pocketcircle:write` |
| `archive_category` | `categories.archiveCategory` | Category creator or Circle Owner | Shared explicit-User mutation; `pocketcircle:write`; mark destructive and require client confirmation |
| `restore_category` | `categories.restoreCategory` | Category creator or Circle Owner | Shared explicit-User mutation; `pocketcircle:write` |

The reversible archive and restore tools are useful, already guarded, and already produce immutable history, so deferring them would be arbitrary. “Confirmation” here means the tool advertises honest annotations and its description instructs clients to show the exact target. Because annotations are not enforcement, consent and `pocketcircle:write` remain the server boundary. If launch clients cannot reliably confirm destructive calls, omit the two archive tools until they can; restores are not destructive.

### Explicit exclusions

| Existing surface | Launch decision | Reason |
| --- | --- | --- |
| `transactions.listTransactions`, `getEditableTransaction`; search/filter option queries | No separate tools | Superseded by the stable search/detail contracts; UI-shaped helpers would duplicate the catalog |
| Circle create, rename, currency/settings, setup, archive, restore, delete; `circleHasTransactions` helper | Exclude | Circle lifecycle and policy need a distinct `pocketcircle:manage` consent scope; delete is irreversible; the helper exists only to support that UI flow |
| Invitations; ownership transfer, member removal, leave Circle | Exclude | Changes access for other people or the caller and can trigger email; needs manage scope and a separate confirmation design |
| User onboarding/profile/analytics/announcements; activation checklist | Exclude | Browser/account preferences, not financial collaboration tasks |
| Notifications read/write | Exclude | Product inbox state is not needed to operate the financial domain and would expand personal-data surface |
| `homeSummary` and include/exclude Circle | Exclude | Cross-Circle UI composition and local dashboard preference; MCP clients can compose authorized per-Circle reads |
| Feedback and feature-announcement source | Exclude | Support/content-delivery plumbing, not an MCP business capability |
| Invitation preview/acceptance | Exclude | Token-bearing, pre-membership flow must remain in the browser |
| Account-deletion blockers and deletion flow | Exclude | Destructive account lifecycle belongs in the first-party browser |
| `export.exportTransactions` | Exclude | Up to 5,000 Transactions and broad exfiltration risk. Design a bounded artifact flow with separate confirmation later |
| E2E functions and every internal email, notification, cleanup, migration, and Sentry function | Exclude | Test or implementation plumbing, never a product tool |

[Current public functions](../../packages/convex/convex), [access guards](../../packages/convex/convex/guard.ts), [history implementation](../../packages/convex/convex/history.ts), [export bound](../../packages/convex/convex/export.ts)

Return canonical PocketCircle references and display fields, not raw Convex documents. Preserve money as integer minor units plus currency and dates as existing `YYYY-MM-DD` strings. Return cursors instead of unbounded arrays.

Use `idempotentHint` only when repeating the same arguments truly has no additional effect. Do not claim it for ordinary creates. If `create_transaction` gains a logical operation ID, persist it against `mcpGrantId`, tool, and ID with the created entity reference in the same transaction. Update tools may take a current entity revision where the domain has one; do not invent a protocol-wide version field.

## Required controls

- **Live authorization:** Verify the Worker assertion, effective token scope, active `mcpGrant`, grant scope, selected Circle, live membership, and entity permission on every call.
- **Business history:** Keep using the existing append-only `histories` events created atomically by domain mutations. Do not duplicate them in an MCP-specific audit store. Add optional MCP provenance to the existing event only if needed.
- **Privacy:** Scrub Sentry and Worker logs. Keep MCP payloads out of PostHog. Apply retention and deletion rules to grants, approvals, and any narrow operational access logs. Never log financial values, notes, access tokens, OAuth codes, application approval tokens, or Worker assertions.
- **Rate limits:** Limit by User, client, grant, tool, and IP. Give writes tighter limits.
- **Prompt injection:** Return stored text only in typed data fields. Tool descriptions and server instructions must not treat it as executable guidance.
- **Revocation:** Add a Connections page showing client, scopes, selected Circles, created time, and last use. Revocation disables the Convex grant first, then retries Worker-grant revocation. Account deletion disables every Convex grant before asynchronous Worker cleanup.
- **Consent:** Show client ID, client-provided display metadata, exact scopes, selected Circles, and the configured refresh-token duration. Never silently broaden an existing grant.
- **Anti-enumeration:** Preserve the app's missing-equals-inaccessible behavior for records and Circles.
- **Origin and proxy correctness:** Validate every present `Origin`; origin-less native clients remain valid. Configure `allowedHostnames` for `mcp.pocketcircle.app` and an explicit `allowedOriginHostnames` policy. Do not use wildcard CORS as a substitute. All discovery, resource, issuer, redirect, and request URLs must use the external custom domain consistently. [Cloudflare Origin validation](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/#origin-validation-and-cors)

## Free-tier feasibility

Qualified yes. The full v1 can run on Workers Free and Convex Free for development or a small private beta. Neither plan withholds a component the design requires. I would not promise a public production service at $0, though. Both plans enforce hard usage caps, Cloudflare allows only 10 ms of CPU per HTTP request, and Convex Free has no paid overage fallback. Measure the finished path before launch and upgrade when either provider's alerts show sustained pressure.

### Cloudflare

| Need | Free availability and limit | Consequence |
| --- | --- | --- |
| Worker and custom domain | 100,000 requests/day, 10 ms CPU/request, 128 MB memory, 50 external subrequests/request, 3 MB compressed bundle, 100 Workers/account, 100 custom domains/zone | Available. One Convex fetch is far below the subrequest limit. OAuth crypto, MCP parsing, schema validation, and assertion signing must fit 10 ms CPU. Cloudflare says auth-heavy Workers often use 10 to 20 ms, so this is the first benchmark gate |
| OAuth KV | 1 GB; 100,000 reads, 1,000 writes, 1,000 deletes, and 1,000 list operations/day; 1 write/second to the same key | Available and required by `@cloudflare/workers-oauth-provider`. Normal tool calls consume reads. Authorizations, codes, token issue/refresh/revocation, client registration, and cleanup consume the much smaller write/delete budgets. Quota exhaustion fails the operation rather than billing overage |
| Scheduled cleanup | Five Cron Triggers/account; 10 ms CPU and 15 minutes wall time per trigger | Available. Run `purgeExpiredData()` incrementally and test its CPU. A large KV listing or purge cannot assume Paid-plan CPU |
| Rate-limit binding | Documented Workers binding with Wrangler 4.36+; the current repo has Wrangler 4.121 | Available without a documented paid-plan requirement. Counters are location-local, permissive, and eventually consistent, so they protect capacity but do not enforce billing or authorization |
| Secrets | Up to 64 variables per Worker, 5 KB each | Available. Enough for signing keys and Convex service configuration; use secrets, not Wrangler plaintext vars |
| Logs | Workers Logs includes 200,000 events/day and three-day retention on Free; 256 KB maximum per log | Available for launch diagnostics, not durable security history. Keep business history in Convex and scrub credentials and financial payloads |
| Agents, MCP SDK, OAuth library | JavaScript packages run inside the Worker; the OAuth provider requires KV and supports MCP 2026-07-28 | No separate paid Cloudflare product is required. Pin compatible versions and test the stateless `createMcpHandler` plus OAuth wiring. Cloudflare's current docs do not yet show that exact authenticated stateless composition end to end |

[Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/), [KV limits](https://developers.cloudflare.com/kv/platform/limits/), [KV pricing](https://developers.cloudflare.com/kv/platform/pricing/), [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/), [rate-limit binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/), [Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/), [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/), [OAuth provider requirements](https://github.com/cloudflare/workers-oauth-provider)

### Convex

| Need | Free availability and limit | Consequence |
| --- | --- | --- |
| Queries, mutations, actions, HTTP actions | 1,000,000 function calls/month; 20 GB-hours/month of action compute; 20 MiB HTTP response limit; S16 allows 16 concurrent queries, 16 mutations, and 64 Convex runtime actions/HTTP actions | Available. The bridge HTTP action and one internal query or mutation use about two function calls per tool call. Keep all database work in one internal function, both for consistency and cost |
| Database | 0.5 GB table plus index storage, 1 GB database I/O/month, 1 GB egress/month, all measured per team | Available. Search, reports, histories, and indexes may hit I/O before call count. MCP adds grants and small approval records, but existing app data and Better Auth component data share the same team caps |
| Full-text search | 0.5 GB search storage and 3,000 query-GB/month; 1,024 maximum results | Available. The MCP search tool must preserve the app's existing indexed ceiling and pagination |
| Scheduling | Crons and durable scheduled functions are included; S16 allows eight concurrent scheduled jobs | Available. Existing app jobs and any grant reconciliation share the limit and function-call quota |
| Auth component | Auth and components are Free-plan features | Existing Better Auth stays in Convex. Browser approval uses its normal session flow and consumes shared function/database usage. MCP tool calls bypass browser auth and do not invoke the auth component |
| Team and deployments | 1 to 6 developers and 40 deployments/team; Free uses S16 | Enough for the current team and a separate development/production deployment only if the team remains inside those totals |
| Operations | Health and Insights are included. Log streaming, exception reporting, daily backups, custom domains, and an SLA are not Free features | None blocks the bridge. Use the existing `*.convex.site` URL server to server. Free is a poor fit once the MCP endpoint needs an uptime promise or longer operational retention |

Convex Free sends warnings near limits. Sustained excess can return HTTP errors, and Free does not meter overage. Usage is summed across every project on the team, not reserved for PocketCircle. [Convex limits](https://docs.convex.dev/production/state/limits), [Convex pricing and feature comparison](https://www.convex.dev/pricing), [Convex pricing FAQ](https://www.convex.dev/pricing/faq), [HTTP actions](https://docs.convex.dev/functions/http-actions), [action call composition](https://docs.convex.dev/functions/actions), [scheduling](https://docs.convex.dev/scheduling/overview), [components](https://docs.convex.dev/components/using)

### Request amplification and practical ceiling

A normal `tools/call` should use one Worker request, roughly two OAuth KV reads for bearer validation plus the explicit token-summary check, one external subrequest to Convex, one Convex HTTP action, and one internal query or mutation. The OAuth provider's exact KV count is an implementation detail, so confirm it against the pinned release. The rate-limit binding does not add a network subrequest.

That model gives rough upper bounds before existing PocketCircle traffic:

- Worker requests allow 100,000 tool calls/day, but two KV reads lower the KV ceiling to roughly 50,000/day.
- Two Convex function calls per tool call lower the call-count ceiling to roughly 500,000/month, about 16,700/day. Database I/O or egress can bind earlier, especially for histories, search, and reports.
- OAuth authorization and refresh traffic does not map one-to-one to tool calls. Its multiple KV writes make the 1,000-write/day quota the connection-churn limit. Do not enable unrestricted DCR on Free.
- The existing web app, Better Auth component, scheduled work, and other Workers on the account consume the same vendor quotas. These figures are ceilings, not capacity targets.

Launch on Free only after production-bundle profiling proves p95 Worker CPU below 10 ms with token validation and one representative read and write. Also load-test Convex I/O with the largest allowed result pages. If either fails, Workers Paid is the likely first upgrade because its CPU limit removes the sharpest technical risk. Move Convex to a paid plan with the required overage behavior before the public endpoint depends on uninterrupted service past a hard cap. Professional is needed only for its higher capacity or paid operational features.

## Delivery plan

### Feasibility and missing implementation

| Layer | Feasible with current system? | Required work or blocker |
| --- | --- | --- |
| Remote Streamable HTTP | Yes | Add a dedicated Worker package, compatible Cloudflare Agents and MCP SDK dependencies, `/mcp`, discovery metadata, protocol validation, and tests. These packages are not currently installed |
| OAuth server | Yes | Add `@cloudflare/workers-oauth-provider`, OAuth KV, keys, custom domain, pre-registered clients/CIMD, token policy, cleanup trigger, and scope checks. No Google OAuth change is required |
| Existing Google login | Yes | Keep Better Auth `1.6.16` and `@convex-dev/better-auth` `0.12.5`; add a protected SPA `/mcp/authorize` route. The browser session approves access but is never an MCP credential |
| SPA-to-Worker handoff | Yes, with distributed-state care | Implement signed short-lived handoff envelopes, pending grants, single-use approval tokens, token-exchange activation, denial/expiry, orphan reconciliation, and failure tests |
| Worker-to-Convex bridge | Yes | Add a closed-operation Convex HTTP action, asymmetric assertion verification, replay protection, and internal queries/mutations. There is no bridge today |
| Existing domain logic | Yes, after refactor | Extract explicit-User operations and entity guards used by both web handlers and MCP bridge. Do not duplicate validators, guards, history, notification, activation, or currency-lock behavior |
| Circle grant enforcement | No current implementation | Add `mcpGrant` persistence, selected-Circle checks, live membership checks, effective-token/grant scope intersection, revocation, and Connections UI |
| Rate limiting | No general MCP limiter exists | Add Worker limits by client, principal/grant, IP, and tool class. Keep Convex validation and bounded queries as defense in depth. Rate limits are launch work, not a reason to weaken tool permissions |
| Deployment | Yes | Keep the existing asset Worker unchanged. Add a separate Worker config, OAuth KV binding, secrets, `mcp.pocketcircle.app`, monitoring, and an independent deploy job |

The only launch blockers are implementation gaps, not dependency or platform incompatibility: no MCP Worker package, grant schema/UI, approval handoff, signed bridge, explicit-User domain adapters, or MCP-specific rate limits exist yet. Direct Better Auth MCP remains blocked by the current dependency/plugin matrix, but the recommended Worker design does not depend on that upgrade. [Cloudflare remote MCP](https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/), [Cloudflare OAuth provider](https://github.com/cloudflare/workers-oauth-provider), [Cloudflare rate-limit binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/), [Convex HTTP actions](https://docs.convex.dev/functions/http-actions), [current dependencies](../../packages/convex/package.json), [current Worker](../../wrangler.jsonc)

1. **Read-only end-to-end slice.** Deploy the Worker, discovery endpoints, pre-registered test client, SPA handoff, pending-to-active grant flow, signed bridge, `get_current_user`, and `list_authorized_circles`.
2. **Read catalog.** Add Transaction, Category, Member, dashboard, and ledger tools through shared explicit-User domain functions. Add CIMD with strict public fetch.
3. **Routine writes.** Route mutations through the existing domain path so immutable history remains atomic. Add per-tool idempotency, optimistic concurrency, or MCP provenance only where analysis justifies it.
4. **Connections and revocation.** Ship User-visible grant review and immediate revocation before public availability.
5. **Client coverage.** Test the official MCP Inspector and at least two hosted clients. Add DCR only if a required client lacks pre-registration and CIMD.

Required tests include OAuth state mix-up, application approval-token replay, wrong client or redirect, wrong resource, expired token, downscoped read token calling a write tool, missing scope, revoked grant, partial grant activation failure, deselected Circle, removed membership, inaccessible IDs, Worker assertion replay or body tampering, logical operation ID replay if implemented, invalid Origin, and absence of credentials or financial payloads in logs.

## Future simplification

Re-evaluate a direct Better Auth MCP provider only after `@convex-dev/better-auth` supports Better Auth 1.7 and its OAuth schema plugins without breaking the existing Convex token route. It could replace the OAuth Worker and custom handoff protocol, but it should preserve the same browser approval, application grant, selected-Circle boundary, live authorization, and PocketCircle write controls. Until that compatibility is documented and regression-tested, the dedicated Worker is the simpler reliable architecture.

## Decision

Build the hosted MCP server as a dedicated Cloudflare Worker. Reuse Google by reusing PocketCircle's signed-in browser session for the approval page, not by reusing Google or web-session tokens. The Worker owns OAuth and MCP credentials. Convex owns live grants, selected Circles, business rules, and data. This fits the current dependency matrix and keeps each credential valid only at its intended boundary.
