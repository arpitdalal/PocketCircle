import { Outlet } from "react-router";

/** Compact public surfaces such as authentication and account actions. */
export default function PublicNarrowLayout() {
  return (
    <div className="mx-auto w-full max-w-md animate-slide-up">
      <Outlet />
    </div>
  );
}
