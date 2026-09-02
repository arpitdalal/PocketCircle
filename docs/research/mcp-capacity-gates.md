# MCP capacity gates and upgrade triggers

PocketCircle MCP launches on **Workers Free** and **Convex Free** for development and a small private beta. These plans share hard ceilings with the rest of the product. Rate limits in `packages/mcp-worker/wrangler.jsonc` protect burst abuse; they do not replace authorization and they are not a substitute for plan upgrades.

## Free-tier ceilings (shared)

| Resource | Free ceiling | MCP implication |
| --- | --- | --- |
| Worker CPU | **10 ms** / request | Auth + parse + rate-limit + one Convex subrequest must stay under this |
| Worker requests | 100,000 / day | Soft ceiling for tool calls |
| OAuth KV reads | 100,000 / day | ~2 reads per authenticated tool call → ~50,000 tools/day |
| OAuth KV writes | 1,000 / day | Authorization, token issue/refresh/revocation, cleanup |
| Convex function calls | 1,000,000 / month | ~2 calls per tool (HTTP action + query/mutation) → ~500,000 tools/month |
| Convex DB I/O + egress | 1 GB each / month | Search, reports, and history pages bind first |

Sources: [Workers limits](https://developers.cloudflare.com/workers/platform/limits/), [KV limits](https://developers.cloudflare.com/kv/platform/limits/), [Convex limits](https://docs.convex.dev/production/state/limits), and `docs/research/hosted-mcp-server.md`.

## Rate-limit bindings (#331)

| Binding | Period | Limit | Key |
| --- | --- | --- | --- |
| `MCP_AUTH_RATE_LIMITER` | 60s | 120 | `authorization\|c:{clientId}` (else IP) |
| `MCP_TOKEN_RATE_LIMITER` | 60s | 120 | `token\|c:{clientId}` (else IP) |
| `MCP_FAILED_AUTH_RATE_LIMITER` | 60s | 30 | `failed_auth\|c:{clientId}` or IP |
| `MCP_READ_RATE_LIMITER` | 60s | 120 | `u:{user}\|c:{client}\|g:{grant}\|t:read` |
| `MCP_WRITE_RATE_LIMITER` | 60s | 30 | `…\|t:write` |
| `MCP_DESTRUCTIVE_RATE_LIMITER` | 60s | 10 | `…\|t:destructive` |

Counters are location-local and eventually consistent. They exist to protect shared Free quotas, not for billing.

## Request size

Worker JSON surfaces and the Convex MCP bridge reject bodies above `MCP_JSON_MAX_BODY_BYTES` (65 KiB) before domain work. Client provisioning stays at `MCP_PROVISIONING_MAX_BODY_BYTES` (8 KiB). Zod schemas still reject malformed tool inputs.

## Profiling

Run the local micro-bench (Worker parse + rate-limit key path, no Convex):

```bash
pnpm --filter @pocketcircle/mcp-worker exec vitest run src/capacity.profile.test.ts
```

That reports p50/p95 wall time for the local path. **Production CPU** must still be confirmed in the Cloudflare Workers dashboard (CPU time per request) after deploy — wall-clock local time is not CPU time.

Before public launch (#332), record:

1. Worker CPU p50/p95 for `get_current_user`, `search_transactions` (max page), and `create_transaction`.
2. Convex Insights: function calls, DB I/O, egress for the same paths.
3. KV read/write daily totals under expected connection churn.

## Upgrade triggers

Upgrade **before** the public custom domain depends on uninterrupted Free service:

| Signal | Trigger | First move |
| --- | --- | --- |
| Worker CPU p95 | Sustained **≥ 8 ms** (80% of 10 ms Free limit) on authenticated tool calls | **Workers Paid** (CPU headroom) |
| Worker CPU p95 | Any production sample **≥ 10 ms** / request errors | Workers Paid immediately |
| OAuth KV writes | Sustained **≥ 700 writes/day** (~70% of 1,000) | Workers Paid KV or reduce refresh churn / disable DCR |
| OAuth KV reads | Sustained **≥ 70,000 reads/day** | Workers Paid or cache token validation carefully (do not weaken auth) |
| Convex function calls | Sustained **≥ 700,000 / month** team-wide | Convex paid plan with overage |
| Convex DB I/O or egress | Sustained **≥ 700 MB / month** | Convex paid plan; shrink MCP page sizes if still premature |
| Rate-limit 429 rate | Authenticated users routinely hitting write/destructive caps under normal UI use | Raise binding limits **only after** plan upgrade; never raise as a substitute for Paid CPU |

Workers Paid is the likely first upgrade: Free CPU is the sharpest technical cliff. Move Convex off Free before public usage depends on service continuing past a hard monthly cap.

## Privacy

Operational logs use `mcpLog` / `mcpLogError` only. They record outcome, status, tool class, and duration — never tokens, codes, assertions, amounts, titles, notes, Circle names, or emails. See `packages/mcp-worker/src/safe-log.ts`.
