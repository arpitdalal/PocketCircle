import { createExecutionContext, env, SELF } from "cloudflare:test";
import { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { mcpOperationBodySchema, verifyMcpHandoff } from "@pocketcircle/domain";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { defaultHandler } from "./authorize.js";
import { createMcpApiHandler } from "./mcp-api.js";
import { oauthProviderOptions } from "./oauth-options.js";

const REDIRECT_URI = "https://mcp-client.example/callback";
const RESOURCE = "https://mcp.pocketcircle.app/mcp";
const HMAC_SECRET = "test-mcp-worker-secret";

let clientId = "";

afterEach(() => {
  vi.unstubAllGlobals();
});

beforeAll(async () => {
  // OAUTH_PROVIDER is injected during fetch; tests create clients via getOAuthApi.
  // createClient always mints the clientId — use the returned value.
  const created = await getOAuthApi(oauthProviderOptions(env, defaultHandler), env).createClient({
    tokenEndpointAuthMethod: "none",
    redirectUris: [REDIRECT_URI],
    clientName: "PocketCircle Dev Client",
    clientUri: "https://mcp-client.example",
  });
  clientId = created.clientId;
});

function authorizeUrl(params: Record<string, string>) {
  const url = new URL("https://mcp.pocketcircle.app/authorize");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url;
}

function browserFetch(input: RequestInfo | URL, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  headers.set("origin", "https://pocketcircle.app");
  return SELF.fetch(input, { ...init, headers });
}

const PKCE = {
  code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  code_challenge_method: "S256",
} as const;

async function startAuthorize(state: string) {
  const start = await SELF.fetch(
    authorizeUrl({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT_URI,
      scope: "pocketcircle:read",
      state,
      ...PKCE,
      resource: RESOURCE,
    }),
    { redirect: "manual" },
  );
  expect(start.status).toBe(302);
  const consent = new URL(start.headers.get("Location") ?? "");
  expect(consent.origin).toBe("https://pocketcircle.app");
  expect(consent.pathname).toBe("/mcp/authorize");
  const handoffId = consent.searchParams.get("handoffId");
  expect(handoffId).toBeTruthy();
  expect(consent.searchParams.get("handoff")).toBeNull();

  const loaded = await browserFetch(
    `https://mcp.pocketcircle.app/authorize/handoff?id=${handoffId}`,
  );
  expect(loaded.status).toBe(200);
  const body: unknown = await loaded.json();
  if (
    typeof body !== "object" ||
    body === null ||
    !("handoff" in body) ||
    typeof body.handoff !== "string"
  ) {
    throw new Error("missing handoff");
  }
  const payload = await verifyMcpHandoff(body.handoff, HMAC_SECRET);
  expect(payload?.handoffId).toBe(handoffId);
  return { handoffId: handoffId ?? "", handoff: body.handoff, payload };
}

function stubConvexFetch(handler: (path: string, body: unknown) => Response | Promise<Response>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      let body: unknown;
      if (init?.body && typeof init.body === "string") {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      }
      for (const endpoint of [
        "/mcp/redeem-approval",
        "/mcp/activate-grant",
        "/mcp/validate-grant",
        "/mcp/operation",
      ]) {
        if (url.includes(endpoint)) {
          return handler(endpoint, body);
        }
      }
      return Response.json({ ok: false, error: "unexpected" }, { status: 500 });
    }),
  );
}

