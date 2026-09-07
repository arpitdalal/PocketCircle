import { colorHex } from "@pocketcircle/domain";
import { History, Sparkles, Tags, Users, Wallet } from "lucide-react";
import { Link } from "react-router";
import { CircleMark } from "~/components/circle-mark.js";
import { GoogleSignInPanel } from "~/components/google-sign-in-panel.js";
import { cn } from "~/lib/utils.js";

/**
 * Signed-out homepage at `/` for Google OAuth branding checks and first-time
 * visitors. Also used as root `HydrateFallback` so SPA `index.html` includes
 * purpose + Privacy links for crawlers that do not run JS. Continue with Google
 * in one click (same controls as `/signin`).
 */
export function MarketingHome() {
  return (
    <div className="relative flex min-h-dvh flex-col overflow-x-hidden bg-background text-foreground">
      <Atmosphere />

      <header className="relative z-10 flex items-center px-4 pt-[calc(0.75rem+var(--safe-area-top))] pb-3 sm:px-6 lg:px-10">
        <a
          href="#top"
          className="flex items-center gap-2 font-display text-base font-semibold tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <BrandMark />
          PocketCircle
        </a>
      </header>

      <main id="top" className="relative z-10 flex flex-1 flex-col">
        <Hero />
        <CirclesSection />
        <CapabilitiesSection />
        <AiNativeSection />
        <StepsSection />
        <ClosingCta />
      </main>

      <footer className="relative z-10 border-t border-border/60 px-4 py-12 pb-[calc(3rem+var(--safe-area-bottom))] sm:px-6 lg:px-10">
        <div className="mx-auto grid max-w-5xl gap-10 sm:grid-cols-2 lg:grid-cols-4">
          <div className="space-y-3 sm:col-span-2 lg:col-span-1">
            <p className="flex items-center gap-2 font-display text-sm font-semibold tracking-tight">
              <BrandMark />
              PocketCircle
            </p>
            <p className="max-w-xs text-sm text-muted-foreground text-pretty">
              Shared Circles for home, trips, and family — with AI assistants when you want help.
            </p>
          </div>

          {FOOTER_SECTIONS.map((section) => (
            <nav key={section.title} aria-label={section.title} className="space-y-3">
              <p className="font-display text-xs font-medium tracking-[0.14em] text-faint uppercase">
                {section.title}
              </p>
              <ul className="space-y-2 text-sm text-muted-foreground">
                {section.links.map((link) => (
                  <li key={link.label}>
                    {link.to.startsWith("#") || link.to.endsWith(".xml") ? (
                      <a
                        href={link.to}
                        className="underline-offset-2 transition-colors hover:text-foreground hover:underline"
                      >
                        {link.label}
                      </a>
                    ) : (
                      <Link
                        to={link.to}
                        className="underline-offset-2 transition-colors hover:text-foreground hover:underline"
                      >
                        {link.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </nav>
          ))}
        </div>
        <p className="mx-auto mt-10 max-w-5xl text-xs text-faint">
          © {new Date().getFullYear()} PocketCircle. All rights reserved.
        </p>
      </footer>
    </div>
  );
}

function Atmosphere() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
      <div className="absolute -top-32 left-1/2 -translate-x-1/2">
        <div className="size-[42rem] rounded-full bg-primary/20 blur-3xl animate-marketing-glow" />
      </div>
      <div className="absolute top-[28rem] -right-40 size-[28rem] rounded-full bg-primary/10 blur-3xl" />
      <div className="absolute top-[70rem] -left-32 size-[22rem] rounded-full bg-positive/8 blur-3xl" />
    </div>
  );
}

function Hero() {
  return (
    <section className="mx-auto grid w-full max-w-6xl gap-12 px-4 pt-10 pb-20 sm:px-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.05fr)] lg:items-center lg:gap-16 lg:px-10 lg:pt-16 lg:pb-28">
      <div className="animate-marketing-enter space-y-8 text-left">
        <div className="space-y-5">
          <h1 className="font-display max-w-xl text-4xl font-semibold tracking-tight text-balance sm:text-5xl lg:text-[3.5rem] lg:leading-[1.05]">
            PocketCircle
          </h1>
          <p className="max-w-xl font-display text-xl font-medium tracking-tight text-foreground/90 text-balance sm:text-2xl">
            One place for the money you share
          </p>
          <p className="max-w-md text-base text-muted-foreground text-pretty sm:text-lg">
            PocketCircle helps you track spending together in shared Circles. Record expenses and
            income, organize Categories, and review totals with others.
          </p>
        </div>

        <div id="get-started" className="max-w-sm scroll-mt-24 space-y-3">
          <GoogleSignInPanel buttonClassName="w-full min-w-0" />
        </div>
      </div>

      <div className="animate-marketing-enter relative min-w-0 [animation-delay:120ms]">
        <div
          aria-hidden
          className="absolute inset-x-8 -top-6 -bottom-6 rounded-[2rem] bg-gradient-to-b from-primary/15 via-transparent to-transparent blur-2xl"
        />
        <LedgerPreview />
      </div>
    </section>
  );
}

function CirclesSection() {
  return (
    <section
      id="circles"
      className="scroll-mt-24 border-t border-border/50 px-4 py-20 sm:px-6 lg:px-10"
    >
      <div className="mx-auto grid max-w-5xl gap-10 lg:grid-cols-[0.9fr_1.1fr] lg:gap-16 lg:items-end">
        <div className="space-y-4">
          <h2 className="font-display text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            Circles for every shared life
          </h2>
          <p className="max-w-md text-muted-foreground text-pretty">
            Your Personal Circle stays yours. Create a shared Circle for home, a trip, roommates, or
            family — invite Members when you are ready.
          </p>
        </div>

        <ul className="grid gap-6 sm:grid-cols-2">
          {EXAMPLE_CIRCLES.map((circle) => (
            <li key={circle.name} className="flex items-start gap-3">
              <CircleMark mark={circle.mark} color={circle.color} className="size-10 text-sm" />
              <div className="min-w-0 pt-0.5">
                <p className="font-medium">{circle.name}</p>
                <p className="text-sm text-muted-foreground">{circle.blurb}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function CapabilitiesSection() {
  return (
    <section
      id="features"
      className="scroll-mt-24 border-t border-border/50 px-4 py-20 sm:px-6 lg:px-10"
    >
      <div className="mx-auto max-w-5xl space-y-12">
        <div className="max-w-xl space-y-3">
          <h2 className="font-display text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            Stay aligned without the spreadsheet
          </h2>
          <p className="text-muted-foreground text-pretty">
            Everyone in a Circle sees the same Transactions, Categories, and totals — so money talk
            stays calm.
          </p>
        </div>

        <ul className="grid gap-10 sm:grid-cols-3">
          {CAPABILITIES.map((item) => (
            <li key={item.title} className="space-y-3">
              <span className="flex size-10 items-center justify-center rounded-full bg-primary-soft text-primary">
                <item.icon aria-hidden className="size-5" strokeWidth={1.75} />
              </span>
              <h3 className="font-display text-lg font-semibold tracking-tight">{item.title}</h3>
              <p className="text-sm text-muted-foreground text-pretty">{item.body}</p>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function AiNativeSection() {
  return (
    <section id="ai" className="scroll-mt-24 border-t border-border/50 px-4 py-20 sm:px-6 lg:px-10">
      <div className="mx-auto grid max-w-5xl gap-8 lg:grid-cols-[auto_minmax(0,1fr)] lg:items-start lg:gap-12">
        <span className="flex size-12 items-center justify-center rounded-full bg-primary-soft text-primary">
          <Sparkles aria-hidden className="size-6" strokeWidth={1.75} />
        </span>
        <div className="space-y-4">
          <h2 className="font-display text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            AI-native, with you in control
          </h2>
          <p className="max-w-2xl text-muted-foreground text-pretty">
            Connect AI assistants over MCP — ChatGPT, Claude, Codex, Cursor, and other MCP clients.
            You approve Circles and permissions in the browser; they can review spending and record
            Transactions in those Circles. Manage access anytime in Connections.
          </p>
        </div>
      </div>
    </section>
  );
}

function StepsSection() {
  return (
    <section
      id="how-it-works"
      className="scroll-mt-24 border-t border-border/50 px-4 py-20 sm:px-6 lg:px-10"
    >
      <div className="mx-auto max-w-5xl space-y-10">
        <h2 className="font-display text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
          Up and running in minutes
        </h2>
        <ol className="grid gap-8 sm:grid-cols-3">
          {STEPS.map((step, index) => (
            <li key={step.title} className="space-y-3">
              <p className="font-display text-sm font-medium tracking-[0.14em] text-primary uppercase">
                Step {index + 1}
              </p>
              <h3 className="font-display text-xl font-semibold tracking-tight">{step.title}</h3>
              <p className="text-sm text-muted-foreground text-pretty">{step.body}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

function ClosingCta() {
  return (
    <section className="border-t border-border/50 px-4 py-20 sm:px-6 lg:px-10">
      <div className="mx-auto flex max-w-5xl flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
        <div className="max-w-lg space-y-3">
          <h2 className="font-display text-3xl font-semibold tracking-tight text-balance sm:text-4xl">
            Start your first Circle
          </h2>
          <p className="text-muted-foreground text-pretty">
            Sign in with Google. Your Personal Circle is ready the moment you arrive.
          </p>
        </div>
        <div id="get-started-again" className="w-full max-w-sm">
          <GoogleSignInPanel buttonClassName="w-full min-w-0" />
        </div>
      </div>
    </section>
  );
}

function LedgerPreview() {
  return (
    <div className="relative overflow-hidden rounded-[1.75rem] border border-border/80 bg-card/70 shadow-[0_24px_80px_-32px_oklch(0.4_0.12_295/0.55)] backdrop-blur-sm">
      <div className="flex items-center gap-3 border-b border-border/60 px-5 py-4">
        <CircleMark mark="AH" color="teal" className="size-9 text-xs" />
        <div className="min-w-0 flex-1">
          <p className="truncate font-display text-sm font-semibold tracking-tight">
            Apartment Home
          </p>
          <p className="text-xs text-muted-foreground">3 Members · Teal</p>
        </div>
        <Users aria-hidden className="size-4 text-faint" strokeWidth={1.75} />
      </div>

      <div className="space-y-1 px-3 py-3">
        {LEDGER_ROWS.map((row, index) => (
          <div
            key={row.title}
            className={cn(
              "flex items-center gap-3 rounded-xl px-2.5 py-2.5",
              index === 0 && "bg-primary-soft/60 animate-marketing-row-pulse",
            )}
          >
            <span
              aria-hidden
              className="flex size-9 shrink-0 items-center justify-center rounded-md text-[0.65rem] font-semibold"
              style={{
                backgroundColor: `${colorHex(row.categoryColor)}26`,
                color: colorHex(row.categoryColor),
              }}
            >
              {row.categoryMark}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{row.title}</p>
              <p className="truncate text-xs text-muted-foreground">{row.meta}</p>
            </div>
            <p
              className={cn(
                "shrink-0 font-display text-sm font-semibold tabular-nums",
                row.positive ? "text-positive" : "text-foreground",
              )}
            >
              {row.amount}
            </p>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between border-t border-border/60 px-5 py-3.5 text-xs text-muted-foreground">
        <span>This month</span>
        <span className="font-display text-sm font-semibold text-foreground tabular-nums">
          −$2,318.60
        </span>
      </div>
    </div>
  );
}

function BrandMark() {
  return (
    <span
      aria-hidden
      className="relative flex size-6 items-center justify-center rounded-full border-2 border-primary/35"
    >
      <span className="size-2.5 rounded-full bg-primary" />
    </span>
  );
}

const FOOTER_SECTIONS = [
  {
    title: "Product",
    links: [
      { label: "Circles", to: "#circles" },
      { label: "Features", to: "#features" },
      { label: "AI & MCP", to: "#ai" },
      { label: "How it works", to: "#how-it-works" },
    ],
  },
  {
    title: "Account",
    links: [
      { label: "Sign in", to: "/signin" },
      { label: "What's new", to: "/whats-new" },
      { label: "Support", to: "/support" },
    ],
  },
  {
    title: "Legal",
    links: [
      { label: "Privacy Policy", to: "/privacy" },
      { label: "Terms", to: "/terms" },
      { label: "Sitemap", to: "/sitemap.xml" },
    ],
  },
] as const;

const EXAMPLE_CIRCLES = [
  { mark: "PC", color: "iris", name: "Personal Circle", blurb: "Always yours, always solo" },
  { mark: "AH", color: "teal", name: "Apartment Home", blurb: "Rent, groceries, utilities" },
  { mark: "JT", color: "amber", name: "Japan Trip", blurb: "Flights, food, shared days" },
  { mark: "FC", color: "rose", name: "Family Care", blurb: "Shared costs, clear history" },
] as const;

const CAPABILITIES = [
  {
    icon: Wallet,
    title: "Record expenses and income",
    body: "Log Transactions with a title, amount, date, and Categories — visible to every Member in the Circle.",
  },
  {
    icon: Tags,
    title: "Organize with Categories",
    body: "Keep spending readable. Filter and review totals by Category instead of scrolling a messy chat history.",
  },
  {
    icon: History,
    title: "See who did what",
    body: "Member List and Circle History keep ownership and changes clear when money decisions involve more than one person.",
  },
] as const;

const STEPS = [
  {
    title: "Continue with Google",
    body: "Create your account in one click. No separate password to manage. We only use your Google profile information (name, email) to authenticate your account.",
  },
  {
    title: "Open a Circle",
    body: "Start in your Personal Circle, or create a shared Circle for the people you spend with.",
  },
  {
    title: "Invite and record",
    body: "Add Members by email, then record the first expense or income together.",
  },
] as const;

const LEDGER_ROWS = [
  {
    title: "Groceries — Costco",
    meta: "Groceries · Maya",
    amount: "−$186.42",
    positive: false,
    categoryMark: "G",
    categoryColor: "green",
  },
  {
    title: "March rent",
    meta: "Rent · Jordan",
    amount: "−$2,100.00",
    positive: false,
    categoryMark: "R",
    categoryColor: "blue",
  },
  {
    title: "Utilities split",
    meta: "Utilities · Alex",
    amount: "−$94.18",
    positive: false,
    categoryMark: "U",
    categoryColor: "amber",
  },
  {
    title: "Payback from Sam",
    meta: "Income · Sam",
    amount: "+$62.00",
    positive: true,
    categoryMark: "I",
    categoryColor: "teal",
  },
] as const;
