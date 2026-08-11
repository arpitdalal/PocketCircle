import { Outlet } from "react-router";

/** Reading-width public surfaces for long-form documents and previews. */
export default function PublicReadingLayout() {
  return (
    <div className="mx-auto w-full max-w-3xl animate-slide-up py-6 sm:py-10">
      <Outlet />
    </div>
  );
}
