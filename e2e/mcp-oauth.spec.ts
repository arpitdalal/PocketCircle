import { createHash, randomBytes, randomUUID } from "node:crypto";
import { expect, test } from "./fixtures.js";

const WORKER_ORIGIN = process.env.MCP_E2E_WORKER_ORIGIN;
const PROVISIONING_TOKEN = process.env.MCP_E2E_CLIENT_PROVISIONING_TOKEN;
const APP_ORIGIN = "http://127.0.0.1:5173";
const REDIRECT_URI = `${APP_ORIGIN}/mcp/authorize`;

function compactSha256(value: string) {
  return createHash("sha256").update(value).digest("base64url");
}

function requiredString(value: unknown, field: string) {
  if (typeof value !== "object" || value === null || !(field in value)) {
    throw new Error(`Missing ${field}`);
  }
  const candidate = Reflect.get(value, field);
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new Error(`Invalid ${field}`);
  }
  return candidate;
}

test.describe("local MCP OAuth", () => {
  test.skip(
    !WORKER_ORIGIN || !PROVISIONING_TOKEN,
    "Run through scripts/e2e-local.sh to boot the real local MCP Worker",
  );

  /** Real browser + Convex + Wrangler KV/DO. Only Google login uses ADR 0019 test auth. */
  test("a signed-in member authorizes a public MCP client and exchanges the code", async ({
    page,
    request,
  }) => {
    if (!WORKER_ORIGIN || !PROVISIONING_TOKEN) {
      throw new Error("Missing local MCP E2E configuration");
    }

    const metadataRes = await request.get(
      `${WORKER_ORIGIN}/.well-known/oauth-authorization-server`,
    );
    expect(metadataRes.status()).toBe(200);

    const provision = await request.post(`${WORKER_ORIGIN}/admin/oauth/clients`, {
      headers: { authorization: `Bearer ${PROVISIONING_TOKEN}` },
      data: {
        clientName: "PocketCircle local E2E client",
        redirectUris: [REDIRECT_URI],
      },
    });
    expect([200, 201]).toContain(provision.status());
    const provisioned: unknown = await provision.json();
    const clientId = requiredString(provisioned, "clientId");

    const verifier = randomBytes(32).toString("base64url");
    const state = randomUUID();
    const resource = `${WORKER_ORIGIN}/mcp`;
    const authorize = new URL("/authorize", WORKER_ORIGIN);
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      scope: "pocketcircle:read",
      state,
      code_challenge: compactSha256(verifier),
      code_challenge_method: "S256",
      resource,
    }).toString();

    await page.goto(authorize.toString());
    await expect(page.getByRole("heading", { name: "Authorize access" })).toBeVisible();
    await expect(page).toHaveURL(new RegExp(`^${APP_ORIGIN}/mcp/authorize\\?handoffId=`));

    const circleSection = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Circles", exact: true }),
    });
    const circleChoice = circleSection.getByRole("checkbox").first();
    await expect(circleChoice).toBeVisible();
    await circleChoice.check();

    await Promise.all([
      page.waitForURL((url) => url.pathname === "/mcp/authorize" && url.searchParams.has("code"), {
        timeout: 60_000,
      }),
      page.getByRole("button", { name: "Approve" }).click(),
    ]);

    const callback = new URL(page.url());
    expect(callback.searchParams.get("state")).toBe(state);
    const code = callback.searchParams.get("code");
    expect(code).toBeTruthy();

    const exchanged = await request.post(`${WORKER_ORIGIN}/token`, {
      form: {
        grant_type: "authorization_code",
        code: code ?? "",
        redirect_uri: REDIRECT_URI,
        client_id: clientId,
        code_verifier: verifier,
        resource,
      },
    });
    expect(exchanged.status()).toBe(200);
    const tokens: unknown = await exchanged.json();
    expect(requiredString(tokens, "token_type").toLowerCase()).toBe("bearer");
    const accessToken = requiredString(tokens, "access_token");
    const refreshToken = requiredString(tokens, "refresh_token");

    const refreshed = await request.post(`${WORKER_ORIGIN}/token`, {
      form: {
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        resource,
      },
    });
    const refreshedTokens: unknown = await refreshed.json();
    const activeAccessToken = requiredString(refreshedTokens, "access_token");
    expect(activeAccessToken).not.toBe(accessToken);

    async function postMcpRequest(
      method: string,
      id: number,
      params: Record<string, unknown> = {},
    ) {
      const toolName = typeof params.name === "string" ? params.name : undefined;
      return request.post(`${WORKER_ORIGIN}/mcp`, {
        headers: {
          authorization: `Bearer ${activeAccessToken}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": method,
          ...(toolName ? { "mcp-name": toolName } : {}),
        },
        data: {
          jsonrpc: "2.0",
          id,
          method,
          params: {
            ...params,
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {},
            },
          },
        },
      });
    }

    const listToolsRes = await postMcpRequest("tools/list", 1);
    expect(listToolsRes.status()).toBe(200);
    const listToolsBody: unknown = await listToolsRes.json();
    expect(listToolsBody).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        tools: [
          expect.objectContaining({ name: "get_current_user" }),
          expect.objectContaining({ name: "list_authorized_circles" }),
        ],
      },
    });

    const userToolRes = await postMcpRequest("tools/call", 2, {
      name: "get_current_user",
      arguments: {},
    });
    expect(userToolRes.status()).toBe(200);
    const userToolBody: unknown = await userToolRes.json();
    expect(userToolBody).toMatchObject({
      jsonrpc: "2.0",
      id: 2,
      result: {
        structuredContent: {
          id: expect.any(String),
          displayName: expect.any(String),
        },
      },
    });
    if (
      typeof userToolBody === "object" &&
      userToolBody !== null &&
      "result" in userToolBody &&
      typeof userToolBody.result === "object" &&
      userToolBody.result !== null &&
      "structuredContent" in userToolBody.result &&
      typeof userToolBody.result.structuredContent === "object" &&
      userToolBody.result.structuredContent !== null
    ) {
      expect("email" in userToolBody.result.structuredContent).toBe(false);
    } else {
      throw new Error("Missing structuredContent in user tool response");
    }

    const circlesToolRes = await postMcpRequest("tools/call", 3, {
      name: "list_authorized_circles",
      arguments: {},
    });
    expect(circlesToolRes.status()).toBe(200);
    const circlesToolBody: unknown = await circlesToolRes.json();
    expect(circlesToolBody).toMatchObject({
      jsonrpc: "2.0",
      id: 3,
      result: {
        structuredContent: {
          circles: expect.arrayContaining([
            expect.objectContaining({
              id: expect.any(String),
              ref: expect.any(String),
              name: expect.any(String),
            }),
          ]),
        },
      },
    });

    await page.goto("/connections");
    await expect(page.getByRole("heading", { name: "Connections", exact: true })).toBeVisible();
    await expect(page.getByText("PocketCircle local E2E client", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Revoke", exact: true }).click();
    const revokeDialog = page.getByRole("dialog");
    await expect(revokeDialog).toContainText(clientId);
    await revokeDialog.getByRole("button", { name: "Revoke connection", exact: true }).click();
    await expect(page.getByText("Connection revoked.", { exact: true })).toBeVisible();
    await expect(
      page
        .getByRole("article")
        .filter({ hasText: "PocketCircle local E2E client" })
        .getByText("Revoked", { exact: true }),
    ).toBeVisible();

    const rejectedAfterRevoke = await postMcpRequest("tools/call", 4, {
      name: "get_current_user",
      arguments: {},
    });
    expect([200, 401]).toContain(rejectedAfterRevoke.status());
    if (rejectedAfterRevoke.status() === 200) {
      expect(await rejectedAfterRevoke.json()).toMatchObject({
        jsonrpc: "2.0",
        id: 4,
        result: { isError: true },
      });
    }
  });
});
