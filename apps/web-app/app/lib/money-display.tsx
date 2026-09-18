import { cn } from "~/lib/utils.js";

/**
 * Flex row amount cell for exact (non-AnimatedMoney) displays. Caps width and
 * allows mid-token wrap so max amounts cannot widen the page (#398).
 * `data-money` matches the AnimatedMoney E2E overflow contract.
 */
export const moneyAmountCellClassName = "min-w-0 max-w-[50%] text-right [overflow-wrap:anywhere]";

export function MoneyAmountCell({
  children,
  className,
}: {
  /** Visible formatted amount; also written to `data-money` for overflow E2E. */
  children: string;
  className?: string;
}) {
  return (
    <span className={cn(moneyAmountCellClassName, className)} data-money={children}>
      {children}
    </span>
  );
}
