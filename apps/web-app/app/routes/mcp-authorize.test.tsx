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
const HANDOFF_ID = "550e8400-e29b-41d4-a716-446655440000";

beforeEach(() => {
  configureConvex();
  vi.stubEnv("VITE_MCP_WORKER_ORIGIN", WORKER);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input) =>
      String(input).includes("/authorize/handoff")
        ? Response.json({ handoff: "signed-handoff" })
        : Response.json({ redirectTo: "https://client.example/callback?error=access_denied" }),
    ),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function renderAuthorize(hasHandoff = true) {
  const path = hasHandoff ? `/mcp/authorize?handoffId=${HANDOFF_ID}` : "/mcp/authorize";
  return renderRoutes(<Route path="/mcp/authorize" element={<McpAuthorize />} />, {
    initialEntries: [path],
  });
}

describe("MCP authorize consent", () => {
  it("shows invalid copy when handoff is missing", () => {
    renderAuthorize(false);
    expect(screen.getByRole("alert")).toHaveTextContent(/no longer valid/i);
  });

  it("loads the signed handoff from the Worker by handoffId", async () => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      if (String(input).includes("/authorize/handoff")) {
        return Response.json({ handoff: "signed-handoff" });
      }
      return Response.json({
        redirectTo: "https://client.example/callback?error=access_denied",
      });
    });
    configureConvex({
      mcpHandoff: makeMcpHandoffView(),
      circles: [makeCircleView({ name: "Ada", kind: "personal" })],
    });
    renderRoutes(<Route path="/mcp/authorize" element={<McpAuthorize />} />, {
      initialEntries: [`/mcp/authorize?handoffId=${HANDOFF_ID}`],
    });

    expect(await screen.findByText("Example Client")).toBeInTheDocument();
    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toBe(
      `${WORKER}/authorize/handoff?id=${HANDOFF_ID}`,
    );
  });

  it("shows invalid copy when Convex rejects the handoff", async () => {
    configureConvex({ mcpHandoff: null });
    renderAuthorize();
    expect(await screen.findByRole("alert")).toHaveTextContent(/no longer valid/i);
  });

  it("renders client, scopes, refresh duration, and Circles for a valid handoff", async () => {
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

    expect(await screen.findByText("Example Client")).toBeInTheDocument();
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
    const handoffView = makeMcpHandoffView();
    configureConvex({
      mcpHandoff: handoffView,
      circles: [circle],
      approveMcpAuthorization: approve,
    });
    renderAuthorize();

    await user.click(await screen.findByRole("checkbox", { name: /Trip/i }));
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
        body: JSON.stringify({
          approvalToken: "approval-token-1",
          handoffId: handoffView.handoffId,
        }),
      }),
    );
  });

  it("reuses one approval token when Worker completion is retried", async () => {
    const user = userEvent.setup();
    const approve = vi.fn().mockResolvedValue({ approvalToken: "approval-token-1" });
    const handoffView = makeMcpHandoffView();
    const circle = makeCircleView({ id: testId("c1"), name: "Trip" });
    let completionAttempts = 0;
    vi.mocked(fetch).mockImplementation(async (input) => {
      if (String(input).includes("/authorize/handoff")) {
        return Response.json({ handoff: "signed-handoff" });
      }
      completionAttempts += 1;
      return completionAttempts === 1
        ? Response.json({ error: "temporarily_unavailable", retryable: true }, { status: 503 })
        : Response.json({ redirectTo: "https://client.example/callback?code=oauth-code" });
    });
    configureConvex({
      mcpHandoff: handoffView,
      circles: [circle],
      approveMcpAuthorization: approve,
    });
    renderAuthorize();

    const circleCheckbox = await screen.findByRole("checkbox", { name: /Trip/i });
    await user.click(circleCheckbox);
    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/try again/i);
    expect(circleCheckbox).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    expect(approve).toHaveBeenCalledTimes(1);
    const completionCalls = vi
      .mocked(fetch)
      .mock.calls.filter((call) => String(call[0]).includes("/authorize/complete"));
    expect(completionCalls).toHaveLength(2);
    for (const call of completionCalls) {
      expect(call[1]).toEqual(
        expect.objectContaining({
          body: JSON.stringify({
            approvalToken: "approval-token-1",
            handoffId: handoffView.handoffId,
          }),
        }),
      );
    }
  });

  it("creates a fresh approval after a definitive completion rejection", async () => {
    const user = userEvent.setup();
    const approve = vi
      .fn()
      .mockResolvedValueOnce({ approvalToken: "approval-token-1" })
      .mockResolvedValueOnce({ approvalToken: "approval-token-2" });
    const handoffView = makeMcpHandoffView();
    const circle = makeCircleView({ id: testId("c1"), name: "Trip" });
    let completionAttempts = 0;
    vi.mocked(fetch).mockImplementation(async (input) => {
      if (String(input).includes("/authorize/handoff")) {
        return Response.json({ handoff: "signed-handoff" });
      }
      completionAttempts += 1;
      return completionAttempts === 1
        ? Response.json({ error: "expired", retryable: false }, { status: 400 })
        : Response.json({ redirectTo: "https://client.example/callback?code=oauth-code" });
    });
    configureConvex({
      mcpHandoff: handoffView,
      circles: [circle],
      approveMcpAuthorization: approve,
    });
    renderAuthorize();

    const circleCheckbox = await screen.findByRole("checkbox", { name: /Trip/i });
    await user.click(circleCheckbox);
    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/try again/i);
    expect(circleCheckbox).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(approve).toHaveBeenCalledTimes(2));
    const completionBodies = vi
      .mocked(fetch)
      .mock.calls.filter((call) => String(call[0]).includes("/authorize/complete"))
      .map((call) => call[1]?.body);
    expect(completionBodies).toEqual([
      JSON.stringify({ approvalToken: "approval-token-1", handoffId: handoffView.handoffId }),
      JSON.stringify({ approvalToken: "approval-token-2", handoffId: handoffView.handoffId }),
    ]);
  });

  it("does not render an image for client logo to avoid untrusted outbound requests", () => {
    configureConvex({
      mcpHandoff: makeMcpHandoffView({
        logoUri: "https://untrusted.example/logo.png",
      }),
      circles: [makeCircleView()],
    });
    const { container } = renderAuthorize();

    expect(container.querySelector("img")).toBeNull();
  });

  it("refuses to render when framed in an iframe", async () => {
    const originalTop = window.top;
    try {
      Object.defineProperty(window, "top", {
        value: {},
        writable: true,
        configurable: true,
      });
      configureConvex({
        mcpHandoff: makeMcpHandoffView(),
        circles: [makeCircleView()],
      });
      renderAuthorize();

      expect(await screen.findByRole("alert")).toHaveTextContent(
        /cannot be loaded within a frame/i,
      );
      expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument();
    } finally {
      Object.defineProperty(window, "top", {
        value: originalTop,
        writable: true,
        configurable: true,
      });
    }
  });
});
