# PocketCircle plugin (local package)

Installable ChatGPT / Codex plugin that maps to the hosted MCP server at `https://mcp.pocketcircle.app/mcp`.

Local marketplace install is **not** public directory publication and does **not** prove ChatGPT web availability.

## Package layout

| Path | Role |
| --- | --- |
| `.codex-plugin/plugin.json` | Manifest (`name`: `pocketcircle`, display name PocketCircle) |
| `.app.json` | Registered ChatGPT connection id (`asdk_app_…`) |
| `.mcp.json` | Remote MCP HTTP URL |
| `skills/browse-authorized-records/` | Browse/read workflow skill (honest that write tools exist) |
| `skills/spending-review/` | Personal and Circle spending workflow |
| `skills/record-transactions/` | Transaction and Category create/update/archive/restore, confirmation, and uncertain outcomes |
| `assets/logo.png` | Install-surface logo |

## Install from this repo marketplace

Marketplace **root** is the **repo root**, not `.agents/plugins/`. Codex looks for `.agents/plugins/marketplace.json` under that root and resolves `./plugins/pocketcircle` from the root.

### Codex UI

1. Plugins → Add plugin marketplace.
2. **Source:** `/absolute/path/to/pocket-circle` (repo root).
3. Leave **Git ref** and **Sparse paths** empty (local folder, not a git marketplace).
4. Add marketplace → open **PocketCircle local** → install **PocketCircle**.
5. Complete Google sign-in + Circle consent; start a **new** chat.

Wrong: Source = `…/pocket-circle/.agents/plugins` → `marketplace root does not contain a supported manifest`.

### CLI

```sh
codex plugin marketplace add /absolute/path/to/pocket-circle
codex plugin marketplace list
```

Restart ChatGPT / Codex after marketplace or package changes.

## Update / refresh

1. Pull latest repo changes (or edit files under `plugins/pocketcircle/`).
2. For local development, use the plugin-creator cachebuster helper, then run `codex plugin add pocketcircle@pocketcircle-local` to reinstall the current source. On 2026-09-07 this refreshed all three skills into the versioned cache.
3. Start a new thread to load the new skills. Restart ChatGPT desktop if its local install still shows the earlier package. The cache is `~/.codex/plugins/cache/pocketcircle-local/pocketcircle/<version>/`.
4. In an open plugin detail pane, use **Refresh** if the host shows one, then start a new chat so tools/skills rediscover.

## Develop against local Worker and Convex dev

The shortest path after the one-time setup is:

```sh
pnpm dev:chatgpt
```

