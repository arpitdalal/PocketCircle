import NumberFlow from "@number-flow/react";
import { type CurrencyCode, getCurrency } from "@pocketcircle/domain";
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
 */
export function AnimatedMoney({
  minorUnits,
  currency,
  motionKey,
  motion = "scope",
}: {
  minorUnits: number;
  currency: CurrencyCode;
  /** Reporting-scope identity (currency/range/month/…). */
  motionKey: string;
  /** `always` = Dashboard live refresh; default `scope` = control-driven only. */
  motion?: "scope" | "always";
}) {
  const { decimals } = getCurrency(currency);
  const value = minorUnits / 10 ** decimals;
  const locales = viewerLocale();
  const format = {
    style: "currency" as const,
    currency,
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  };
  const formatted = new Intl.NumberFormat(locales, format).format(value);
  const animated = useScopeChangeMotion(motionKey, `${currency}:${minorUnits}`, motion);

  return (
    <span data-money={formatted}>
      <span className="sr-only">{formatted}</span>
      <NumberFlow
        value={value}
        locales={locales}
        format={format}
        animated={animated}
        aria-hidden
        spinTiming={{ duration: SCOPE_MONEY_SPIN_MS, easing: EASE_OUT_QUART }}
        opacityTiming={{ duration: SCOPE_MONEY_OPACITY_MS, easing: "ease-out" }}
        respectMotionPreference
      />
    </span>
  );
}
