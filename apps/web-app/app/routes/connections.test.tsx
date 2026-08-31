import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SnackbarProvider } from "~/lib/snackbar.js";
import {
  configureConvex,
  convexReactMock,
  makeCurrentUserView,
  makeMcpConnectionView,
} from "~/test/convex-react.js";
import Connections from "./connections.js";

vi.mock("convex/react", async () => (await import("~/test/convex-react.js")).convexReactMock);

function renderConnections() {
  return render(
    <SnackbarProvider>
      <MemoryRouter>
        <Connections />
      </MemoryRouter>
    </SnackbarProvider>,
  );
}

beforeEach(() => {
  convexReactMock.useConvexAuth.mockReturnValue({ isAuthenticated: true, isLoading: false });
  vi.stubEnv("VITE_MCP_WORKER_ORIGIN", "https://mcp.pocketcircle.app");
});

describe("Connections", () => {
  it("lists safe connection metadata without credential fields", async () => {
    const connection = makeMcpConnectionView();
    configureConvex({
      currentUser: makeCurrentUserView(),
      mcpConnections: [connection],
    });
    renderConnections();

    expect(await screen.findByRole("heading", { name: "Connections" })).toBeVisible();
    expect(screen.getByText("Example Client")).toBeVisible();
    expect(screen.getByText(connection.clientId)).toBeVisible();
    expect(screen.getByText(connection.clientUri ?? "Not provided")).toBeVisible();
    expect(screen.getByText(connection.redirectUri)).toBeVisible();
    expect(screen.getByText("Shared Trip")).toBeVisible();
    expect(screen.queryByText("worker-grant-opaque")).not.toBeInTheDocument();
    expect(screen.queryByText("cleanup-token")).not.toBeInTheDocument();
  });

  it("confirms the exact client, revokes Convex access, and completes Worker cleanup", async () => {
    const revokeMcpConnection = vi
      .fn()
      .mockResolvedValue({ ok: true, value: { cleanupToken: "cleanup-token" } });
    const workerFetch = vi.fn().mockResolvedValue(Response.json({ revoked: true }));
    vi.spyOn(globalThis, "fetch").mockImplementation(workerFetch);
    const connection = makeMcpConnectionView();
    configureConvex({
      currentUser: makeCurrentUserView(),
      mcpConnections: [connection],
      revokeMcpConnection,
    });
    const user = userEvent.setup();
    renderConnections();

    await user.click(await screen.findByRole("button", { name: "Revoke" }));
    expect(screen.getByRole("dialog")).toHaveTextContent(connection.clientId);
    expect(screen.getByRole("button", { name: "Revoke connection" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Revoke connection" }));

    await waitFor(() => {
      expect(revokeMcpConnection).toHaveBeenCalledWith({ connectionId: connection.id });
    });
    expect(workerFetch).toHaveBeenCalledTimes(1);
    expect(String(workerFetch.mock.calls[0]?.[0])).toBe("https://mcp.pocketcircle.app/revoke");
    expect(workerFetch.mock.calls[0]?.[1]).toMatchObject({ method: "POST" });
    expect(await screen.findByText("Connection revoked.")).toBeVisible();
    workerFetch.mockRestore();
  });
});
