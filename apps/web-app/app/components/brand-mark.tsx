/** The circle motif as the brand glyph: two concentric rings in the accent. */
export function BrandMark() {
  return (
    <span
      aria-hidden
      className="relative flex size-6 items-center justify-center rounded-full border-2 border-primary/35"
    >
      <span className="size-2.5 rounded-full bg-primary" />
    </span>
  );
}
