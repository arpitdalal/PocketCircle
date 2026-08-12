import { colorLabel } from "@pocketcircle/domain";
import { href, Link } from "react-router";
import { CircleMark } from "~/components/circle-mark.js";
import { Splash } from "~/components/splash.js";
import { buttonVariants } from "~/components/ui/button-variants.js";
import { type Circle, partitionCirclesByStatus, useMyCircles } from "~/lib/data.js";
import { cn } from "~/lib/utils.js";

/** Home: the User's Circles, Personal Circle first. The default safe route. */
export default function Home() {
  const circles = useMyCircles();

  if (circles === undefined) {
    return <Splash label="Loading your circles…" />;
  }

  const { active, archived } = partitionCirclesByStatus(circles);

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="font-display text-2xl font-semibold tracking-tight">Your circles</h1>
        <Link
          to={href("/circles/new")}
          className={buttonVariants({ variant: "default", size: "default" })}
        >
          Create circle
        </Link>
      </div>
      <ul className="grid gap-3 sm:grid-cols-2">
        {active.map((circle) => (
          <HomeCircleCard key={circle.id} circle={circle} />
        ))}
      </ul>
      {archived.length > 0 ? (
        <section className="space-y-3">
          <h2 className="text-sm font-medium uppercase tracking-wide text-muted-foreground">
            Archived
          </h2>
          <ul className="grid gap-3 sm:grid-cols-2">
            {archived.map((circle) => (
              <HomeCircleCard key={circle.id} circle={circle} muted />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

function HomeCircleCard({ circle, muted = false }: { circle: Circle; muted?: boolean }) {
  return (
    <li>
      <Link
        to={href("/circles/:circleRef", { circleRef: circle.ref })}
        className="group block rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        <span
          className={cn(
            "flex items-center gap-3 rounded-xl border border-border bg-card p-4 shadow-sm transition-[border-color,box-shadow,transform] duration-150 group-hover:-translate-y-0.5 group-hover:border-ring/50 group-hover:shadow-md motion-reduce:group-hover:translate-y-0",
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
        </span>
      </Link>
    </li>
  );
}
