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

  it("loads the signed handoff from the Worker by handoffId", async () => {
    const handoffId = "550e8400-e29b-41d4-a716-446655440000";
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
      initialEntries: [`/mcp/authorize?handoffId=${handoffId}`],
    });

    expect(await screen.findByText("Example Client")).toBeInTheDocument();
    expect(String(vi.mocked(fetch).mock.calls[0]?.[0])).toBe(
      `${WORKER}/authorize/handoff?id=${handoffId}`,
    );
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

  it("refuses to render when framed in an iframe", () => {
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

      expect(screen.getByRole("alert")).toHaveTextContent(/cannot be loaded within a frame/i);
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
