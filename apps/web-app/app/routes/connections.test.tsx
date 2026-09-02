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
    const revokeMcpConnection = vi.fn().mockResolvedValue({
      ok: true,
      value: { cleanupToken: "cleanup-token", cleanupStatus: "pending_revoke" },
    });
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

  it("does not claim Worker cleanup finished when exhausted retry cannot run", async () => {
    const revokeMcpConnection = vi.fn().mockResolvedValue({
      ok: true,
      value: { cleanupToken: null, cleanupStatus: "exhausted" },
    });
    const connection = makeMcpConnectionView({
      status: "revoked",
      workerCleanupStatus: "exhausted",
    });
    configureConvex({
      currentUser: makeCurrentUserView(),
      mcpConnections: [connection],
      revokeMcpConnection,
    });
    const user = userEvent.setup();
    renderConnections();

    await user.click(await screen.findByRole("button", { name: "Retry cleanup" }));

    await waitFor(() => {
      expect(revokeMcpConnection).toHaveBeenCalledWith({ connectionId: connection.id });
    });
    expect(
      await screen.findByText("PocketCircle access revoked; Worker cleanup is pending."),
    ).toBeVisible();
    expect(screen.queryByText("Connection revoked.")).not.toBeInTheDocument();
  });

  it("does not claim access was revoked when Convex revocation fails", async () => {
    const revokeMcpConnection = vi.fn().mockRejectedValue(new Error("Convex unavailable"));
    const connection = makeMcpConnectionView();
    configureConvex({
      currentUser: makeCurrentUserView(),
      mcpConnections: [connection],
      revokeMcpConnection,
    });
    const user = userEvent.setup();
    renderConnections();

    await user.click(await screen.findByRole("button", { name: "Revoke" }));
    await user.click(screen.getByRole("button", { name: "Revoke connection" }));

    expect(
      await screen.findByText(
        "Could not revoke this connection. PocketCircle access was not changed; try again.",
      ),
    ).toBeVisible();
    expect(screen.getByRole("dialog")).toBeVisible();
  });
});
