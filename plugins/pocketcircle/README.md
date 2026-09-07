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
2. Bump `version` in `.codex-plugin/plugin.json` when you want a visible package bump.
3. Restart ChatGPT desktop so the local cache reloads (`~/.codex/plugins/cache/…/pocketcircle/local/`).
4. In an open plugin detail pane, use **Refresh** if the host shows one, then start a new chat so tools/skills rediscover.

## Connection / revoke

- Manage grants at https://pocketcircle.app/connections (revoke, reconnect, Circle selection).
- Re-consent after revoke or when a new Circle should become visible.
- Raw MCP URL (Dev Mode connector) still works; the package is the installable wrapper around the same server.

## Observed host notes

- ChatGPT Dev Mode connection ids look like `asdk_app_…` / `asdk_app_v_…`. `.app.json` must use the real **App Id**, not an invented value.
- Codex and ChatGPT share the plugin package shape; surfaces differ for marketplace browsing.
- ChatGPT **web** cannot install from a local marketplace — use desktop for package install, or Dev Mode URL connect on web.
- Enterprise domain restrictions are unavailable until OIDC userinfo/email scopes exist (host warning only; PocketCircle does not rely on them).
- After changing Worker tool annotations, redeploy the MCP Worker and re-run portal **Scan Tools** so the draft submission matches production.

## Validate package files

```sh
node plugins/pocketcircle/assert-package.mjs
```

## Out of scope here

Spending-summary skills, write-confirmation skills, public submission, and shipping `/support` live in later issues (#366–#371 / #369).