describe("MCP Worker OAuth discovery", () => {
  it("publishes protected-resource and authorization-server metadata", async () => {
    const resourceMeta = await SELF.fetch(
      "https://mcp.pocketcircle.app/.well-known/oauth-protected-resource",
    );
    expect(resourceMeta.status).toBe(200);
    const resourceBody: unknown = await resourceMeta.json();
    expect(resourceBody).toMatchObject({
      resource: RESOURCE,
      authorization_servers: ["https://mcp.pocketcircle.app"],
    });

    const asMeta = await SELF.fetch(
      "https://mcp.pocketcircle.app/.well-known/oauth-authorization-server",
    );
    expect(asMeta.status).toBe(200);
    const asBody: unknown = await asMeta.json();
    expect(asBody).toMatchObject({
      issuer: "https://mcp.pocketcircle.app",
      authorization_endpoint: "https://mcp.pocketcircle.app/authorize",
      token_endpoint: "https://mcp.pocketcircle.app/token",
    });
    // DCR must stay disabled — no registration_endpoint in metadata.
    expect(asBody).not.toHaveProperty("registration_endpoint");
  });

  it("advertises the reachable Worker origin when the custom domain is not the request host", async () => {
    const origin = "https://pocketcircle-mcp-worker.workers.dev";
    const resourceMeta = await SELF.fetch(`${origin}/.well-known/oauth-protected-resource`);
    expect(resourceMeta.status).toBe(200);
    expect(await resourceMeta.json()).toMatchObject({
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
    });

    const asMeta = await SELF.fetch(`${origin}/.well-known/oauth-authorization-server`);
    expect(asMeta.status).toBe(200);
    expect(await asMeta.json()).toMatchObject({
      issuer: origin,
      authorization_endpoint: `${origin}/authorize`,
      token_endpoint: `${origin}/token`,
    });
  });

  it("does not expose a DCR registration route", async () => {
    const response = await SELF.fetch("https://mcp.pocketcircle.app/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it("rejects untrusted origin and host headers on MCP handler", async () => {
    const handler = createMcpApiHandler(env);
    const ctx = createExecutionContext();
    const untrustedOrigin = await handler.fetch(
      new Request("https://mcp.pocketcircle.app/mcp", {
        headers: {
          origin: "https://evil.example",
        },
      }),
      env,
      ctx,
    );
    expect(untrustedOrigin.status).toBe(403);

    const untrustedHost = await handler.fetch(new Request("https://evil.example/mcp"), env, ctx);
    expect(untrustedHost.status).toBe(403);
  });
});

describe("static OAuth client provisioning", () => {
  const metadata = {
    clientName: "PocketCircle Launch Client",
    clientUri: "https://launch-client.example",
    redirectUris: ["https://launch-client.example/oauth/callback"],
  };

  function provisionClient(
    body: unknown,
    token = "test-client-provisioning-token-at-least-32-bytes",
  ) {
    return SELF.fetch("https://mcp.pocketcircle.app/admin/oauth/clients", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  it("requires the provisioning secret", async () => {
    const response = await provisionClient(metadata, "wrong-token");
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  it("creates one constrained public client and safely replays the request", async () => {
    const created = await provisionClient(metadata);
    expect(created.status).toBe(201);
    const createdBody: unknown = await created.json();
    if (
      typeof createdBody !== "object" ||
      createdBody === null ||
      !("clientId" in createdBody) ||
      typeof createdBody.clientId !== "string"
    ) {
      throw new Error("missing provisioned client id");
    }
    expect(createdBody).toEqual({ clientId: createdBody.clientId, created: true });

    const repeated = await provisionClient({
      ...metadata,
      redirectUris: [
        "https://launch-client.example/oauth/callback",
        "https://launch-client.example/oauth/callback",
      ],
    });
    expect(repeated.status).toBe(200);
    expect(await repeated.json()).toEqual({ clientId: createdBody.clientId, created: false });

    const stored = await getOAuthApi(oauthProviderOptions(env, defaultHandler), env).lookupClient(
      createdBody.clientId,
    );
    expect(stored).toMatchObject({
      ...metadata,
      tokenEndpointAuthMethod: "none",
      grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"],
    });
    expect(stored?.clientSecret).toBeUndefined();
  });

  it("rejects unsafe or unbounded metadata", async () => {
    const unsafe = await provisionClient({
      ...metadata,
      redirectUris: ["javascript:alert(1)"],
    });
    expect(unsafe.status).toBe(400);

    const oversized = await provisionClient({
      ...metadata,
      clientName: "x".repeat(9_000),
    });
    expect(oversized.status).toBe(400);
  });
});

describe("authorization handoff", () => {
  it("rejects invalid resource parameter during authorization", async () => {
    const response = await SELF.fetch(
      authorizeUrl({
        response_type: "code",
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        scope: "pocketcircle:read",
        state: "bad-res-start",
        ...PKCE,
        resource: "https://evil.example/mcp",
      }),
      { redirect: "manual" },
    );
    expect(response.status).toBe(302);
    const location = response.headers.get("Location") ?? "";
    const redirect = new URL(location);
    expect(redirect.origin).toBe("https://mcp-client.example");
    expect(redirect.searchParams.get("error")).toBe("invalid_target");
    expect(redirect.searchParams.get("state")).toBe("bad-res-start");
  });

  it("stores AuthRequest server-side and redirects to SPA with handoffId", async () => {
    const started = await startAuthorize("client-state-1");
    expect(started.handoffId.length).toBeGreaterThan(0);
    expect(started.handoff.length).toBeGreaterThan(0);
  });

  it("rejects plain PKCE with an OAuth error redirect", async () => {
    const response = await SELF.fetch(
      authorizeUrl({
        response_type: "code",
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        scope: "pocketcircle:read",
        state: "pkce-plain",
        code_challenge: "plain-challenge",
        code_challenge_method: "plain",
        resource: RESOURCE,
      }),
      { redirect: "manual" },
    );
    expect(response.status).toBe(302);
    const location = response.headers.get("Location") ?? "";
    expect(location.startsWith(REDIRECT_URI)).toBe(true);
    expect(location).toContain("error=invalid_request");
    expect(location).toContain("plain");
    expect(location).not.toContain("/mcp/authorize");
  });

  it("rejects implicit flow (token response_type)", async () => {
    const response = await SELF.fetch(
      authorizeUrl({
        response_type: "token",
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        scope: "pocketcircle:read",
        state: "implicit",
        resource: RESOURCE,
      }),
      { redirect: "manual" },
    );
    expect(response.status).toBe(302);
    const location = response.headers.get("Location") ?? "";
    expect(location.startsWith(REDIRECT_URI)).toBe(true);
    expect(location).toContain("error=");
    expect(location).not.toContain("/mcp/authorize");
  });

  it("deny returns access_denied redirect without Convex grant activation", async () => {
    const { handoffId } = await startAuthorize("deny-me");

    const deny = await browserFetch("https://mcp.pocketcircle.app/authorize/deny", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handoffId }),
    });
    expect(deny.status).toBe(200);
    const body: unknown = await deny.json();
    expect(body).toMatchObject({ redirectTo: expect.stringContaining("error=access_denied") });
    if (typeof body === "object" && body !== null && "redirectTo" in body) {
      const redirectTo = String(body.redirectTo);
      expect(redirectTo).toContain("state=deny-me");
      expect(redirectTo.startsWith(REDIRECT_URI)).toBe(true);
    }

    // A lost browser response can retry denial without rebuilding OAuth state.
    const replay = await browserFetch("https://mcp.pocketcircle.app/authorize/deny", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handoffId }),
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(body);

    const afterConsume = await browserFetch(
      `https://mcp.pocketcircle.app/authorize/handoff?id=${handoffId}`,
    );
    expect(afterConsume.status).toBe(200);
    expect(await afterConsume.json()).toEqual(body);
  });

  it.each([
    { label: "missing", origin: undefined },
    { label: "foreign", origin: "https://attacker.example" },
  ])("rejects $label browser origin on handoff endpoints", async ({ origin }) => {
    const headers = new Headers({ "content-type": "application/json" });
    if (origin) {
      headers.set("origin", origin);
    }
    const response = await SELF.fetch("https://mcp.pocketcircle.app/authorize/deny", {
      method: "POST",
      headers,
      body: JSON.stringify({ handoffId: crypto.randomUUID() }),
    });
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("rejects non-JSON authorization mutations", async () => {
    const response = await browserFetch("https://mcp.pocketcircle.app/authorize/deny", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `handoffId=${encodeURIComponent(crypto.randomUUID())}`,
    });
    expect(response.status).toBe(400);
  });

  it("lets exactly one of concurrent complete and deny consume the handoff", async () => {
    const { handoffId } = await startAuthorize("race-me");

    stubConvexFetch((endpoint) => {
      if (endpoint === "/mcp/redeem-approval") {
        return Response.json({
          ok: true,
          value: {
            grantId: "grant_test",
            principalId: "principal_opaque",
            clientId,
            redirectUri: REDIRECT_URI,
            resource: RESOURCE,
            scopes: ["pocketcircle:read"],
            allowedCircleIds: ["circle_opaque"],
            handoffId,
          },
        });
      }
      if (endpoint === "/mcp/activate-grant") {
        return Response.json({ ok: true });
      }
      return Response.json({ ok: false, error: "unexpected" }, { status: 500 });
    });

    const [complete, deny] = await Promise.all([
      browserFetch("https://mcp.pocketcircle.app/authorize/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approvalToken: "approval-token", handoffId }),
      }),
      browserFetch("https://mcp.pocketcircle.app/authorize/deny", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handoffId }),
      }),
    ]);
    const statuses = [complete.status, deny.status];
    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    expect(statuses.filter((status) => status === 400)).toHaveLength(1);
  });

  it("coalesces concurrent completion without a stealable timeout lease", async () => {
    const { handoffId } = await startAuthorize("duplicate-completion");
    let redemptions = 0;
    stubConvexFetch(async (endpoint) => {
      if (endpoint !== "/mcp/redeem-approval") {
        return Response.json({ ok: false, error: "unexpected" }, { status: 500 });
      }
      redemptions += 1;
      await Promise.resolve();
      return Response.json({
        ok: true,
        value: {
          grantId: "grant_duplicate",
          principalId: "principal_duplicate",
          clientId,
          redirectUri: REDIRECT_URI,
          resource: RESOURCE,
          scopes: ["pocketcircle:read"],
          allowedCircleIds: ["circle_opaque"],
          handoffId,
        },
      });
    });
    const request = () =>
      browserFetch("https://mcp.pocketcircle.app/authorize/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approvalToken: "approval-duplicate", handoffId }),
      });

    const [first, second] = await Promise.all([request(), request()]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await first.json()).toEqual(await second.json());
    expect(redemptions).toBe(1);
  });

  it("complete rejects when Convex redeem fails (grant logic stays on Convex)", async () => {
    stubConvexFetch((endpoint) => {
      if (endpoint === "/mcp/redeem-approval") {
        return Response.json({ ok: false, error: "not_found" }, { status: 400 });
      }
      return Response.json({ ok: false, error: "unexpected" }, { status: 500 });
    });

    const complete = await browserFetch("https://mcp.pocketcircle.app/authorize/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        approvalToken: "bogus-token",
        handoffId: "550e8400-e29b-41d4-a716-446655440000",
      }),
    });
    expect(complete.status).toBe(400);
  });

  it.each([
    { label: "definitive 400", status: 400, body: { ok: false, error: "expired" }, expected: 400 },
    {
      label: "unauthorized",
      status: 401,
      body: { ok: false, error: "unauthorized" },
      expected: 503,
    },
    { label: "throttled", status: 429, body: { ok: false, error: "throttled" }, expected: 503 },
    { label: "upstream outage", status: 503, body: { ok: false, error: "outage" }, expected: 503 },
    {
      label: "logical failure on 200",
      status: 200,
      body: { ok: false, error: "failed" },
      expected: 503,
    },
    { label: "malformed success", status: 200, body: { ok: true }, expected: 503 },
  ])(
    "classifies Convex $label without consuming retryable claims",
    async ({ status, body, expected }) => {
      const { handoffId } = await startAuthorize(`bridge-${status}-${expected}`);
      stubConvexFetch((endpoint) =>
        endpoint === "/mcp/redeem-approval"
          ? Response.json(body, { status })
          : Response.json({ ok: false, error: "unexpected" }, { status: 500 }),
      );

      const response = await browserFetch("https://mcp.pocketcircle.app/authorize/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approvalToken: `approval-${status}-${expected}`, handoffId }),
      });
      expect(response.status).toBe(expected);
    },
  );

  it("treats a 400 success-shaped Convex response as retryable protocol failure", async () => {
    const { handoffId } = await startAuthorize("bridge-inconsistent");
    stubConvexFetch((endpoint) =>
      endpoint === "/mcp/redeem-approval"
        ? Response.json(
            {
              ok: true,
              value: {
                grantId: "grant_inconsistent",
                principalId: "principal_inconsistent",
                clientId,
                redirectUri: REDIRECT_URI,
                resource: RESOURCE,
                scopes: ["pocketcircle:read"],
                allowedCircleIds: ["circle_opaque"],
                handoffId,
              },
            },
            { status: 400 },
          )
        : Response.json({ ok: false, error: "unexpected" }, { status: 500 }),
    );
    const response = await browserFetch("https://mcp.pocketcircle.app/authorize/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approvalToken: "approval-inconsistent", handoffId }),
    });
    expect(response.status).toBe(503);
  });

  it("complete redeems via Convex then finishes OAuth against the stored AuthRequest", async () => {
    const { handoffId } = await startAuthorize("approve-me");

    // Stub only the Worker→Convex HTTP boundary. AuthRequest + OAuth code path
    // use real Worker KV / OAuthProvider (grant mutations covered in Convex tests).
    stubConvexFetch((endpoint) => {
      if (endpoint === "/mcp/redeem-approval") {
        return Response.json({
          ok: true,
          value: {
            grantId: "grant_test",
            principalId: "principal_opaque",
            clientId,
            redirectUri: REDIRECT_URI,
            resource: RESOURCE,
            scopes: ["pocketcircle:read"],
            allowedCircleIds: ["circle_opaque"],
            handoffId,
          },
        });
      }
      if (endpoint === "/mcp/activate-grant") {
        return Response.json({ ok: true });
      }
      return Response.json({ ok: false, error: "unexpected" }, { status: 500 });
    });

    const complete = await browserFetch("https://mcp.pocketcircle.app/authorize/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approvalToken: "approval-token", handoffId }),
    });
    expect(complete.status).toBe(200);
    const body: unknown = await complete.json();
    expect(body).toMatchObject({
      redirectTo: expect.stringMatching(
        new RegExp(`^${REDIRECT_URI.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\?`),
      ),
    });
    if (typeof body !== "object" || body === null || !("redirectTo" in body)) {
      throw new Error("missing redirectTo");
    }
    const redirectTo = String(body.redirectTo);
    expect(redirectTo).toContain("code=");
    expect(redirectTo).toContain("state=approve-me");
    // Approval token and grant/circle ids must not appear as query metadata.
    // Provider encodes opaque principalId into the auth code (userId) — expected.
    expect(redirectTo).not.toContain("approval-token");
    expect(redirectTo).not.toContain("grant_test");
    expect(redirectTo).not.toContain("circle_opaque");

    const code = new URL(redirectTo).searchParams.get("code");
    expect(code).toBeTruthy();

    // RFC 7636 appendix B verifier matching the S256 challenge used above.
    const codeVerifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const tokenResponse = await SELF.fetch("https://mcp.pocketcircle.app/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code ?? "",
        redirect_uri: REDIRECT_URI,
        client_id: clientId,
        code_verifier: codeVerifier,
        resource: RESOURCE,
      }),
    });
    expect(tokenResponse.status).toBe(200);
    const tokens: unknown = await tokenResponse.json();
    expect(tokens).toMatchObject({
      token_type: "bearer",
      access_token: expect.any(String),
      refresh_token: expect.any(String),
    });

    // Refresh still validates live grant (stub Convex validate) and cannot broaden.
    const refreshToken =
      typeof tokens === "object" &&
      tokens !== null &&
      "refresh_token" in tokens &&
      typeof tokens.refresh_token === "string"
        ? tokens.refresh_token
        : "";
    expect(refreshToken.length).toBeGreaterThan(0);

    stubConvexFetch((endpoint) => {
      if (endpoint === "/mcp/validate-grant") {
        return Response.json({ ok: false, error: "temporarily_unavailable" }, { status: 503 });
      }
      return Response.json({ ok: false, error: "unexpected" }, { status: 500 });
    });

    const refreshUnavailable = await SELF.fetch("https://mcp.pocketcircle.app/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        resource: RESOURCE,
      }),
    });
    expect(refreshUnavailable.status).toBe(503);

    stubConvexFetch((endpoint) =>
      endpoint === "/mcp/validate-grant"
        ? Response.json({ ok: true })
        : Response.json({ ok: false, error: "unexpected" }, { status: 500 }),
    );
    const refreshOk = await SELF.fetch("https://mcp.pocketcircle.app/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        resource: RESOURCE,
      }),
    });
    expect(refreshOk.status).toBe(200);

    // Lost browser response: retry returns the same redirect and does not create
    // another logical completion.
    stubConvexFetch((endpoint) => {
      if (endpoint === "/mcp/redeem-approval") {
        return Response.json({
          ok: true,
          value: {
            grantId: "grant_test",
            principalId: "principal_opaque",
            clientId,
            redirectUri: REDIRECT_URI,
            resource: RESOURCE,
            scopes: ["pocketcircle:read"],
            allowedCircleIds: ["circle_opaque"],
            handoffId,
          },
        });
      }
      return Response.json({ ok: false, error: "unexpected" }, { status: 500 });
    });
    const replay = await browserFetch("https://mcp.pocketcircle.app/authorize/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approvalToken: "approval-token", handoffId }),
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ redirectTo });
  });

  it("retains a claimed handoff when OAuth completion fails transiently", async () => {
    const { handoffId } = await startAuthorize("retry-completion");
    stubConvexFetch((endpoint) => {
      if (endpoint === "/mcp/redeem-approval") {
        return Response.json({
          ok: true,
          value: {
            grantId: "grant_retry",
            principalId: "principal_retry",
            clientId,
            redirectUri: REDIRECT_URI,
            resource: RESOURCE,
            scopes: ["pocketcircle:read"],
            allowedCircleIds: ["circle_opaque"],
            handoffId,
          },
        });
      }
      return Response.json({ ok: false, error: "unexpected" }, { status: 500 });
    });
    const clientKey = `client:${clientId}`;
    const storedClient = await env.OAUTH_KV.get(clientKey);
    if (!storedClient) {
      throw new Error("missing test OAuth client");
    }
    await env.OAUTH_KV.delete(clientKey);

    const first = await browserFetch("https://mcp.pocketcircle.app/authorize/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approvalToken: "approval-token-retry", handoffId }),
    });
    expect(first.status).toBe(503);

    await env.OAUTH_KV.put(clientKey, storedClient);
    const retry = await browserFetch(
      `https://mcp.pocketcircle.app/authorize/handoff?id=${handoffId}`,
    );
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({
      redirectTo: expect.stringContaining("state=retry-completion"),
    });
  });

  it("keeps an existing Worker grant until the replacement code is exchanged", async () => {
    const principalId = `principal_parallel_${crypto.randomUUID()}`;
    for (const index of [1, 2]) {
      const { handoffId } = await startAuthorize(`parallel-${index}`);
      stubConvexFetch((endpoint) =>
        endpoint === "/mcp/redeem-approval"
          ? Response.json({
              ok: true,
              value: {
                grantId: `grant_parallel_${index}`,
                principalId,
                clientId,
                redirectUri: REDIRECT_URI,
                resource: RESOURCE,
                scopes: ["pocketcircle:read"],
                allowedCircleIds: ["circle_opaque"],
                handoffId,
              },
            })
          : Response.json({ ok: false, error: "unexpected" }, { status: 500 }),
      );
      const complete = await browserFetch("https://mcp.pocketcircle.app/authorize/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approvalToken: `approval-parallel-${index}`, handoffId }),
      });
      expect(complete.status).toBe(200);
    }

    const grants = await getOAuthApi(oauthProviderOptions(env, defaultHandler), env).listUserGrants(
      principalId,
    );
    expect(grants.items).toHaveLength(2);
  });

  it("revokes the Worker grant when Convex definitively rejects activation", async () => {
    const { handoffId } = await startAuthorize("activation-rejected");
    const principalId = "principal_activation_rejected";
    stubConvexFetch((endpoint) => {
      if (endpoint === "/mcp/redeem-approval") {
        return Response.json({
          ok: true,
          value: {
            grantId: "grant_activation_rejected",
            principalId,
            clientId,
            redirectUri: REDIRECT_URI,
            resource: RESOURCE,
            scopes: ["pocketcircle:read"],
            allowedCircleIds: ["circle_opaque"],
            handoffId,
          },
        });
      }
      if (endpoint === "/mcp/activate-grant") {
        return Response.json({ ok: false, error: "invalid_transition" }, { status: 400 });
      }
      return Response.json({ ok: false, error: "unexpected" }, { status: 500 });
    });
    const complete = await browserFetch("https://mcp.pocketcircle.app/authorize/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approvalToken: "approval-token-rejected", handoffId }),
    });
    const completed: unknown = await complete.json();
    if (
      typeof completed !== "object" ||
      completed === null ||
      !("redirectTo" in completed) ||
      typeof completed.redirectTo !== "string"
    ) {
      throw new Error("missing authorization redirect");
    }
    const code = new URL(completed.redirectTo).searchParams.get("code") ?? "";

    const tokenResponse = await SELF.fetch("https://mcp.pocketcircle.app/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: clientId,
        code_verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
        resource: RESOURCE,
      }),
    });

    expect(tokenResponse.status).toBe(400);
    expect(await tokenResponse.json()).toMatchObject({ error: "invalid_grant" });
    expect(
      (
        await getOAuthApi(oauthProviderOptions(env, defaultHandler), env).listUserGrants(
          principalId,
        )
      ).items,
    ).toEqual([]);
  });

  it("complete rejects resource mismatch between handoff and redeemed grant", async () => {
    const { handoffId } = await startAuthorize("bad-resource");

    stubConvexFetch((endpoint) => {
      if (endpoint === "/mcp/redeem-approval") {
        return Response.json({
          ok: true,
          value: {
            grantId: "grant_test",
            principalId: "principal_opaque",
            clientId,
            redirectUri: REDIRECT_URI,
            resource: "https://evil.example/mcp",
            scopes: ["pocketcircle:read"],
            allowedCircleIds: ["circle_opaque"],
            handoffId,
          },
        });
      }
      return Response.json({ ok: false, error: "unexpected" }, { status: 500 });
    });

    const complete = await browserFetch("https://mcp.pocketcircle.app/authorize/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approvalToken: "approval-token", handoffId }),
    });
    expect(complete.status).toBe(400);
    const body: unknown = await complete.json();
    expect(body).toMatchObject({ error: "handoff_grant_mismatch" });
  });

  it.each([
    {
      label: "wrong client",
      override: { clientId: "https://other-client.example/client.json" },
    },
    {
      label: "wrong redirect",
      override: { redirectUri: "https://evil.example/callback" },
    },
  ])("complete rejects $label between handoff and redeemed grant", async ({ override }) => {
    const { handoffId } = await startAuthorize("mismatch");

    stubConvexFetch((endpoint) => {
      if (endpoint === "/mcp/redeem-approval") {
        return Response.json({
          ok: true,
          value: {
            grantId: "grant_test",
            principalId: "principal_opaque",
            clientId,
            redirectUri: REDIRECT_URI,
            resource: RESOURCE,
            scopes: ["pocketcircle:read"],
            allowedCircleIds: ["circle_opaque"],
            handoffId,
            ...override,
          },
        });
      }
      return Response.json({ ok: false, error: "unexpected" }, { status: 500 });
    });

    const complete = await browserFetch("https://mcp.pocketcircle.app/authorize/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approvalToken: "approval-token", handoffId }),
    });
    expect(complete.status).toBe(400);
    expect(await complete.json()).toMatchObject({ error: "handoff_grant_mismatch" });
  });
});

