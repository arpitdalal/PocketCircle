import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configureConvex,
  makeCircleView,
  makeMcpHandoffView,
  renderRoutes,
  testId,
} from "~/test/convex-react.js";

vi.mock("convex/react", async () => (await import("~/test/convex-react.js")).convexReactMock);

import McpAuthorize from "./mcp-authorize.js";

const WORKER = "https://mcp-worker.test";

beforeEach(() => {
  configureConvex();
  vi.stubEnv("VITE_MCP_WORKER_ORIGIN", WORKER);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({ redirectTo: "https://client.example/callback?error=access_denied" }),
    ),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function renderAuthorize(handoff: string | null = "signed-handoff") {
  const path = handoff === null ? "/mcp/authorize" : `/mcp/authorize?handoff=${handoff}`;
  return renderRoutes(<Route path="/mcp/authorize" element={<McpAuthorize />} />, {
    initialEntries: [path],
  });
}

describe("MCP authorize consent", () => {
  it("shows invalid copy when handoff is missing", () => {
    renderAuthorize(null);
    expect(screen.getByRole("alert")).toHaveTextContent(/no longer valid/i);
  });

  it("shows invalid copy when Convex rejects the handoff", () => {
    configureConvex({ mcpHandoff: null });
    renderAuthorize();
    expect(screen.getByRole("alert")).toHaveTextContent(/no longer valid/i);
  });

  it("renders client, scopes, refresh duration, and Circles for a valid handoff", () => {
    const circle = makeCircleView({
      id: testId("c-personal"),
      name: "Ada",
      kind: "personal",
    });
    configureConvex({
      mcpHandoff: makeMcpHandoffView({
        scopes: ["pocketcircle:read", "pocketcircle:write"],
      }),
      circles: [circle],
    });
    renderAuthorize();

    expect(screen.getByText("Example Client")).toBeInTheDocument();
    expect(screen.getByText("https://client.example/client.json")).toBeInTheDocument();
    expect(screen.getByText("https://client.example/callback")).toBeInTheDocument();
    expect(screen.getByText("30 days")).toBeInTheDocument();
    expect(screen.getByText("pocketcircle:read")).toBeInTheDocument();
    expect(screen.getByText("pocketcircle:write")).toBeInTheDocument();
    expect(screen.getByText("Ada")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled();
  });

  it("approves selected Circles and posts the approval token to the Worker", async () => {
    const user = userEvent.setup();
    const approve = vi.fn().mockResolvedValue({ approvalToken: "approval-token-1" });
    const circle = makeCircleView({ id: testId("c1"), name: "Trip" });
    configureConvex({
      mcpHandoff: makeMcpHandoffView(),
      circles: [circle],
      approveMcpAuthorization: approve,
    });
    renderAuthorize("signed-handoff");

    await user.click(screen.getByRole("checkbox", { name: /Trip/i }));
    expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => {
      expect(approve).toHaveBeenCalledWith({
        handoff: "signed-handoff",
        selectedCircleIds: [circle.id],
        grantedScopes: ["pocketcircle:read"],
      });
    });
    expect(fetch).toHaveBeenCalledWith(
      new URL("/authorize/complete", WORKER),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ approvalToken: "approval-token-1" }),
      }),
    );
  });

  it("denies by posting handoffId to the Worker (no Convex grant)", async () => {
    const user = userEvent.setup();
    configureConvex({
      mcpHandoff: makeMcpHandoffView({ handoffId: "handoff-deny" }),
      circles: [makeCircleView()],
    });
    renderAuthorize();

    await user.click(screen.getByRole("button", { name: "Deny" }));
    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        new URL("/authorize/deny", WORKER),
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ handoffId: "handoff-deny" }),
        }),
      );
    });
  });
});
