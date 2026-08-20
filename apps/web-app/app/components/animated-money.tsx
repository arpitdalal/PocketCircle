import NumberFlow from "@number-flow/react";
import { type CurrencyCode, getCurrency } from "@pocketcircle/domain";
import { viewerLocale } from "~/lib/locale.js";
import { EASE_OUT_QUART, SCOPE_MONEY_OPACITY_MS, SCOPE_MONEY_SPIN_MS } from "~/lib/motion.js";

/**
 * Animated currency display for headline totals (ADR 0032). Accepts integer minor
 * units; NumberFlow receives major-unit `value` + Intl format options.
 *
 * NumberFlow keeps digit strips in open shadow DOM for spin animation, so parent
 * `textContent` is not the formatted amount. The light-DOM `aria-label` /
 * `data-money` contract (and NumberFlow's own ElementInternals label) is the
 * readable value for AT and tests.
 */
export function AnimatedMoney({
  minorUnits,
  currency,
}: {
  minorUnits: number;
  currency: CurrencyCode;
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

  return (
    <NumberFlow
      value={value}
      locales={locales}
      format={format}
      // Light-DOM contract: NumberFlow's digit strips live in open shadow DOM, so
      // parent textContent is not the amount. Pin role + label for AT/jsdom/E2E.
      role="img"
      aria-label={formatted}
      data-money={formatted}
      spinTiming={{ duration: SCOPE_MONEY_SPIN_MS, easing: EASE_OUT_QUART }}
      opacityTiming={{ duration: SCOPE_MONEY_OPACITY_MS, easing: "ease-out" }}
      respectMotionPreference
    />
  );
}
