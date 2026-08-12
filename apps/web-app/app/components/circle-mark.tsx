import { colorHex } from "@pocketcircle/domain";
import { cn } from "~/lib/utils.js";

/**
 * The Circle Mark: a Circle's generated initials glyph tinted with its Circle
 * Color (CONTEXT: "generated visual mark … based on its initials and Circle
 * Color"). The single shared renderer reused by the switcher, the Circle header,
 * and Circle lists, so the mark looks identical everywhere and a styling change
 * lives in one place.
 *
 * Soft-badge treatment mirroring {@link Avatar}: a faint wash of the color (15%
 * alpha) behind the color itself as the glyph. The palette is curated to be
 * legible on dark, so color-on-dark stays readable. Purely decorative
 * (`aria-hidden`) — every surface that renders it shows the Circle name in
 * adjacent text, so announcing the chip too would double-read the name. UI must
 * not identify a Circle by color alone (CONTEXT: Circle Color): because names
 * duplicate by design (PRD 10), the list surfaces (switcher, home) render the
 * Circle Color *label as text* beside the name, so the color is conveyed
 * non-visually too and the decorative chip is never the sole disambiguator.
 *
 * `mark` is the stored, already-derived glyph (the backend derives it from the
 * name's initials at creation); this component never re-derives it, it only
 * renders it with the color. Size defaults to `size-9` and is overridable through
 * `className` for a denser list row.
 */
export function CircleMark({
  mark,
  color,
  className,
}: {
  mark: string;
  color: string;
  className?: string;
}) {
  const hex = colorHex(color);
  return (
    <span
      aria-hidden
      style={{ backgroundColor: `${hex}26`, color: hex }}
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-md text-sm font-semibold",
        className,
      )}
    >
      {mark}
    </span>
  );
}
