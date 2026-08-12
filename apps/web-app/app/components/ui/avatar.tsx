import { initials, paletteColorForSeed } from "@pocketcircle/domain";
import { useState } from "react";
import { cn } from "~/lib/utils.js";

/**
 * The visual identity for a Member/User: their Profile Picture when present and
 * loadable, otherwise a generated initials avatar (CONTEXT: "if Google does not
 * provide one, PocketCircle uses a generated initials avatar"). The fallback also
 * fires when a present URL fails to LOAD (`onError`) — Google's profile-image
 * URLs can expire/403 over time, so an image prop being set is not a guarantee it
 * renders; without this a dead URL would show a broken image instead of initials.
 *
 * The generated chip — both the initials and its tint — is a pure function of the
 * Display Name, so it stays consistent for the same person across every Circle:
 * the materialized identity mirrors one Google profile onto all of a User's active
 * memberships (ADR 0018), and the client never needs the raw userId, which the
 * Member view deliberately withholds (ADR 0016). Colors are a cue, not identity,
 * so two people sharing a name (and thus a color) is fine.
 *
 * Purely decorative — `aria-hidden`, empty `alt` — because every surface that
 * renders it shows the Display Name in adjacent text; announcing the avatar too
 * would double-read the name.
 */
export function Avatar({
  name,
  image,
  className,
}: {
  name: string;
  image?: string;
  className?: string;
}) {
  // Track the URL that failed rather than a bare boolean, so a new `image` URL is
  // retried instead of being suppressed by a stale failure flag.
  const [brokenSrc, setBrokenSrc] = useState<string | null>(null);
  const base = "size-9 shrink-0 rounded-full";

  if (image && image !== brokenSrc) {
    return (
      <img
        src={image}
        alt=""
        aria-hidden
        onError={() => setBrokenSrc(image)}
        className={cn(base, "object-cover", className)}
      />
    );
  }

  const color = paletteColorForSeed(name.trim().toLowerCase());
  // Soft-badge treatment: a faint wash of the color (15% alpha) behind the color
  // itself as the glyph. The palette is curated to be legible on dark, so color-
  // on-dark stays readable — light text on a saturated fill would not.
  return (
    <span
      aria-hidden
      style={{ backgroundColor: `${color.hex}26`, color: color.hex }}
      className={cn(base, "flex items-center justify-center text-xs font-semibold", className)}
    >
      {initials(name)}
    </span>
  );
}
