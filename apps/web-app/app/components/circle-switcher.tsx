import { colorLabel } from "@pocketcircle/domain";
import { useEffect, useId, useRef, useState } from "react";
import { href, Link } from "react-router";
import { CircleMark } from "~/components/circle-mark.js";
import { type Circle, partitionCirclesByStatus, useMyCircles } from "~/lib/data.js";
import { cn } from "~/lib/utils.js";

/**
 * The Circle switcher in the app shell (CS-0) — the navigation backbone every
 * collaboration and reporting slice leans on. A disclosure button reveals the
 * User's own Circles (`useMyCircles`, Personal Circle first — the query already
 * orders them), each a canonical-ref link (ADR 0016), plus a Create Circle entry.
 *
 * There is NO Circle discovery (PRD 24): the menu lists only Circles the User is a
 * Member of, which is exactly what `listMyCircles` returns — the switcher never
 * queries or exposes anyone else's Circles.
 *
 * Hand-built disclosure (not Base UI `Menu`) to avoid pulling floating-ui into this
 * older control; kept accessible: the trigger carries `aria-haspopup`/`aria-expanded`/`aria-controls`,
 * the panel is a labelled menu of links, Escape closes and returns focus to the
 * trigger, and an outside click closes it. Selecting an item navigates (a real
 * Link) and closes the menu.
 */
export function CircleSwitcher() {
  const circles = useMyCircles();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  // Close on an outside click and on Escape; Escape also restores focus to the
  // trigger so keyboard users aren't stranded. Only wired while open.
  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      // `instanceof Node` narrows the `EventTarget | null` target type-safely (an
      // event target isn't always a Node), so no cast is needed for `contains`.
      const target = event.target;
      if (
        target instanceof Node &&
        containerRef.current &&
        !containerRef.current.contains(target)
      ) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((value) => !value)}
        className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm text-foreground transition-colors duration-150 hover:border-ring/60 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        Circles
        <span
          aria-hidden
          className={cn(
            "text-muted-foreground transition-transform duration-200",
            open && "rotate-180",
          )}
        >
          ▾
        </span>
      </button>

      {open ? (
        <div
          id={menuId}
          role="menu"
          aria-label="Your circles"
          className="absolute left-0 z-50 mt-1.5 w-64 origin-top-left animate-pop-in overflow-hidden rounded-lg border border-border bg-popover py-1 shadow-xl"
        >
          <CircleItems circles={circles} onSelect={() => setOpen(false)} />
          <div className="my-1 border-t border-border" />
          <Link
            role="menuitem"
            to={href("/circles/new")}
            prefetch="intent"
            onClick={() => setOpen(false)}
            className="flex items-center gap-3 px-3 py-2 text-sm text-foreground transition-colors hover:bg-muted/60"
          >
            <span
              aria-hidden
              className="flex size-9 shrink-0 items-center justify-center rounded-md border border-dashed border-primary/50 text-base text-primary"
            >
              +
            </span>
            Create circle
          </Link>
        </div>
      ) : null}
    </div>
  );
}

/** The Circle rows of the open menu — loading, then the User's own Circles as
 * canonical-ref links. (An empty list never happens in practice: every User keeps a
 * Personal Circle — but it degrades to just the Create entry rather than crashing.) */
function CircleItems({
  circles,
  onSelect,
}: {
  circles: Circle[] | undefined;
  onSelect: () => void;
}) {
  if (circles === undefined) {
    return (
      <p className="px-3 py-2 text-sm text-muted-foreground" aria-live="polite">
        Loading circles…
      </p>
    );
  }

  const { active, archived } = partitionCirclesByStatus(circles);

  return (
    <>
      {active.map((circle) => (
        <CircleMenuItem key={circle.id} circle={circle} onSelect={onSelect} />
      ))}
      {archived.length > 0 ? (
        <>
          <div className="my-1 border-t border-border" />
          <p className="px-3 py-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Archived
          </p>
          {archived.map((circle) => (
            <CircleMenuItem key={circle.id} circle={circle} onSelect={onSelect} muted />
          ))}
        </>
      ) : null}
    </>
  );
}

function CircleMenuItem({
  circle,
  onSelect,
  muted = false,
}: {
  circle: Circle;
  onSelect: () => void;
  muted?: boolean;
}) {
  return (
    <Link
      role="menuitem"
      to={href("/circles/:circleRef", { circleRef: circle.ref })}
      prefetch="intent"
      onClick={onSelect}
      className={cn(
        "flex items-center gap-3 px-3 py-2 text-sm transition-colors hover:bg-muted/60",
        muted && "text-muted-foreground",
      )}
    >
      <CircleMark mark={circle.mark} color={circle.color} />
      <span className="min-w-0">
        <span className="block truncate font-medium">{circle.name}</span>
        <span className="block truncate text-xs text-muted-foreground">
          {circle.kind === "personal" ? "Your Circle" : "Circle"} · {circle.currency} ·{" "}
          {colorLabel(circle.color)}
          {muted ? " · Archived" : ""}
        </span>
      </span>
    </Link>
  );
}