This starts the web app, local MCP Worker, and named Cloudflare Tunnel together;
Ctrl-C stops them. The detailed setup and prerequisites live in the root
[README](../../README.md#chatgpt-local-mcp-testing).

The production package above still targets `mcp.pocketcircle.app`. Installing it from a local marketplace does not change that endpoint. Use a separate **PocketCircle Dev** connection and package for local host evaluations.

1. Complete the [local MCP setup](../../README.md#run-app) with Worker credentials matching Convex dev. Keep `.dev.vars` pointed at the dev `CONVEX_SITE_URL`, with `APP_ORIGIN=http://127.0.0.1:5173`. Keep root `VITE_MCP_WORKER_ORIGIN=http://127.0.0.1:8788` for the local consent UI.
2. Run a named Cloudflare Tunnel forwarding `mcp-dev.pocketcircle.app` to `http://127.0.0.1:8788`. Store its credentials/config under `~/.cloudflared`, outside the repo. Use an ingress rule returning `http_status:404` for `^/cdn-cgi/.*` before the Worker rule and a final catch-all 404. Named tunnels support SSE; TryCloudflare quick tunnels do not.
3. Start the services in separate terminals:

   ```sh
   pnpm dev:web
   pnpm dev:mcp:chatgpt https://mcp-dev.pocketcircle.app
   cloudflared tunnel --config ~/.cloudflared/pocketcircle-dev.yml run pocketcircle-dev
   ```

   Do not also run `pnpm dev:mcp` on the same port. The ChatGPT launcher pins the OAuth issuer and resource to the tunnel URL, uses local bindings, and disables Wrangler's local storage explorer. It advertises DCR instead of CIMD because ChatGPT's client-metadata endpoint returned 403 to local workerd fetches during testing. Production keeps CIMD enabled by default. Worker edits reload locally. Keep the consent UI running on the same computer where you complete Google sign-in.
4. In ChatGPT developer mode, register **PocketCircle Dev** at `https://mcp-dev.pocketcircle.app/mcp` with OAuth. Complete Google sign-in and select synthetic dev Circles. Map the development plugin's `.app.json` to that connection's actual ID, never the production ID. Its `.mcp.json` must use the same development URL. Copy current skills/assets from this source package when refreshing the development package.
5. Refresh the development connection in ChatGPT after tool metadata changes, verify the new descriptions, then start a new chat selecting only **PocketCircle Dev**. Skill edits also require package refresh/reinstall. Convex dev deployments and restarting ChatGPT do not deploy or refresh the production MCP Worker.

Before host testing, verify both the local and public `/.well-known/oauth-authorization-server` advertise `https://mcp-dev.pocketcircle.app`, `/.well-known/oauth-protected-resource` advertises that origin plus `/mcp`, unauthenticated `/mcp` returns 401, and `/cdn-cgi/local/explorer/api/local/workers` returns 404. Confirm authenticated tool calls reach the local Worker logs and operate on dev Circles.

References: [Cloudflare named tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/local-management/create-local-tunnel/), [ChatGPT connection and metadata refresh](https://developers.openai.com/plugins/deploy/connect-chatgpt).

## Connection / revoke

- Manage grants at https://pocketcircle.app/connections (revoke, reconnect, Circle selection).
- Re-consent after revoke or when a new Circle should become visible.
- Raw MCP URL (Dev Mode connector) still works; the package is the installable wrapper around the same server.

## Observed host notes

- ChatGPT Dev Mode connection ids look like `asdk_app_…` / `asdk_app_v_…`. `.app.json` must use the real **App Id**, not an invented value.
- Codex and ChatGPT share the plugin package shape; surfaces differ for marketplace browsing.
- ChatGPT **web** cannot install from a local marketplace — use desktop for package install, or Dev Mode URL connect on web.
- A “plugin is not exposed” response alone does not identify the cause. Check endpoint health, authenticated `tools/list` and a read call, then inspect the failing chat’s tool trace. Installation, enabled skills, and a successful **Try now** launch do not prove tools reached that chat. Do not assume reinstalling, a missing `.app.json`, or restarting fixes it.
- Enterprise domain restrictions are unavailable until OIDC userinfo/email scopes exist (host warning only; PocketCircle does not rely on them).
- After changing Worker tool annotations, redeploy the MCP Worker and re-run portal **Scan Tools** so the draft submission matches production.

## Validate package files

```sh
node plugins/pocketcircle/assert-package.mjs
```

## Spending review

The spending-review skill separates personal Paid By totals from Circle totals, honors saved Home Summary exclusions, keeps currencies separate, and requires complete cursor pagination before calculating from search results. It reports only the Circles authorized by the current connection.

## Recording validation

The recording skill uses existing create tools with default previews, applicable User overrides, sequential batches, and explicit handling of partial or uncertain outcomes. Run the [reviewer cases](recording-reviewer-cases.md) in both installed hosts after refreshing the package. Server-guidance changes also require Worker deployment and metadata refresh. Automated backend checks establish tool behavior, not host compliance with the skill.

For archived-record edits, run the [management retests](management-retest-prompts.md). The shared write skill now covers existing records too; its lifecycle clarification is host guidance, not server-enforced approval.
