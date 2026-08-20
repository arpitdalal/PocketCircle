import NumberFlow from "@number-flow/react";
import { type CurrencyCode, getCurrency } from "@pocketcircle/domain";
import { viewerLocale } from "~/lib/locale.js";
import { EASE_OUT_QUART, SCOPE_MONEY_OPACITY_MS, SCOPE_MONEY_SPIN_MS } from "~/lib/motion.js";

/**
 * Animated currency display for headline totals (ADR 0032). Accepts integer minor
 * units; NumberFlow receives major-unit `value` + Intl format options.
 */
export function AnimatedMoney({
  minorUnits,
  currency,
}: {
  minorUnits: number;
  currency: CurrencyCode;
}) {
  const { decimals } = getCurrency(currency);
  return (
    <NumberFlow
      value={minorUnits / 10 ** decimals}
      locales={viewerLocale()}
      format={{
        style: "currency",
        currency,
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      }}
      spinTiming={{ duration: SCOPE_MONEY_SPIN_MS, easing: EASE_OUT_QUART }}
      opacityTiming={{ duration: SCOPE_MONEY_OPACITY_MS, easing: "ease-out" }}
      respectMotionPreference
    />
  );
}
