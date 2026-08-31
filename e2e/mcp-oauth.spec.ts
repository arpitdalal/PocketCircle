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
    expect(refreshed.status()).toBe(200);
    expect(requiredString(await refreshed.json(), "access_token")).not.toBe(accessToken);
  });
});
