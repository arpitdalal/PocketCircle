import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { APIRequestContext, Page } from "@playwright/test";
import {
  clickCircleChromeTab,
  createCategoryViaForm,
  expect,
  localPlainDate,
  openPersonalCircleFromHome,
  test,
} from "./fixtures.js";

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

function mcpStructuredContent(body: unknown) {
  if (typeof body !== "object" || body === null || !("result" in body)) {
    throw new Error("invalid MCP response");
  }
  const result = Reflect.get(body, "result");
  if (typeof result !== "object" || result === null || !("structuredContent" in result)) {
    throw new Error("missing structuredContent");
  }
  const structured = Reflect.get(result, "structuredContent");
  if (typeof structured !== "object" || structured === null) {
    throw new Error("bad structuredContent");
  }
  return structured;
}

async function provisionMcpClient(request: APIRequestContext, clientName: string) {
  const provision = await request.post(`${WORKER_ORIGIN}/admin/oauth/clients`, {
    headers: { authorization: `Bearer ${PROVISIONING_TOKEN}` },
    data: {
      clientName,
      redirectUris: [REDIRECT_URI],
    },
  });
  expect([200, 201]).toContain(provision.status());
  const provisioned: unknown = await provision.json();
  return requiredString(provisioned, "clientId");
}

async function authorizeMcpClient(
  page: Page,
  request: APIRequestContext,
  opts: {
    clientId: string;
    scope: string;
  },
) {
  const verifier = randomBytes(32).toString("base64url");
  const state = randomUUID();
  const resource = `${WORKER_ORIGIN}/mcp`;
  const authorize = new URL("/authorize", WORKER_ORIGIN);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: opts.clientId,
    redirect_uri: REDIRECT_URI,
    scope: opts.scope,
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
      client_id: opts.clientId,
      code_verifier: verifier,
      resource,
    },
  });
  expect(exchanged.status()).toBe(200);
  const tokens: unknown = await exchanged.json();
  return {
    accessToken: requiredString(tokens, "access_token"),
    refreshToken: requiredString(tokens, "refresh_token"),
    clientId: opts.clientId,
    resource,
  };
}

