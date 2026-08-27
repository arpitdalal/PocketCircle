import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useSearchParams } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderRouteStubWithScrollRestoration } from "~/test/router-stub.js";
import { keepScrollSearchParamsOptions } from "./keep-scroll-search-params.js";

/**
 * Exercises the helper through a real data-router `<ScrollRestoration>` (ADR 0006 /
 * issue #311) — not a shape assertion. Bare `setSearchParams` must scroll to top;
 * the helper must suppress that.
 */
function FilterButtons() {
  const [, setSearchParams] = useSearchParams();
  return (
    <>
      <button type="button" onClick={() => setSearchParams({ q: "a" }, { replace: false })}>
        jump
      </button>
      <button
        type="button"
        onClick={() =>
          setSearchParams({ q: "b" }, keepScrollSearchParamsOptions({ replace: false }))
        }
      >
        keep
      </button>
    </>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("keepScrollSearchParamsOptions", () => {
  it("stops ScrollRestoration from resetting scroll on in-place filter updates (issue #311)", async () => {
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});

    renderRouteStubWithScrollRestoration([{ index: true, Component: FilterButtons }], ["/"]);

    await screen.findByRole("button", { name: "jump" });
    scrollTo.mockClear();

    await userEvent.click(screen.getByRole("button", { name: "jump" }));
    expect(scrollTo).toHaveBeenCalledWith(0, 0);

    scrollTo.mockClear();
    await userEvent.click(screen.getByRole("button", { name: "keep" }));
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