describe("MCP tools execution", () => {
  async function obtainAccessToken(scopes = ["pocketcircle:read"]) {
    const { handoffId } = await startAuthorize(`tools-state-${Math.random()}`);
    const principalId = `principal-${Math.random()}`;
    const grantId = `grant-${Math.random()}`;

    stubConvexFetch((endpoint) => {
      if (endpoint === "/mcp/redeem-approval") {
        return Response.json({
          ok: true,
          value: {
            grantId,
            principalId,
            clientId,
            redirectUri: REDIRECT_URI,
            resource: RESOURCE,
            scopes,
            allowedCircleIds: ["circle_1"],
            handoffId,
          },
        });
      }
      if (endpoint === "/mcp/activate-grant") {
        return Response.json({ ok: true });
      }
      return Response.json({ ok: false, error: "unexpected" }, { status: 500 });
    });

    const complete = await browserFetch("https://mcp.pocketcircle.app/authorize/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approvalToken: "approval-token", handoffId }),
    });
    const completed: unknown = await complete.json();
    if (
      typeof completed !== "object" ||
      completed === null ||
      !("redirectTo" in completed) ||
      typeof completed.redirectTo !== "string"
    ) {
      throw new Error("missing authorization redirect");
    }
    const code = new URL(completed.redirectTo).searchParams.get("code") ?? "";

    const tokenResponse = await SELF.fetch("https://mcp.pocketcircle.app/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: clientId,
        code_verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk",
        resource: RESOURCE,
      }),
    });
    expect(tokenResponse.status).toBe(200);
    const tokenJson: unknown = await tokenResponse.json();
    if (
      typeof tokenJson !== "object" ||
      tokenJson === null ||
      !("access_token" in tokenJson) ||
      typeof tokenJson.access_token !== "string"
    ) {
      throw new Error("missing access token");
    }
    return { accessToken: tokenJson.access_token, grantId, principalId };
  }

  async function connectMcpClient(accessToken: string) {
    const client = new Client({ name: "pocketcircle-test-client", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(
      new URL("https://mcp.pocketcircle.app/mcp"),
      {
        fetch: (url, init) => {
          const headers = new Headers(init?.headers);
          if (!headers.has("host")) {
            headers.set("host", "mcp.pocketcircle.app");
          }
          if (!headers.has("authorization")) {
            headers.set("authorization", `Bearer ${accessToken}`);
          }
          return SELF.fetch(url, { ...init, headers });
        },
      },
    );
    await client.connect(transport);
    return client;
  }

  it("lists get_current_user and list_authorized_circles tools", async () => {
    const { accessToken } = await obtainAccessToken();
    const client = await connectMcpClient(accessToken);

    const result = await client.listTools();
    expect(result.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "get_current_user" }),
        expect.objectContaining({ name: "list_authorized_circles" }),
      ]),
    );
    await client.close();
  });

  it("calls get_current_user and returns safe user identity", async () => {
    const { accessToken, grantId } = await obtainAccessToken();

    stubConvexFetch((endpoint, body) => {
      if (endpoint === "/mcp/operation") {
        const opBody = mcpOperationBodySchema.safeParse(body);
        if (!opBody.success) {
          return Response.json({ ok: false, error: "invalid_body" }, { status: 400 });
        }
        expect(opBody.data.grantId).toBe(grantId);
        expect(opBody.data.operation.kind).toBe("get_current_user");
        return Response.json({
          ok: true,
          value: {
            id: "user_123",
            displayName: "Ada Lovelace",
            image: null,
            createdAt: 1700000000000,
          },
        });
      }
      return Response.json({ ok: false, error: "unexpected" }, { status: 500 });
    });

    const client = await connectMcpClient(accessToken);
    const result = await client.callTool({
      name: "get_current_user",
      arguments: {},
    });

    expect(result).toMatchObject({
      structuredContent: {
        id: "user_123",
        displayName: "Ada Lovelace",
        image: null,
        createdAt: 1700000000000,
      },
    });
    await client.close();
  });

  it("calls list_authorized_circles and returns authorized circles", async () => {
    const { accessToken, grantId } = await obtainAccessToken();

    stubConvexFetch((endpoint, body) => {
      if (endpoint === "/mcp/operation") {
        const opBody = mcpOperationBodySchema.safeParse(body);
        if (!opBody.success) {
          return Response.json({ ok: false, error: "invalid_body" }, { status: 400 });
        }
        expect(opBody.data.grantId).toBe(grantId);
        expect(opBody.data.operation.kind).toBe("list_authorized_circles");
        return Response.json({
          ok: true,
          value: {
            circles: [
              {
                id: "circle_1",
                ref: "my-home-circle_1",
                name: "My Home",
                kind: "personal",
                currency: "USD",
                color: "sage",
                mark: "home",
                status: "active",
                setupComplete: true,
                currencyLocked: true,
                isOwner: true,
              },
              {
                id: "circle_2",
                ref: "trip-circle_2",
                name: "Trip",
                kind: "regular",
                currency: "EUR",
                color: "ocean",
                mark: "plane",
                status: "active",
                setupComplete: true,
                currencyLocked: false,
                isOwner: false,
              },
            ],
          },
        });
      }
      return Response.json({ ok: false, error: "unexpected" }, { status: 500 });
    });

    const client = await connectMcpClient(accessToken);
    const result = await client.callTool({
      name: "list_authorized_circles",
      arguments: {},
    });

    expect(result).toMatchObject({
      structuredContent: {
        circles: [
          expect.objectContaining({
            id: "circle_1",
            ref: "my-home-circle_1",
            name: "My Home",
            kind: "personal",
            isOwner: true,
          }),
          expect.objectContaining({
            id: "circle_2",
            ref: "trip-circle_2",
            name: "Trip",
            kind: "regular",
            isOwner: false,
          }),
        ],
      },
    });
    await client.close();
  });

  it("returns a tool error when bridge operation fails", async () => {
    const { accessToken } = await obtainAccessToken();

    stubConvexFetch((endpoint) => {
      if (endpoint === "/mcp/operation") {
        return Response.json(
          {
            ok: false,
            error: "insufficient_scope",
          },
          { status: 400 },
        );
      }
      return Response.json({ ok: false, error: "unexpected" }, { status: 500 });
    });

    const client = await connectMcpClient(accessToken);
    const result = await client.callTool({
      name: "get_current_user",
      arguments: {},
    });

    expect(result).toMatchObject({
      isError: true,
      content: [
        expect.objectContaining({
          type: "text",
          text: expect.stringContaining("PocketCircle error: insufficient_scope"),
        }),
      ],
    });
    await client.close();
  });
});
