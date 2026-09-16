# Announcement card: hero media, icon bullets, and post-load motion

> **Pre-implementation research snapshot (2026-09-15).** Technical constraints for
> enriching the Feature Announcement card (#334, #352) with R2-hosted hero media
> (image/video), up-to-3 icon bullet rows, and a post-page-load entrance animation.
> Fixed maintainer constraints (hard-coded catalog, no "Learn more" link, media on
> `assets.pocketcircle.app`, animate after load, Cursor's hero+highlights pattern)
> are treated as settled and not re-litigated. Primary sources only.

Research date: 2026-09-15. External claims cite MDN, WHATWG/W3C/CSSWG specs, WebKit,
web.dev, Cloudflare, and lucide official docs. Repo claims cite `file:line`.

## Verdict

All four enrichments are buildable on the current stack with **no new dependency**
and **no runtime config**, but two hard constraints collide with documented platform
limits and need an explicit fallback baked in:

1. **Autoplay is never guaranteed.** Even with every required attribute, iOS Low
   Power Mode and Android/desktop Data Saver (`prefers-reduced-data`) will refuse to
   autoplay and `play()` rejects. A `poster` still image is the mandatory fallback,
   and reduced-motion must not loop. → Q1.
2. **The enriched card will not fit a small phone without an overflow strategy.** A
   22 rem card + 16:9 media + 3 bullet rows + header + CTA computes to ~**520–560 px**
   tall, which exceeds the usable height of a 667 px-tall iPhone SE once the bottom
   nav + safe areas are subtracted. The card must cap its height with `svh`/`dvh` and
   make its body scrollable. → Q5.

Everything else is clean: R2 custom-domain delivery needs **no CORS** for plain
`<img>`/`<video>` and is CDN-cached with free egress (Q2); Workers assets-only
Workers **do** support a `_headers` file for future CSP (Q2); a `requestIdleCallback`
+ reduced-motion-gated `transform`/`opacity` entrance does **not** hurt CLS on a
fixed element and can reuse the repo's existing keyframes (Q3); lucide's own docs
say **static named imports** are the tree-shakable, recommended path for a hard-coded
catalog and icons ship `aria-hidden` by default (Q4). The changelog parser exposes
nothing an announcement should reuse, but the `/dev/email-preview` route is the exact
pattern a `/dev` announcement preview should copy (Q6).

## Recommendation table

| # | Question | Recommendation | Key source |
| --- | --- | --- | --- |
| 1 | Autoplay video | `autoplay loop muted playsinline` + `poster` + `preload="metadata"`; feature-detect via `play()` promise `catch`; render `poster`/animated image on reject; never `loop` under reduced-motion | [WebKit](https://webkit.org/blog/6784/new-video-policies-for-ios/), [MDN Autoplay](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay) |
| 2 | R2 custom domain | Public bucket + Custom Domain (not `r2.dev`); no CORS for `<img>`/`<video>`; set `Content-Type` on upload + `Cache-Control: public, max-age=31536000, immutable` on versioned filenames; CDN-cached by default, egress free; MP4-on-Safari needs strong-ETag cache rule; `_headers` supports future CSP `media-src`/`img-src` | [R2 public buckets](https://developers.cloudflare.com/r2/data-access/public-buckets/), [Workers `_headers`](https://developers.cloudflare.com/workers/static-assets/headers/) |
| 3 | Post-load entrance | `requestIdleCallback` (fallback `setTimeout`) after the Convex query settles → toggle a class animating `transform`/`opacity`; gate with `usePrefersReducedMotion()`; reuse `--animate-slide-up`/`pop-in` | [web.dev CLS](https://web.dev/articles/cls), [MDN reduced-motion](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-motion) |
| 4 | Icon bullets | Static named imports (`import { Zap } from "lucide-react"`); store the imported component (not a name string) in the catalog; icons are `aria-hidden` by default — leave them so beside a visible title | [lucide dynamic-icon caveats](https://lucide.dev/guide/react/advanced/dynamic-icon-component), [lucide a11y](https://lucide.dev/guide/react/advanced/accessibility) |
| 5 | Size/overflow | Cap card at `max-h-[min(...,100svh-insets)]`, make the content region `overflow-y-auto`; keep it keyboard-reachable | [MDN viewport units](https://developer.mozilla.org/en-US/docs/Web/CSS/length#relative_length_units_based_on_viewport), [CSSWG css-values](https://drafts.csswg.org/css-values/#lengths) |
| 6 | Where content lives | Keep the hard-coded catalog; changelog parser exposes nothing reusable; add a `/dev/announcement-preview` route mirroring `/dev/email-preview`; widen the `FeatureAnnouncement` interface + move the `needsSource`/CTA branching off the `id ===` string checks | `apps/web-app/app/routes/dev/email-preview.tsx:1-19`, `apps/web-app/app/lib/feature-announcements.ts:39-56` |

---

## Q1 — Autoplay video in the card

### Mandatory attributes (all required together)

WebKit's iOS policy is explicit: a `<video>` autoplays without a user gesture only
if it has **no audio track or is `muted`**, and on iPhone it plays inline only with
**`playsinline`** (otherwise it forces fullscreen). Autoplay video also **only begins
when on-screen** and **pauses when scrolled off-screen**. ([WebKit, "New `<video>`
Policies for iOS"](https://webkit.org/blog/6784/new-video-policies-for-ios/)). The
canonical markup from that post is:

```html
<video autoplay loop muted playsinline poster="…">
  <source src="image.mp4" type="video/mp4">
  <img src="image.gif" alt="…">
</video>
```

MDN's autoplay guide confirms muted/inaudible media is exempt from autoplay blocking,
and that `playsinline` "is required for autoplay in Safari."
([MDN Autoplay guide](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay)).
So the required set is: **`autoplay` + `muted` + `playsinline`** (add `loop` for a UI
loop). If the audio track becomes unmuted without a gesture, WebKit pauses playback.

### What still blocks autoplay even when all attributes are present

MDN: media autoplays only if *at least one* of {muted/volume 0, prior user
interaction, allowlisted by engagement, autoplay Permissions-Policy grant} is true —
and "Browsers may additionally choose to block under other circumstances."
([MDN Autoplay guide, "Autoplay availability"](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay)).
Documented additional blockers relevant here:

- **iOS Low Power Mode** — WebKit's policy is that muted inline video autoplays, but
  Low Power Mode is a device power state that suppresses autoplay; this is not
  overridable from the page. Treat it as an unconditional "may not autoplay."
- **Data Saver / reduced-data** — the platform signal is the `prefers-reduced-data`
  media feature; when a user opts into data saving the correct behavior is to *not*
  download/autoplay video. ([MDN `prefers-reduced-data`](https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-data)).
- **Background/hidden tab** — autoplay is withheld until the tab is foregrounded
  (Firefox `media.block-autoplay-until-in-foreground` default `true`;
  [MDN Autoplay, Browser configuration](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay)).
- **Per-site autoplay settings** — user/browser preferences can disallow autoplay for
  the origin ([MDN Autoplay, Browser configuration options](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay)).

> ⚠️ **Constraint collision.** "Video hero that autoplays to draw attention" cannot be
> guaranteed. The card must render acceptably as a still image when autoplay is
> denied. This is a platform limitation, not an implementation gap.

### Correct fallback when `play()` rejects

MDN prescribes exactly this: `play()` returns a Promise; `.catch()` a
`NotAllowedError` and present a poster/placeholder or a manual control instead of
assuming playback.
([MDN Autoplay, "Handling play() failures"](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay)).
Because this card must not steal focus and carries no controls, the correct fallback
is the **`poster` frame** (a representative still), not a play button:

```js
const p = videoEl.play();
if (p !== undefined) p.catch(() => { /* leave poster showing; do not add controls */ });
```

`navigator.getAutoplayPolicy("mediaelement")` can pre-check (`allowed` /
`allowed-muted` / `disallowed`) where supported, letting the card decide poster-vs-play
before attempting; MDN recommends checking on load.
([MDN `Navigator.getAutoplayPolicy()`](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/getAutoplayPolicy)).

### `poster`, `preload`, `playsinline` per the sources

- **`poster`** — MDN uses it as the documented placeholder for the disallowed case.
  Set it to a still frame so the card looks correct before/without playback.
- **`preload="metadata"`** — the appropriate value for a decorative loop: fetch enough
  to start, not the whole file. (`<video>` `preload` values are `none`/`metadata`/`auto`;
  [MDN `<video>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/video)).
  There is no first-party guarantee `preload` is honored (Safari historically treats it
  as a hint), so do not rely on it for correctness — only as a bandwidth hint.
- **`playsinline`** — required for inline autoplay on iPhone (both sources above).

### Encoding / format (first-party guidance)

WebKit's post is the first-party recommendation: it explicitly moved GIF-style
animations to **H.264 MP4** `<video>`, citing GIF being "up to twelve times as
expensive in bandwidth and twice as expensive in energy," and its example lists
`image.mp4` first with `image.webm` and a GIF `<img>` as ordered fallbacks.
([WebKit](https://webkit.org/blog/6784/new-video-policies-for-ios/)). For a short muted
UI loop that must play on iOS Safari, **H.264/AAC MP4 is the safe primary**, with WebM/VP9
as a `<source>` fallback for engines that prefer it. There is no first-party source
recommending AV1 for this UI-loop use case with iOS as a target; do not assume iOS AV1
support. MDN's codec guides describe tradeoffs but issue no "use X for UI loops" ruling
([MDN Web video codec guide](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Video_codecs)).

**Animated image alternative (WebP/AVIF vs video):** WebKit's own framing is that video
replaced animated GIF for energy/bandwidth reasons; the same energy argument applies to
large animated WebP/AVIF. No authoritative source says animated WebP/AVIF beats a muted
H.264 loop for a hero. Given autoplay is unreliable anyway (above), **an animated image
is the more robust choice if motion is essential and must always play**, because it is
not subject to the media-element autoplay policy — at the cost of larger files and no
`prefers-reduced-motion` pause. State this tradeoff to the maintainer rather than
guessing a winner.

### `prefers-reduced-motion` obligation

web.dev instructs: "Be sure to respect `prefers-reduced-motion` browser settings, as
some site visitors can experience ill effects or attention issues from animation."
([web.dev CLS](https://web.dev/articles/cls)). For an autoplaying **looping** video
this means: under `(prefers-reduced-motion: reduce)`, do **not** autoplay/loop — show
the `poster` still instead. The repo already has a global reduced-motion reset
(`apps/web-app/app/app.css:110-121`) and a reactive hook `usePrefersReducedMotion()`
(`apps/web-app/app/lib/motion.ts:23-24`) to gate the video element. Note the CSS reset
only freezes CSS animations/transitions — it does **not** stop a `<video autoplay>`, so
the video must be gated in JS via the hook.

---

## Q2 — R2 custom-domain delivery

### CORS is not needed for plain `<img>`/`<video>`

Cloudflare: "Only a cross-origin request will include CORS response headers. A
cross-origin request is identified by the presence of an `Origin` HTTP request header."
Plain `<img src>` / `<video src>` embeds do **not** send `Origin` and are **not**
subject to CORS — CORS is only "used when you interact with a bucket from a web browser"
via script (fetch/XHR) or when you set `crossorigin` on the element.
([R2 Configure CORS](https://developers.cloudflare.com/r2/buckets/cors/)). So for a
hero `<img>`/`<video>` with no `crossorigin` attribute, **no CORS policy is required**.
CORS becomes necessary only if the card later reads pixels (`<canvas>`, WebGL) or
fetches the asset via JS — then add an `AllowedOrigins` policy listing
`https://pocketcircle.app` and, if needed, `ExposeHeaders`.

### Content-Type and Cache-Control on R2 objects

R2 objects carry an `httpMetadata` (Content-Type, Cache-Control, etc.) set at upload
time (via the S3/Workers API, `wrangler r2 object put`, or dashboard). For a public
bucket on a Custom Domain the response returns the object's stored `Content-Type` and
`Cache-Control`. Cloudflare's own guidance for **fingerprinted (hashed) filenames** is
the aggressive-immutable pattern:

```
Cache-Control: public, max-age=31556952, immutable
```

(shown verbatim in the Workers `_headers` doc for "a folder of fingerprinted assets";
[Workers `_headers`, "Configure custom browser cache behavior"](https://developers.cloudflare.com/workers/static-assets/headers/)).
For R2 you set this on the object's Cache-Control metadata rather than `_headers` (the
`_headers` file governs the Worker's own static assets, not R2). **Versioned filenames**
(e.g. `announcement-mcp-hero.v1.mp4`) are the recommended way to make assets immutable
and long-cached — change the filename to bust cache instead of purging.

### CDN caching by default + egress/billing

Attaching a **Custom Domain** to the bucket routes requests through Cloudflare's cache:
"requests for your stored files go through Cloudflare's cache instead of hitting R2
directly every time." ([Enable cache in an R2 bucket](https://developers.cloudflare.com/cache/interaction-cloudflare-products/r2/)).
Caveat: **only certain file types are cached by default** — HTML/JSON are not cached
without a Cache Rule ([same doc, "Default cached file types"]). Images and video files
served with correct extensions/Content-Type are cached by default, but confirm with a
Cache Everything rule if a type misses. The `r2.dev` development URL "does not support
caching, WAF, or bot management" — so **must use the custom domain** `assets.pocketcircle.app`,
which is already the plan.

Egress: R2 charges **no egress/data-transfer fees** for any storage class, including via
custom domain — "There are no charges for egress bandwidth."
([R2 Pricing](https://developers.cloudflare.com/r2/pricing/)). Costs are storage
($0.015/GB-mo, 10 GB-mo free) and Class B `GetObject` reads ($0.36/M, 10M free); with
Cloudflare caching in front, cache HITs don't count as R2 Class B ops. For a handful of
small hero assets this is effectively free.

### MP4-on-Safari caching caveat (directly relevant)

Cloudflare documents a Safari-specific bug: when MP4s are proxied through Cloudflare
cache, Safari's range-request/ETag handling can make videos fail or show a black screen.
The fix is a cache rule that **turns on "Respect strong ETags" for `*.mp4`** (plus, if
needed, a bypass rule ordered after it).
([Issues with MP4 videos on iOS and Safari](https://developers.cloudflare.com/cache/troubleshooting/mp4-videos-on-ios-and-safari/)).
→ ⚠️ If the hero is an MP4 served from R2 custom domain, plan this cache rule; otherwise
iOS Safari (the exact platform the autoplay work targets) may not play it.

### CSP later + Workers assets `_headers`

The app has **no CSP today** (confirmed: `wrangler.jsonc:1-16` is assets-only, no
headers). If CSP is added later, embedding media from `assets.pocketcircle.app` requires
adding that origin to **`img-src`** (images) and **`media-src`** (video), plus
`default-src` if those aren't set. Example directive fragment:

```
img-src 'self' https://assets.pocketcircle.app;
media-src 'self' https://assets.pocketcircle.app;
```

**Workers static-assets (assets-only Worker, no `main`) supports a `_headers` file** to
set CSP: "The default response headers served on static asset responses can be
overridden, removed, or added to, by creating a plain text file called `_headers`
without a file extension, in the static asset directory of your project," with an
explicit `Content-Security-Policy` example.
([Workers Static Assets → Headers](https://developers.cloudflare.com/workers/static-assets/headers/)).
Caveat from that same doc: `_headers` rules do **not** apply to responses generated by
Worker code — but this repo has no `main`, so `_headers` is the correct and sufficient
CSP mechanism. The file would live in the assets directory (`apps/web-app/build/client`
per `wrangler.jsonc:11-14`); author it in the source `public/`-style location so the
build copies it.

---

## Q3 — Post-load entrance animation

### "After the page has loaded" signal for a Convex-gated SPA

The card renders only after the session is `ready` and (for source-backed campaigns)
after a Convex query settles — see the `visible`/`liveVisible` gating in
`apps/web-app/app/components/feature-announcement-card.tsx:63-77`. So the meaningful
"loaded" moment is **when the card's own data has settled and it first becomes
genuinely visible**, not the `window` `load` event (which fires on initial document
load, long before a client-side Convex query resolves in an SPA).

Primary-source-backed options, ranked for this case:

1. **`requestIdleCallback` (preferred)** — schedule the entrance one idle tick after the
   card mounts visible, so the animation starts after React has committed and the browser
   is idle, "drawing attention" without competing with settle work. `requestIdleCallback`
   is the documented primitive for running work after the browser finishes critical work;
   fall back to `setTimeout` where unsupported (Safari).
   ([MDN `requestIdleCallback`](https://developer.mozilla.org/en-US/docs/Web/API/Window/requestIdleCallback)).
2. **Short `setTimeout`** — a documented, universally-supported fallback; a small delay
   (e.g. one frame or ~100 ms) after mount is adequate and is what the repo's marketing
   "first-visit motion" effectively does via CSS `both` fill.
3. **`window` `load` event** — wrong signal here: in an SPA it has usually already fired
   before the Convex query resolves, so it would fire the animation too early or not at
   all relative to the card. ([MDN `load` event](https://developer.mozilla.org/en-US/docs/Web/API/Window/load_event)).
4. **View Transitions** — designed for animating *between* DOM/route states, not for a
   one-shot entrance of a newly-mounted fixed card; overkill and not the documented use
   case here. ([MDN View Transition API](https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API)).

The simplest correct implementation: on the render where `liveVisible` first becomes
true, `requestIdleCallback(() => setEntered(true))` and toggle a CSS class that runs a
`transform`/`opacity` keyframe. Reuse `useValueChange` (ADR 0025 §4;
`apps/web-app/app/lib/use-value-change.ts`) to detect the false→true transition without
an effect-driven stale frame.

### Does an entrance on a `position: fixed` element hurt CLS?

No, if done with `transform`/`opacity`. web.dev's CLS definition: a layout shift is
scored only when an **already-visible element changes its start position** between
frames; "If a new element is added to the DOM … it doesn't count as a layout shift — as
long as the change doesn't cause other visible elements to change their start position."
([web.dev CLS](https://web.dev/articles/cls)). The announcement card is newly mounted
and `position: fixed` (out of flow;
`apps/web-app/app/components/feature-announcement-card.tsx:130-138`), so it does not push
sibling content and its appearance is not a shift. Critically, web.dev says: "CSS
`transform` property lets you animate elements **without triggering layout shifts** …
use `transform: scale()` … use `transform: translate()` instead" of animating
`top/left/width/height`. So a translate/opacity/scale entrance is CLS-safe; animating
box-model properties (`top`, `height`, margins) would not be.

### transform/opacity vs other properties + reduced motion

web.dev (above) is the primary source to **animate only `transform` and `opacity`** for
visual moves. `prefers-reduced-motion` obligation is the same as Q1: web.dev's CLS
article explicitly says respect it. The repo already encodes both:

- Global reduced-motion reset collapses all CSS animations to ~0 ms, unlayered so it
  out-cascades Tailwind utilities (`apps/web-app/app/app.css:110-121`) — an entrance
  built on a Tailwind `--animate-*` utility is automatically neutralized under reduced
  motion with no extra code.
- Existing keyframes to **reuse rather than reinvent**: `--animate-slide-up`
  (`slide-up`, translateY(8px)+opacity, 250 ms) and `--animate-pop-in`
  (translateY(-4px)+scale(.97)+opacity, 180 ms), both on `--ease-out-quart`
  (`apps/web-app/app/app.css:157-186`). One of these covers the "draw attention"
  entrance; no new keyframe is needed. `--animate-marketing-enter` exists for rare
  first-visit motion (`app.css:222-233`) if a longer 520 ms entrance is wanted.
- ADR 0032 sets the motion budget/easing conventions (fast, ~150–250 ms, `ease-out`)
  and mandates gating via `usePrefersReducedMotion()` from `~/lib/motion.ts`, **not**
  NumberFlow's export (`docs/adr/0032-…:` motion budget table; `motion.ts:14-24`).
- ADR 0025 says React Compiler owns memoization and to react to committed value changes
  with `useValueChange`, not `useEffect([value])` (which "runs after paint and shows a
  stale frame") — use it for the visible→animate transition.

---

## Q4 — Icon bullets

### Named imports vs DynamicIcon (lucide's own guidance)

lucide-react's overview lists **"Tree-shakable – Only the icons you import are included
in your final bundle"** as a headline feature, i.e. static named imports are the
tree-shaking path.
([lucide-react overview](https://lucide.dev/guide/packages/lucide-react)). Its
DynamicIcon page is explicit that the dynamic path is the opposite: "It is possible to
use one generic icon component to load icons. But it is **not recommended**, since it is
importing **all icons during the build**," with caveats that it increases build time,
creates a module per icon (more network requests), can flash on load, and needs SSR
care. DynamicIcon is "useful for applications that want to show icons dynamically by icon
name … from a database. **For static use cases, it is recommended to import the icons
directly.**"
([lucide DynamicIcon](https://lucide.dev/guide/react/advanced/dynamic-icon-component)).

**Given the maintainer's hard-coded catalog, lucide's docs favor static named imports.**
Store the *imported component reference* in the catalog, not a name string:

```ts
import { Zap, ShieldCheck, Sparkles } from "lucide-react";
// highlights: [{ icon: Zap, title: "…", body: "…" }, …]
```

This keeps the bundle tree-shaken (only the 1–3 icons used ship) and matches how the
repo already imports icons everywhere (e.g. `XIcon` in the card,
`feature-announcement-card.tsx:2`; `ChevronDownIcon` in
`apps/web-app/app/components/ui/accordion.tsx:2`).

### Accessibility of decorative icons beside a text title

Two aligned primary sources:

- **lucide** ships icons with **`aria-hidden="true"` by default**: "In almost all cases
  this is exactly what you want … Only if an icon conveys essential meaning on its own
  should it be made accessible."
  ([lucide React accessibility](https://lucide.dev/guide/react/advanced/accessibility)).
- **W3C WAI** decorative-images tutorial: a decorative image "adds visual decoration …
  rather than to convey information," and should be given a null text alternative /
  hidden from assistive tech so it is not announced.
  ([W3C WAI Decorative Images](https://www.w3.org/WAI/tutorials/images/decorative/);
  [WAI on `aria-hidden` for decorative glyphs](https://www.w3.org/WAI/GL/wiki/Using_a_Decorative_Unicode_Character)).

Since each bullet has a **visible text title next to the icon**, the icon is decorative
(the title already conveys the meaning). **Correct treatment: leave lucide's default
`aria-hidden="true"` — do not add `aria-label`/`title` to the bullet icons.** Adding a
label would create redundant screen-reader output (WAI: text values for decorative
images "add audible clutter"). The existing card already follows this: its
`ChevronDownIcon`/`XIcon` are `aria-hidden` or wrapped in a labelled button
(`accordion.tsx:39-43`, `feature-announcement-card.tsx:150-160`).

---

## Q5 — Card size and overflow on small viewports

### Current card metrics (repo)

`apps/web-app/app/components/feature-announcement-card.tsx:130-172`:

- Width `w-[min(22rem,calc(100vw-1.5rem))]` = 352 px cap.
- Padding `p-4` = 16 px each side (32 px vertical total).
- Header block: uppercase label (~16 px line) + `font-display` base title (~24 px, can
  wrap to 2 lines) + `text-sm` body 2–3 lines (~60 px) with `space-y-1`.
- CTA: `mt-3` (12 px) + `size-sm` button (~32 px).

### Height estimate of the enriched card

Adding a **16:9 hero** at the ~320 px content width (352 − 32 padding) = **180 px tall**,
plus **3 icon bullet rows** (icon + title + body ≈ 56 px each with gaps = ~180 px), on
top of the existing header (~120 px with 2-line title/body) and CTA (~44 px), plus inner
padding (32 px) and inter-block gaps (~24 px):

```
16:9 media (320w)      ≈ 180 px
header (label+title+body) ≈ 120 px
3 bullet rows          ≈ 180 px
CTA + gaps + padding   ≈ 100 px
------------------------------------
total                  ≈ 520–560 px
```

### Compare to small-phone viewport height

An iPhone SE is **375 × 667 CSS px**. The card is fixed at bottom-left and, in Circle
scope, sits **above the bottom nav**: `bottom-[calc(var(--mobile-bottom-nav-height)+0.75rem)]`
where `--mobile-bottom-nav-height` = `4rem + max(0.75rem, safe-area-bottom)` ≈ 76 px
(`feature-announcement-card.tsx:134-137`; `app.css:60-63`). Usable vertical space on a
667 px screen after ~76 px bottom nav + ~12 px gap + top safe area (~24 px on notched
devices, but SE has none) ≈ **~575 px**, and less on shorter devices or when the URL bar
is expanded. A ~520–560 px card leaves almost no margin and **overflows on anything
shorter than an SE, or on the SE when the mobile browser toolbar is expanded.**

> ⚠️ **Constraint collision.** Cursor's hero + 3-highlight layout + the existing 22 rem
> fixed card does **not** fit a small phone without an overflow strategy.

> 🔧 **Final product decision (2026-09-15).** Avoid coupling this transient card to
> the sticky header's height. On short viewports the card may overlap the header and
> paints above it (`z-[35]` versus `z-30`); its height budget reserves only the mobile
> nav, hardware safe areas, and breathing room. This keeps the close button usable
> without introducing a global header-height token or runtime measurement.

### Correct viewport unit + overflow strategy (primary sources)

MDN/CSSWG define three viewport sizes for exactly this dynamic-toolbar problem:
`sv*` (small — assumes toolbars **shown**, "safer," stable), `lv*` (large — toolbars
**retracted**, can be obscured when they show), and `dv*` (dynamic — tracks the current
state, "not stable," can resize during scroll).
([MDN viewport length units](https://developer.mozilla.org/en-US/docs/Web/CSS/length#relative_length_units_based_on_viewport);
[CSSWG css-values-4 §lengths](https://drafts.csswg.org/css-values/#lengths)). MDN warns
plain `vh` currently equals `lvh`, which "could obscure content on a full-page display
while the browser interface is expanded." The repo already prefers `dvh` for `body`
min-height with a documented rationale (`app.css:73-84`).

**Recommendation:** cap the card height against the *small/safe* viewport and scroll its
body:

```
max-height: calc(100svh - var(--mobile-bottom-nav-height) - 1.5rem - var(--safe-area-top));
```

Use `svh` (or a `min()` of `svh`/`dvh`) so the cap holds when the toolbar is shown, and
make the media+bullets region `overflow-y-auto`. Keep the header/CTA outside the scroll
area if you want the CTA always visible, or let the whole card scroll.

### Keyboard reachability of the scrollable region

The card is **non-modal** and must not trap focus (per the settled #282 contract; the
component has no focus trap and no Escape — `feature-announcement-card.tsx` docstring
lines 30-35). A scrollable region inside a non-modal overlay must remain keyboard
operable. Per WAI/ARIA scrollable-region guidance, a container that scrolls but has no
inherently focusable child should be made keyboard-focusable (e.g. `tabindex="0"` with
an accessible name) so keyboard and screen-reader users can scroll it; where the CTA
link and close button are already in the tab order, they provide reachability into the
card. ([WAI-ARIA Authoring Practices](https://www.w3.org/WAI/ARIA/apg/);
[MDN `overflow`](https://developer.mozilla.org/en-US/docs/Web/CSS/overflow) notes scroll
containers). The existing `ModalDialog` handles this by being a focus-trapped modal with
`overflow-y-auto` and `max-h-[85vh]` (`apps/web-app/app/components/ui/dialog.tsx:31-32`),
but the announcement card is deliberately *not* modal, so it must earn keyboard scroll
access without a trap.

---

## Q6 — Better-way check: where the content lives

The maintainer keeps content hard-coded. Reporting factually what already exists that a
hard-coded catalog could lean on (no runtime-config advocacy):

### (a) What the changelog parser exposes

`apps/web-app/app/lib/changelog.ts` parses released `CHANGELOG.md` sections into
`{ version, date, intro[], categories: [{ heading, items[] }] }`
(`changelog.ts:141-189`), rendered by the What's New accordion
(`apps/web-app/app/routes/whats-new.tsx:25-63`). It exposes **plain-text bullet strings
grouped by Keep-a-Changelog category** — no media, no icons, no per-item CTA, no
eligibility. **Nothing here is reusable for an enriched announcement card**: the parser
has no concept of hero media, icon bullets, or a CTA target, and the What's New route is
explicitly "the public What's New archive — formatted CHANGELOG.md, not a launch popup"
(`whats-new.tsx:11`). The two data models don't overlap; an announcement cannot lean on
the changelog parser.

### (b) `/dev` preview route pattern

There **is** an established pattern to copy: `apps/web-app/app/routes/dev/email-preview.tsx`.
It is a dev/E2E-only route gated by a `clientLoader` that throws `404` unless
`import.meta.env.DEV || E2E` (`email-preview.tsx:6-19`), renders sample data from a typed
in-repo catalog (`EMAIL_PREVIEWS`), and offers desktop/mobile width toggles
(`email-preview.tsx:38-41,150-171`). A **`/dev/announcement-preview`** route mirroring
this — same `runEmailPreviewGate`-style 404 gate, iterating `FEATURE_ANNOUNCEMENTS`,
with a phone-width frame to check the Q5 overflow — would follow the existing convention
exactly and is the natural home for previewing media + bullets + entrance motion without
needing an eligible user/route. (README documents `/dev/email-preview` as the model:
"Open `/dev/email-preview` while running the web app in dev.")

### Catalog-shape friction once entries carry media + bullets

The current `FeatureAnnouncement` interface and its branching become awkward as entries
gain media/bullets — evidence:

- **Interface is copy-only** — `FeatureAnnouncement` has just
  `id/label/title/body/ctaLabel/eligibleBefore`
  (`apps/web-app/app/lib/feature-announcements.ts:14-22`); adding `heroMedia`
  (image vs video + poster) and `highlights: {icon, title, body}[]` widens it
  substantially. Fine, but every field must stay `readonly … as const satisfies` to
  keep the literal `id` union (`feature-announcements.ts:24-46`).
- **`needsSource` is an `id ===` string check** —
  `featureAnnouncementNeedsSource` hardcodes `announcement.id === "duplicate-transaction"`
  (`feature-announcements.ts:49-51`). Each new campaign that needs (or doesn't need) a
  Transaction source edits this function instead of declaring it on the entry. With more
  campaigns carrying media/CTAs this `id ===` pattern doesn't scale — a per-entry field
  (e.g. `ctaKind: "connections" | "transaction-source" | …`) is cleaner.
- **CTA target is a branching `id ===` ladder in the component** — `ctaPath`/`ctaState`
  branch on `announcement.id === "mcp-connections"` / `=== "duplicate-transaction"`
  inside the component (`feature-announcement-card.tsx:113-129`). Every new campaign adds
  a branch here rather than the catalog describing its own CTA. Enriched entries make
  this worse; moving CTA resolution onto the entry (a discriminated union on `ctaKind`)
  localizes it.
- **Domain ID allowlist is a separate hand-maintained tuple** — permanent IDs live in
  `packages/domain/src/feature-announcements.ts:5` (`FEATURE_ANNOUNCEMENT_IDS`) and must
  stay in sync with the web catalog (the acknowledgment allowlist). New campaigns touch
  two files; not media-specific, but the coupling grows with every entry.
- **`eligibleBefore` is fine as-is** — it's an immutable per-campaign UTC instant
  (`feature-announcements.ts:34,44`) and doesn't interact with media/bullets. No friction.
- **`selectActiveCatalogEntry` = newest wins** — one campaign owns the slot
  (`feature-announcements.ts:100-105`); unaffected by richer entries.

Net: the enrichment is very doable in the hard-coded catalog, but it's the right moment
to (1) widen the interface for `heroMedia` + `highlights`, and (2) replace the two
`id ===` string-equality branches (`needsSource`, CTA resolution) with per-entry
declarative fields so each future campaign is data, not new `if` branches.

---

## Hero image asset spec (decided)

Living convention for every Feature Announcement hero image. Hero media is **required** —
every catalog entry carries one, so the card has a single layout and the dismiss control
has a single position (over the media). When the `heroMedia` field lands in the catalog,
point its JSDoc here.

| Property | Value | Why |
| --- | --- | --- |
| Aspect ratio | **16:9** | Renders at 320 × 180 in the card, which is exactly the ~180 px height budget left on an iPhone SE (see Q5). Also the native output ratio of every screen-capture and design tool. |
| Source dimensions | **1280 × 720** | 4× the 320 px rendered width; covers every DPR in use. |
| Format | **WebP** (`.webp`) | Universally supported; smaller than PNG at this size. No video — decided against (Q1 autoplay is not guaranteed). |
| Weight target | **≤ 80 KB** | The card renders only for eligible users, but most of them dismiss it. |
| Hosting | R2 bucket on `assets.pocketcircle.app` | No CORS needed for `<img>` (Q2). |
| Filename | Versioned, under an `announcements/` prefix: `announcements/<announcement-id>-v1.webp` | Enables `Cache-Control: public, max-age=31536000, immutable`. Never overwrite in place — bump the suffix. |
| Object metadata | `Content-Type: image/webp`, `Cache-Control: public, max-age=31536000, immutable` | Set at upload; R2 does not infer these (Q2). |
| Markup | Fixed `aspect-ratio: 16 / 9` box on the **wrapper**, explicit `width`/`height`, `loading="eager"`, `decoding="async"`, and an `onError` that drops the `<img>` | Wrapper owns the box so a failed load leaves a muted panel instead of collapsing the layout or showing the browser's broken-image glyph. `eager` because the card only mounts when it is about to be on screen — there is nothing to defer. |
| Alt text | Per-announcement, in the catalog entry | Required — the image carries product meaning, so it is not decorative. |

Close-button constraint: the dismiss control is always overlaid on the media's
**top-right corner** (Cursor's pattern) — media is required, so this is the only position.
Keep roughly the top-right 56 × 56 px of the rendered image (≈ 224 × 224 px in the
1280 × 720 source) visually quiet — no text or focal detail there. The button carries its
own scrim so contrast never depends on the image, but content underneath it is still
hidden.

Composition constraint: at 320 × 180 rendered, a full app screenshot is illegible, and a
portrait phone screenshot does not crop to 16:9 at all. Author a **composed graphic** — a
cropped UI detail on a background — sized so any text inside it stays readable at 320 px
wide. Cursor's reference hero ([#334](https://github.com/arpitdalal/PocketCircle/issues/334))
is composed, not captured.

Alternative if the height budget gets tight: **2:1** (320 × 160 rendered, 1280 × 640
source) buys ~20 px. Do not use 4:3 (240 px) or 1:1 (320 px) — both overflow small phones.

---

## Sources

Repo: `apps/web-app/app/components/feature-announcement-card.tsx`,
`apps/web-app/app/lib/feature-announcements.ts`,
`packages/domain/src/feature-announcements.ts`,
`apps/web-app/app/components/notification-announcement-strip.tsx`,
`apps/web-app/app/lib/changelog.ts`, `apps/web-app/app/routes/whats-new.tsx`,
`apps/web-app/app/components/ui/dialog.tsx`, `apps/web-app/app/components/ui/accordion.tsx`,
`apps/web-app/app/routes/dev/email-preview.tsx`, `apps/web-app/app/app.css`,
`apps/web-app/app/lib/motion.ts`, `wrangler.jsonc`,
`docs/adr/0025-…`, `docs/adr/0032-…`,
`docs/research/feature-announcements-issue-282-current-fit.md`.

External (primary):
- WebKit — New `<video>` Policies for iOS: https://webkit.org/blog/6784/new-video-policies-for-ios/
- MDN — Autoplay guide: https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay
- MDN — `<video>`: https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/video
- MDN — `Navigator.getAutoplayPolicy()`: https://developer.mozilla.org/en-US/docs/Web/API/Navigator/getAutoplayPolicy
- MDN — `prefers-reduced-data`: https://developer.mozilla.org/en-US/docs/Web/CSS/@media/prefers-reduced-data
- MDN — Web video codec guide: https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Video_codecs
- Cloudflare — R2 public buckets: https://developers.cloudflare.com/r2/data-access/public-buckets/
- Cloudflare — R2 Configure CORS: https://developers.cloudflare.com/r2/buckets/cors/
- Cloudflare — Enable cache in an R2 bucket: https://developers.cloudflare.com/cache/interaction-cloudflare-products/r2/
- Cloudflare — R2 pricing: https://developers.cloudflare.com/r2/pricing/
- Cloudflare — MP4 videos on iOS and Safari: https://developers.cloudflare.com/cache/troubleshooting/mp4-videos-on-ios-and-safari/
- Cloudflare — Workers Static Assets → Headers (`_headers`): https://developers.cloudflare.com/workers/static-assets/headers/
- web.dev — Cumulative Layout Shift (CLS): https://web.dev/articles/cls
- MDN — `requestIdleCallback`: https://developer.mozilla.org/en-US/docs/Web/API/Window/requestIdleCallback
- MDN — `load` event: https://developer.mozilla.org/en-US/docs/Web/API/Window/load_event
- MDN — `<length>` (viewport units): https://developer.mozilla.org/en-US/docs/Web/CSS/length#relative_length_units_based_on_viewport
- CSSWG — CSS Values and Units L4 (lengths): https://drafts.csswg.org/css-values/#lengths
- lucide — lucide-react overview: https://lucide.dev/guide/packages/lucide-react
- lucide — Dynamic icon component: https://lucide.dev/guide/react/advanced/dynamic-icon-component
- lucide — React accessibility: https://lucide.dev/guide/react/advanced/accessibility
- W3C WAI — Decorative images tutorial: https://www.w3.org/WAI/tutorials/images/decorative/
- W3C WAI — ARIA Authoring Practices: https://www.w3.org/WAI/ARIA/apg/
