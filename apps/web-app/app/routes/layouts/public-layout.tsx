import { Outlet } from "react-router";

/** Shared atmosphere for unauthenticated surfaces. Child layouts own content width. */
export default function PublicLayout() {
  return (
    <div className="relative flex min-h-dvh flex-col items-center justify-center overflow-hidden bg-background px-4 pt-[var(--safe-area-top)] pb-[var(--safe-area-bottom)]">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 left-1/2 size-[36rem] -translate-x-1/2 rounded-full bg-primary/15 blur-3xl"
      />
      <main className="relative w-full">
        <Outlet />
      </main>
    </div>
  );
}
