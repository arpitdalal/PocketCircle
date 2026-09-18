import NumberFlow from "@number-flow/react";
import { type CurrencyCode, getCurrency } from "@pocketcircle/domain";
import { useLayoutEffect, useRef, useState } from "react";
import { viewerLocale } from "~/lib/locale.js";
import {
  EASE_OUT_QUART,
  SCOPE_MONEY_OPACITY_MS,
  SCOPE_MONEY_SPIN_MS,
  useScopeChangeMotion,
} from "~/lib/motion.js";

/**
 * Animated currency display for headline totals (ADR 0032). Accepts integer minor
 * units; NumberFlow receives major-unit `value` + Intl format options.
 *
 * Motion runs only for eligible headline transitions (`motionKey` / `motion`), not
 * every live Convex refresh — see `useScopeChangeMotion`.
 *
 * NumberFlow keeps digit strips in open shadow DOM for spin animation, so parent
 * `textContent` is not the formatted amount. A visually-hidden text node carries
 * the amount for AT; `data-money` is the test/E2E contract. The animated visual
 * is `aria-hidden` so it is not announced as an image.
 *
 * Canvas `measureText` (no DOM probe — a nowrap measure node widens document
 * scrollWidth and breaks `position: fixed` chrome) decides format: exact fits →
 * full currency NumberFlow; else compact (`notation: "compact"`, still NumberFlow
 * so `$36K` animates). `overflow-hidden` clips digit-strip spin (no scrollbar).
 * Remeasure on ResizeObserver and `document.fonts` settle (`ready` +
 * `loadingdone`) so Inter Variable swap cannot leave exact clipped. Exact stays
 * in sr-only + `title` when compact.
 */
export function AnimatedMoney({
  minorUnits,
  currency,
  motionKey,
  motion = "scope",
  pending = false,
}: {
  minorUnits: number;
  currency: CurrencyCode;
  /** Reporting-scope identity (currency/range/month/…). */
  motionKey: string;
  /** `always` = Dashboard live refresh; default `scope` = control-driven only. */
  motion?: "scope" | "always";
  /** True while retained totals bridge a scope reload (`useStableQuery` / Home). */
  pending?: boolean;
}) {
  const { decimals } = getCurrency(currency);
  const value = minorUnits / 10 ** decimals;
  const locales = viewerLocale();
  const exactFormat = {
    style: "currency" as const,
    currency,
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  };
  const compactFormat = {
    style: "currency" as const,
    currency,
    notation: "compact" as const,
  };
  const formatted = new Intl.NumberFormat(locales, exactFormat).format(value);
  const compact = new Intl.NumberFormat(locales, compactFormat).format(value);
  const animated = useScopeChangeMotion(motionKey, `${currency}:${minorUnits}`, motion, pending);
  const containerRef = useRef<HTMLSpanElement>(null);
  const [overflows, setOverflows] = useState(false);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    let cancelled = false;

    const updateOverflow = () => {
      if (cancelled) return;
      const style = getComputedStyle(container);
      const width = container.clientWidth;
      if (ctx) {
        ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        setOverflows(ctx.measureText(formatted).width > width);
        return;
      }
      // No canvas (jsdom): ch-approx so overflow still flips without a DOM probe.
      const fontSize = Number.parseFloat(style.fontSize) || 16;
      setOverflows(formatted.length * fontSize * 0.55 > width);
    };

    const observer = new ResizeObserver(updateOverflow);
    observer.observe(container);
    updateOverflow();

    // Font swap changes glyph widths without resizing the container — remeasure
    // when the document font set settles (initial ready + later loadingdone).
    // Canvas does not auto-refresh on web-font load the way HTML text does
    // (https://developer.mozilla.org/en-US/docs/Web/API/FontFaceSet/ready).
    const fonts = document.fonts;
    if (fonts) {
      fonts.addEventListener("loadingdone", updateOverflow);
      void (async () => {
        await fonts.ready;
        // ready can be replaced while status is still "loading" (WebKit).
        if (!cancelled && fonts.status === "loading") await fonts.ready;
        updateOverflow();
      })();
    }

    return () => {
      cancelled = true;
      observer.disconnect();
      fonts?.removeEventListener("loadingdone", updateOverflow);
    };
  }, [formatted]);

  return (
    <span
      ref={containerRef}
      className="relative block min-w-0 max-w-full overflow-hidden"
      data-money={formatted}
      data-compact-money={overflows ? compact : undefined}
      title={overflows ? formatted : undefined}
    >
      <span className="sr-only">{formatted}</span>
      <NumberFlow
        value={value}
        locales={locales}
        format={overflows ? compactFormat : exactFormat}
        animated={animated}
        aria-hidden
        spinTiming={{ duration: SCOPE_MONEY_SPIN_MS, easing: EASE_OUT_QUART }}
        opacityTiming={{ duration: SCOPE_MONEY_OPACITY_MS, easing: "ease-out" }}
        respectMotionPreference
      />
    </span>
  );
}
