# robots.txt for a product SPA (PocketCircle)

Research date: 2026-09-06. Scope: few public crawlable pages (`/`, `/privacy`, `/terms` + sitemap of those) vs many auth/account SPA routes. Primary sources only (Google Search Central, RFC 9309, Cloudflare first-party for hosting notes, live product `robots.txt` as examples).

## Verdict

**Keep a short selective `Disallow` list for app prefixes + `Sitemap:` pointing at the public-only sitemap.** That is crawl control for unimportant URLs, not security. Long `Disallow` lists are normal at scale; for PocketCircle a dozen prefixes is fine and not an anti-pattern. Do **not** treat omit-from-sitemap alone as enough. Do **not** rely on robots.txt to hide private data — auth does that.

Preferred shape for `apps/web-app/public/robots.txt`:

```txt
User-agent: *
Allow: /
Disallow: /signin
Disallow: /invite
Disallow: /delete-account
Disallow: /home
Disallow: /onboarding
Disallow: /settings
Disallow: /connections
Disallow: /whats-new
Disallow: /feedback
Disallow: /mcp
Disallow: /transactions
Disallow: /circles
Disallow: /dev

Sitemap: https://pocketcircle.app/sitemap.xml
```

Redundant `Allow: /privacy` / `Allow: /terms` lines are optional noise (implicit allow already covers them). Prefer trailing `/` on directory-like prefixes when you mean “and everything under” (Google path matching: `/fish` also matches `/fishheads`; `/fish/` is folder-scoped). ([Google robots.txt path matching](https://developers.google.com/search/docs/crawling-indexing/robots/robots_txt))

**Production watch:** live `https://pocketcircle.app/robots.txt` currently returns Cloudflare managed AI-bot block preamble, then **SPA HTML**, not the static file from `public/`. Origin must serve real `text/plain` for `/robots.txt` (no SPA fallback) or Search gets garbage after the CF prepend. ([Cloudflare managed robots.txt merge](https://developers.cloudflare.com/bots/additional-configurations/managed-robots-txt/))

---

## 1. What robots.txt is for (and not for)

| Claim | Source |
| --- | --- |
| robots.txt tells crawlers which URLs they **may access**. Primary use: **manage crawler traffic** / avoid overloading the site | [Google: Intro to robots.txt](https://developers.google.com/search/docs/crawling-indexing/robots/intro) |
| Explicitly **not** a way to keep a page out of Google Search. For that: **`noindex`** or **password-protect** | Same intro |
| Disallowed pages: Google won’t crawl/index **content**, but URL can still appear in results (no snippet) if linked elsewhere | Same intro · [Google: how Google interprets REP](https://developers.google.com/search/docs/crawling-indexing/robots/robots_txt) (`disallow` section) |
| Instructions are **voluntary**; disrespectful crawlers ignore them. For secrets: auth / access control, not robots.txt | Intro limitations · [RFC 9309 §1](https://www.rfc-editor.org/rfc/rfc9309.html): “These rules are not a form of access authorization.” · [Cloudflare](https://developers.cloudflare.com/bots/additional-configurations/managed-robots-txt/): compliance voluntary |
| Default if no matching disallow: **crawl allowed**. Empty/missing robots.txt → no crawl restrictions (for Google: `4xx` on robots.txt ≈ no restrictions) | [Create robots.txt](https://developers.google.com/search/docs/crawling-indexing/robots/create-robots-txt) · [Google status handling](https://developers.google.com/search/docs/crawling-indexing/robots/robots_txt) · [RFC 9309 §2.2.2](https://www.rfc-editor.org/rfc/rfc9309.html) |
| Valid use for HTML pages: avoid crawling **unimportant or similar** pages / manage load | [Intro file-type table](https://developers.google.com/search/docs/crawling-indexing/robots/intro) |
| Google: if you don’t need to distinguish crawl vs index block, use robots.txt for **broader** site sections, page-level (`noindex` / `X-Robots-Tag`) for **individual** pages | [Robots refresher (2025)](https://developers.google.com/search/blog/2025/03/robots-refresher-page-level) |

### What NOT to rely on robots.txt for

- **Security / privacy of account data** — RFC 9309 + Google: not authorization; use login. Malicious bots can treat `Disallow` as a map.
- **Guaranteed removal from Search** — disallowed URL may still list with no description if linked. Use password-protect or crawlable `noindex`. ([Intro](https://developers.google.com/search/docs/crawling-indexing/robots/intro) · [Block indexing](https://developers.google.com/search/docs/crawling-indexing/block-indexing))
- **Making `noindex` work while also Disallowing** — if crawl is blocked, Google never sees meta/`X-Robots-Tag`. ([Robots meta + robots.txt](https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag#combining-robots.txt-rules-with-indexing-and-serving-rules) · [Block indexing debug](https://developers.google.com/search/docs/crawling-indexing/block-indexing))
- Putting `noindex` **inside** robots.txt — **not supported** by Google. ([Block indexing](https://developers.google.com/search/docs/crawling-indexing/block-indexing))

---

## 2. Auth-gated / app areas: options

| Approach | Crawl | Index control | Fit for PocketCircle SPA shells |
| --- | --- | --- | --- |
| **A. `Disallow` each app prefix** | Blocked | Content not crawled; URL *might* still appear if linked | **Good.** Matches Google’s “avoid unimportant pages.” Thin login shells waste crawl. Repo already does this. |
| **B. Disallow nothing; rely on auth + optional `noindex`** | Allowed | Auth hides data; `noindex` needs a crawlable response that includes the tag/header | OK if shells are cheap and you want `noindex` to fire. Crawler still hits SPA HTML/JS. Auth alone ≠ “don’t crawl.” |
| **C. Allow everything; omit app URLs from sitemap only** | Allowed if discovered via links | Sitemap is a **hint** of preferred URLs, not a crawl deny list | **Insufficient alone.** Google discovers via links; sitemap omission ≠ Disallow. ([Sitemaps overview](https://developers.google.com/search/docs/crawling-indexing/sitemaps/overview) · [Build sitemap](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap)) |
| **D. `Disallow: /` + selective `Allow` for public paths** | Only allowed paths | Strong “public-only crawl” fence | Valid (Google documents `Allow: /$` + `Disallow: /`). Brittle as public routes grow (`/support`, etc.). Must allow assets Google needs to render public pages if you care about rendering. ([Path precedence examples](https://developers.google.com/search/docs/crawling-indexing/robots/robots_txt) · [Intro: don’t block needed JS/CSS](https://developers.google.com/search/docs/crawling-indexing/robots/intro)) |

Google’s own framing: **sitemap = which content to crawl (preference)**; **robots.txt = which content can/cannot be crawled**. ([Create robots.txt — `sitemap:` rule](https://developers.google.com/search/docs/crawling-indexing/robots/create-robots-txt))

For login-gated product UIs that serve useless shells to bots: **A** (or **D** if you want a hard allowlist) is the crawl-budget-aligned choice. **B** only if you specifically need crawlers to read `noindex` on those URLs.

---

## 3. robots.txt ↔ sitemap.xml (Google)

- Declare sitemap with absolute URL in robots.txt: `Sitemap: https://example.com/sitemap.xml`. Not tied to a user-agent; discovery mechanism for compliant crawlers. ([Create robots.txt](https://developers.google.com/search/docs/crawling-indexing/robots/create-robots-txt) · [Google REP `sitemap` field](https://developers.google.com/search/docs/crawling-indexing/robots/robots_txt) · [Build & submit sitemap](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap))
- Submitting via Search Console is optional extra (status/errors); robots.txt listing is enough for discovery if no GSC owner. ([Sitemaps report](https://support.google.com/webmasters/answer/7451001))
- Sitemap should list URLs you **want** in results / prefer as canonicals — PocketCircle’s 3-URL sitemap matches that. ([Build sitemap](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap) · [Overview](https://developers.google.com/search/docs/crawling-indexing/sitemaps/overview))
- Don’t block the sitemap file itself with robots.txt (GSC error: sitemap blocked). ([Sitemaps report errors](https://support.google.com/webmasters/answer/7451001))
- Conflict: URLs in sitemap that are **Disallow**ed → Google can’t fetch them; GSC reports “Sitemap contains urls which are blocked by robots.txt.” Keep public-only sitemap and Disallow app paths — no conflict if lists don’t overlap. (Same help doc)
- Removing a sitemap from GSC does **not** make Google forget listed URLs; to stop visits use robots.txt (or delete/`noindex`). ([Sitemaps report — delete](https://support.google.com/webmasters/answer/7451001))

---

## 4. Are long `Disallow` lists an anti-pattern?

**No.** Spec and Google support many path rules; 500 KiB file size is the practical ceiling — Google suggests consolidating into directories if oversized. ([Google file size](https://developers.google.com/search/docs/crawling-indexing/robots/robots_txt))

Live examples (fetched 2026-09-06; examples, not gospel):

| Site | Pattern |
| --- | --- |
| [github.com/robots.txt](https://github.com/robots.txt) | Very long `Disallow` lists (UI noise, search, archives, etc.) |
| [www.dropbox.com/robots.txt](https://www.dropbox.com/robots.txt) | Many account/share/static path Disallows + Sitemap |
| [slack.com/robots.txt](https://slack.com/robots.txt) | Selective Disallows + Sitemaps |
| [www.notion.so/robots.txt](https://www.notion.so/robots.txt) | `Allow: /` + selective Disallows (invite, embed, …) + many Sitemaps |
| [linear.app/robots.txt](https://linear.app/robots.txt) | Minimal: mostly `Disallow: /api/` + Sitemap |
| [app.asana.com/robots.txt](https://app.asana.com/robots.txt) | Named search bots `Allow: /`; `User-agent: *` → `Disallow: /` (public allowlist via UA) |

Feeling that “listing many Disallows is wrong” is aesthetic, not standards-backed. PocketCircle’s ~12 prefixes is tiny vs GitHub/Dropbox.

---

## 5. PocketCircle current setup

**In repo** (`apps/web-app/public/robots.txt`): selective Disallows for app prefixes + Sitemap — aligned with Google “unimportant pages” guidance.

**Sitemap** (`public/sitemap.xml`): only `/`, `/privacy`, `/terms` — correct complementary hint.

**Hosting:** Cloudflare Workers static assets (ADR 0007). Zone may enable **managed robots.txt**, which **prepends** AI-crawler Disallows + Content-Signal, then appends origin body. ([Cloudflare managed robots.txt](https://developers.cloudflare.com/bots/additional-configurations/managed-robots-txt/))

**Live bug risk:** origin after CF block is currently HTML (SPA), so custom Disallows/`Sitemap:` may not be reaching crawlers until `/robots.txt` is a real static asset with `200` `text/plain`. Fix deploy/fallback first; keep the selective Disallow content.

---

## Suggested content options (tradeoffs)

### Option 1 — Minimal allow-all + Sitemap (smallest file)

```txt
User-agent: *
Allow: /

Sitemap: https://pocketcircle.app/sitemap.xml
```

| Pros | Cons |
| --- | --- |
| Tiny; Google’s default example shape | Crawlers may fetch SPA shells for `/circles/…` etc. if linked |
| Fine for tiny sites / low link surface | Omitting from sitemap doesn’t stop discovery |

### Option 2 — Selective Disallow (recommended)

Current repo approach (trim redundant `Allow: /privacy` / `/terms`).

| Pros | Cons |
| --- | --- |
| Matches Google “unimportant pages” use | Must update when new app prefixes ship |
| Saves crawl on login shells | Disallowed URLs can still appear as bare URLs if heavily linked |
| Plays well with public-only sitemap | Won’t hide secrets by itself |

### Option 3 — Disallow-all + Allow public only

```txt
User-agent: *
Disallow: /
Allow: /$
Allow: /privacy
Allow: /terms

Sitemap: https://pocketcircle.app/sitemap.xml
```

(Exact precedence: longer / least-restrictive wins per Google; verify with [Google’s path examples](https://developers.google.com/search/docs/crawling-indexing/robots/robots_txt) / tester.)

| Pros | Cons |
| --- | --- |
| Default-deny for unknown future app routes | Easy to forget new public routes (`/support`) |
| Explicit public surface | May block assets under other paths if public pages need them for rendering |
| | Slightly harder to reason about than Option 2 for this app |

### Option 4 — Allow crawl of app routes + `noindex` / auth only

No Disallows for product paths; ensure authenticated responses and/or crawlable `noindex`/`X-Robots-Tag` on shells.

| Pros | Cons |
| --- | --- |
| `noindex` can actually be seen | Wastes crawl; SPA shells still fetched |
| | Must implement headers/meta correctly on those routes |

---

## PocketCircle recommendation (summary)

1. **Keep Option 2** (selective Disallow + public Sitemap). Feeling that listing prefixes is “wrong” is unfounded — it’s the intended crawl-control tool.
2. **Auth** remains the security boundary; robots.txt is crawl preference only.
3. Keep **sitemap public-only**; never list `/circles/…` there.
4. Ensure **static `robots.txt` actually deploys** (live CF+HTML issue). Expect Cloudflare managed preamble to prepend if that zone setting stays on — compatible with custom Disallows when origin body is real text.
5. Skip Option 3 unless unknown future app paths become a maintenance pain; skip Option 1 unless crawl of shells is proven harmless and you want zero maintenance.

---

## Primary sources

- [Google Search Central — Intro to robots.txt](https://developers.google.com/search/docs/crawling-indexing/robots/intro)
- [Google — Create and submit robots.txt](https://developers.google.com/search/docs/crawling-indexing/robots/create-robots-txt)
- [Google — How Google interprets robots.txt / REP](https://developers.google.com/search/docs/crawling-indexing/robots/robots_txt)
- [Google — Block indexing (`noindex`)](https://developers.google.com/search/docs/crawling-indexing/block-indexing)
- [Google — Robots meta / X-Robots-Tag](https://developers.google.com/search/docs/crawling-indexing/robots-meta-tag)
- [Google — Robots refresher: page-level (2025)](https://developers.google.com/search/blog/2025/03/robots-refresher-page-level)
- [Google — Sitemaps overview](https://developers.google.com/search/docs/crawling-indexing/sitemaps/overview)
- [Google — Build and submit a sitemap](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap)
- [Search Console Help — Sitemaps report](https://support.google.com/webmasters/answer/7451001)
- [RFC 9309 — Robots Exclusion Protocol](https://www.rfc-editor.org/rfc/rfc9309.html)
- [Cloudflare — Managed robots.txt](https://developers.cloudflare.com/bots/additional-configurations/managed-robots-txt/)
- Example fetches: GitHub, Dropbox, Slack, Notion, Linear, Asana, live `pocketcircle.app/robots.txt` (2026-09-06)