function createMcpPoster(request: APIRequestContext, accessToken: string) {
  return (method: string, id: number, params: Record<string, unknown> = {}) => {
    const toolName = typeof params.name === "string" ? params.name : undefined;
    return request.post(`${WORKER_ORIGIN}/mcp`, {
      headers: {
        authorization: `Bearer ${accessToken}`,
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
  };
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

    const clientId = await provisionMcpClient(request, "PocketCircle local E2E client");

    const authorized = await authorizeMcpClient(page, request, {
      clientId,
      scope: "pocketcircle:read",
    });
    const refreshed = await request.post(`${WORKER_ORIGIN}/token`, {
      form: {
        grant_type: "refresh_token",
        refresh_token: authorized.refreshToken,
        client_id: authorized.clientId,
        resource: authorized.resource,
      },
    });
    const refreshedTokens: unknown = await refreshed.json();
    const activeAccessToken = requiredString(refreshedTokens, "access_token");
    expect(activeAccessToken).not.toBe(authorized.accessToken);

    async function postMcpRequest(
      method: string,
      id: number,
      params: Record<string, unknown> = {},
    ) {
      return createMcpPoster(request, activeAccessToken)(method, id, params);
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

  test("authorizes write scope and creates a transaction through MCP", async ({
    page,
    request,
  }) => {
    if (!WORKER_ORIGIN || !PROVISIONING_TOKEN) {
      throw new Error("Missing local MCP E2E configuration");
    }

    const categoryName = `E2E MCP Cat ${Date.now()}`;
    const txnTitle = `E2E MCP Coffee ${Date.now()}`;
    await openPersonalCircleFromHome(page);
    await clickCircleChromeTab(page, "Categories");
    await createCategoryViaForm(page, { name: categoryName });

    const clientId = await provisionMcpClient(request, "PocketCircle local MCP write client");
    const authorized = await authorizeMcpClient(page, request, {
      clientId,
      scope: "pocketcircle:read pocketcircle:write",
    });
    const postMcp = createMcpPoster(request, authorized.accessToken);

    const circlesRes = await postMcp("tools/call", 1, {
      name: "list_authorized_circles",
      arguments: {},
    });
    expect(circlesRes.status()).toBe(200);
    const circlesContent = mcpStructuredContent(await circlesRes.json());
    if (!("circles" in circlesContent) || !Array.isArray(circlesContent.circles)) {
      throw new Error("missing circles");
    }
    const circle = circlesContent.circles[0];
    if (typeof circle !== "object" || circle === null) {
      throw new Error("missing circle");
    }
    const circleRef = requiredString(circle, "ref");
    const expectedCurrency = requiredString(circle, "currency");

    const categoriesRes = await postMcp("tools/call", 2, {
      name: "list_categories",
      arguments: { circleRef },
    });
    expect(categoriesRes.status()).toBe(200);
    const categoriesContent = mcpStructuredContent(await categoriesRes.json());
    if (!("page" in categoriesContent) || !Array.isArray(categoriesContent.page)) {
      throw new Error("missing categories page");
    }
    const matchedCategory = categoriesContent.page.find(
      (entry) =>
        typeof entry === "object" &&
        entry !== null &&
        "name" in entry &&
        Reflect.get(entry, "name") === categoryName,
    );
    if (typeof matchedCategory !== "object" || matchedCategory === null) {
      throw new Error("created category not found in MCP list");
    }
    const categoryRef = requiredString(matchedCategory, "ref");

    const createRes = await postMcp("tools/call", 3, {
      name: "create_transaction",
      arguments: {
        circleRef,
        type: "expense",
        title: txnTitle,
        amountMinorUnits: 500,
        date: localPlainDate(),
        categoryRefs: [categoryRef],
        expectedCurrency,
      },
    });
    expect(createRes.status()).toBe(200);
    const createdContent = mcpStructuredContent(await createRes.json());
    expect(createdContent).toMatchObject({
      ref: expect.any(String),
      transaction: expect.objectContaining({
        title: txnTitle,
        type: "expense",
      }),
    });

    const searchRes = await postMcp("tools/call", 4, {
      name: "search_transactions",
      arguments: {
        circleRef,
        filters: { query: txnTitle },
      },
    });
    expect(searchRes.status()).toBe(200);
    const searchContent = mcpStructuredContent(await searchRes.json());
    expect(searchContent).toMatchObject({
      transactions: expect.arrayContaining([
        expect.objectContaining({
          title: txnTitle,
          type: "expense",
        }),
      ]),
    });

    const updatedTitle = `${txnTitle} updated`;
    const createResBody = createdContent;
    const txnRef =
      typeof createResBody === "object" &&
      createResBody !== null &&
      "ref" in createResBody &&
      typeof Reflect.get(createResBody, "ref") === "string"
        ? Reflect.get(createResBody, "ref")
        : null;
    if (txnRef === null) {
      throw new Error("missing created transaction ref");
    }

    const updateRes = await postMcp("tools/call", 5, {
      name: "update_transaction",
      arguments: {
        circleRef,
        transactionRef: txnRef,
        title: updatedTitle,
      },
    });
    expect(updateRes.status()).toBe(200);
    const updatedContent = mcpStructuredContent(await updateRes.json());
    expect(updatedContent).toMatchObject({
      transaction: expect.objectContaining({ title: updatedTitle }),
    });

    const detailBeforeArchive = await postMcp("tools/call", 6, {
      name: "get_transaction",
      arguments: {
        circleRef,
        transactionRef: txnRef,
      },
    });
    expect(detailBeforeArchive.status()).toBe(200);
    const detailBeforeArchiveContent = mcpStructuredContent(await detailBeforeArchive.json());
    expect(detailBeforeArchiveContent).toMatchObject({
      title: updatedTitle,
      status: "active",
    });

    const searchAfterUpdate = await postMcp("tools/call", 7, {
      name: "search_transactions",
      arguments: {
        circleRef,
        filters: { query: updatedTitle },
      },
    });
    expect(searchAfterUpdate.status()).toBe(200);
    const searchAfterUpdateContent = mcpStructuredContent(await searchAfterUpdate.json());
    expect(searchAfterUpdateContent).toMatchObject({
      transactions: expect.arrayContaining([
        expect.objectContaining({
          title: updatedTitle,
        }),
      ]),
    });

    const archiveRes = await postMcp("tools/call", 8, {
      name: "archive_transaction",
      arguments: {
        circleRef,
        transactionRef: txnRef,
      },
    });
    expect(archiveRes.status()).toBe(200);
    const archivedContent = mcpStructuredContent(await archiveRes.json());
    expect(archivedContent).toMatchObject({
      transaction: expect.objectContaining({ title: updatedTitle, status: "archived" }),
    });

    const ledgerAfterArchive = await postMcp("tools/call", 9, {
      name: "get_monthly_ledger",
      arguments: {
        circleRef,
        month: localPlainDate().slice(0, 7),
      },
    });
    expect(ledgerAfterArchive.status()).toBe(200);
    const ledgerAfterArchiveContent = mcpStructuredContent(await ledgerAfterArchive.json());
    expect(ledgerAfterArchiveContent).toMatchObject({
      totals: { expenseMinor: 0 },
    });

    const restoreRes = await postMcp("tools/call", 10, {
      name: "restore_transaction",
      arguments: {
        circleRef,
        transactionRef: txnRef,
      },
    });
    expect(restoreRes.status()).toBe(200);
    const restoredContent = mcpStructuredContent(await restoreRes.json());
    expect(restoredContent).toMatchObject({
      transaction: expect.objectContaining({ title: updatedTitle, status: "active" }),
    });

    const ledgerAfterRestore = await postMcp("tools/call", 11, {
      name: "get_monthly_ledger",
      arguments: {
        circleRef,
        month: localPlainDate().slice(0, 7),
      },
    });
    expect(ledgerAfterRestore.status()).toBe(200);
    const ledgerAfterRestoreContent = mcpStructuredContent(await ledgerAfterRestore.json());
    expect(ledgerAfterRestoreContent).toMatchObject({
      totals: { expenseMinor: 500 },
    });
  });
});
