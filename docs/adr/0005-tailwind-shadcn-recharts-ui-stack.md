# Tailwind shadcn/ui and Recharts for UI

PocketCircle v1 uses Tailwind CSS, shadcn/ui, and Recharts for the responsive web interface. This stack supports dark mode, accessible app primitives, and dashboard charts without committing to a heavyweight design system or custom charting layer.

## Primitives library (Base UI)

Vendored UI primitives in `apps/web-app` use [**Base UI**](https://base-ui.com/react/) (`@base-ui/react`) for headless behavior: **Button** (native submit/focus semantics), **Dialog** (filter panel), and plain **`<label>`** for labels. We previously used Radix (`@radix-ui/react-slot`, `@radix-ui/react-dialog`, `@radix-ui/react-label`); Radix was removed so the app standardizes on Base UI for new primitives (see GitHub #115 / motivation in #112).

**Link styled as a button:** Base UI’s Button is for real `<button>` actions; its docs discourage rendering a router `<a>` through `Button`’s `render` prop. Call sites use React Router `<Link>` with `className={buttonVariants({ … })}` from `app/components/ui/button-variants.ts` so the control stays a link for semantics, routing, and keyboard behavior.

**Dialogs:** Filter panel animations key off Base UI’s `data-open` on backdrop/popup via Tailwind `data-[open]:…` utilities (replacing Radix’s `data-[state=open]`).
