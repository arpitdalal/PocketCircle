import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { getFunctionName } from "convex/server";
import { expect } from "vitest";
import { convexReactMock } from "./convex/core.js";

function optionCallsFor(functionName: string) {
  return convexReactMock.useQuery.mock.calls.filter(([fn]) => getFunctionName(fn) === functionName);
}

/** RPT-8: filter-options stay `"skip"` until Filters dialog opens. */
export async function assertFilterOptionsSkippedUntilPanelOpens(
  optionsQuery: Parameters<typeof getFunctionName>[0],
) {
  const functionName = getFunctionName(optionsQuery);
  const optionCalls = () => optionCallsFor(functionName);
  await waitFor(() => expect(optionCalls().length).toBeGreaterThan(0));
  expect(optionCalls().every(([, args]) => args === "skip")).toBe(true);

  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /Filters/ }));
  await screen.findByRole("dialog", { name: "Filters" });
  await waitFor(() => {
    expect(optionCalls().some(([, args]) => args !== "skip")).toBe(true);
  });
}

/** URL id params that enable filter-options while the panel stays closed (scrub path). */
export const FILTER_OPTIONS_URL_ID_PARAMS = ["categories", "recordedBy", "paidBy"] as const;
export async function assertFilterOptionsLiveForUrlFilters(
  optionsQuery: Parameters<typeof getFunctionName>[0],
) {
  const functionName = getFunctionName(optionsQuery);
  await waitFor(() => {
    const live = convexReactMock.useQuery.mock.calls.filter(
      ([fn, args]) => getFunctionName(fn) === functionName && args !== "skip",
    );
    expect(live.length).toBeGreaterThan(0);
  });
}
