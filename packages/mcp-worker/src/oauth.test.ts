import { env, SELF } from "cloudflare:test";
import { getOAuthApi } from "@cloudflare/workers-oauth-provider";
import { verifyMcpHandoff } from "@pocketcircle/domain";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
  const created = await getOAuthApi(oauthProviderOptions(env), env).createClient({
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
});

describe("authorization handoff", () => {
  it("stores AuthRequest server-side and redirects to SPA with signed handoff", async () => {
    const response = await SELF.fetch(
      authorizeUrl({
        response_type: "code",
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        scope: "pocketcircle:read",
        state: "client-state-1",
        code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        code_challenge_method: "S256",
        resource: RESOURCE,
      }),
      { redirect: "manual" },
    );

    expect(response.status).toBe(302);
    const location = response.headers.get("Location");
    expect(location).toBeTruthy();
    const consent = new URL(location ?? "");
    expect(consent.origin).toBe("https://pocketcircle.app");
    expect(consent.pathname).toBe("/mcp/authorize");
    expect(consent.searchParams.get("handoff")).toBeTruthy();
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
    const start = await SELF.fetch(
      authorizeUrl({
        response_type: "code",
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        scope: "pocketcircle:read",
        state: "deny-me",
        code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        code_challenge_method: "S256",
        resource: RESOURCE,
      }),
      { redirect: "manual" },
    );
    const handoff = new URL(start.headers.get("Location") ?? "").searchParams.get("handoff");
    expect(handoff).toBeTruthy();

    const payload = await verifyMcpHandoff(handoff ?? "", HMAC_SECRET);
    expect(payload?.handoffId).toBeTruthy();

    const deny = await SELF.fetch("https://mcp.pocketcircle.app/authorize/deny", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handoffId: payload?.handoffId }),
    });
    expect(deny.status).toBe(200);
    const body: unknown = await deny.json();
    expect(body).toMatchObject({ redirectTo: expect.stringContaining("error=access_denied") });
    if (typeof body === "object" && body !== null && "redirectTo" in body) {
      const redirectTo = String(body.redirectTo);
      expect(redirectTo).toContain("state=deny-me");
      expect(redirectTo.startsWith(REDIRECT_URI)).toBe(true);
    }

    // Replaying deny fails — handoff consumed.
    const replay = await SELF.fetch("https://mcp.pocketcircle.app/authorize/deny", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ handoffId: payload?.handoffId }),
    });
    expect(replay.status).toBe(400);
  });

  it("lets exactly one of concurrent complete and deny consume the handoff", async () => {
    const start = await SELF.fetch(
      authorizeUrl({
        response_type: "code",
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        scope: "pocketcircle:read",
        state: "race-me",
        code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        code_challenge_method: "S256",
        resource: RESOURCE,
      }),
      { redirect: "manual" },
    );
    const handoff = new URL(start.headers.get("Location") ?? "").searchParams.get("handoff");
    const payload = await verifyMcpHandoff(handoff ?? "", HMAC_SECRET);
    expect(payload?.handoffId).toBeTruthy();

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
            handoffId: payload?.handoffId,
          },
        });
      }
      if (endpoint === "/mcp/activate-grant") {
        return Response.json({ ok: true });
      }
      return Response.json({ ok: false, error: "unexpected" }, { status: 500 });
    });

    const [complete, deny] = await Promise.all([
      SELF.fetch("https://mcp.pocketcircle.app/authorize/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approvalToken: "approval-token" }),
      }),
      SELF.fetch("https://mcp.pocketcircle.app/authorize/deny", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handoffId: payload?.handoffId }),
      }),
    ]);
    const statuses = [complete.status, deny.status];
    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    expect(statuses.filter((status) => status === 400)).toHaveLength(1);
  });

  it("complete rejects when Convex redeem fails (grant logic stays on Convex)", async () => {
    stubConvexFetch((endpoint) => {
      if (endpoint === "/mcp/redeem-approval") {
        return Response.json({ ok: false, error: "not_found" }, { status: 400 });
      }
      return Response.json({ ok: false, error: "unexpected" }, { status: 500 });
    });

    const complete = await SELF.fetch("https://mcp.pocketcircle.app/authorize/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approvalToken: "bogus-token" }),
    });
    expect(complete.status).toBe(400);
  });

  it("complete redeems via Convex then finishes OAuth against the stored AuthRequest", async () => {
    const start = await SELF.fetch(
      authorizeUrl({
        response_type: "code",
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        scope: "pocketcircle:read",
        state: "approve-me",
        code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        code_challenge_method: "S256",
        resource: RESOURCE,
      }),
      { redirect: "manual" },
    );
    const handoff = new URL(start.headers.get("Location") ?? "").searchParams.get("handoff");
    const payload = await verifyMcpHandoff(handoff ?? "", HMAC_SECRET);
    expect(payload?.handoffId).toBeTruthy();

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
            handoffId: payload?.handoffId,
          },
        });
      }
      if (endpoint === "/mcp/activate-grant") {
        return Response.json({ ok: true });
      }
      return Response.json({ ok: false, error: "unexpected" }, { status: 500 });
    });

    const complete = await SELF.fetch("https://mcp.pocketcircle.app/authorize/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approvalToken: "approval-token" }),
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
        return Response.json({ ok: true });
      }
      return Response.json({ ok: false, error: "unexpected" }, { status: 500 });
    });

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

    // Handoff consumed — second complete with same redeem cannot finish OAuth.
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
            handoffId: payload?.handoffId,
          },
        });
      }
      return Response.json({ ok: false, error: "unexpected" }, { status: 500 });
    });
    const replay = await SELF.fetch("https://mcp.pocketcircle.app/authorize/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approvalToken: "approval-token" }),
    });
    expect(replay.status).toBe(400);
  });

  it("complete rejects resource mismatch between handoff and redeemed grant", async () => {
    const start = await SELF.fetch(
      authorizeUrl({
        response_type: "code",
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        scope: "pocketcircle:read",
        state: "bad-resource",
        code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        code_challenge_method: "S256",
        resource: RESOURCE,
      }),
      { redirect: "manual" },
    );
    const handoff = new URL(start.headers.get("Location") ?? "").searchParams.get("handoff");
    const payload = await verifyMcpHandoff(handoff ?? "", HMAC_SECRET);

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
            handoffId: payload?.handoffId,
          },
        });
      }
      return Response.json({ ok: false, error: "unexpected" }, { status: 500 });
    });

    const complete = await SELF.fetch("https://mcp.pocketcircle.app/authorize/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approvalToken: "approval-token" }),
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
    const start = await SELF.fetch(
      authorizeUrl({
        response_type: "code",
        client_id: clientId,
        redirect_uri: REDIRECT_URI,
        scope: "pocketcircle:read",
        state: "mismatch",
        code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
        code_challenge_method: "S256",
        resource: RESOURCE,
      }),
      { redirect: "manual" },
    );
    const handoff = new URL(start.headers.get("Location") ?? "").searchParams.get("handoff");
    const payload = await verifyMcpHandoff(handoff ?? "", HMAC_SECRET);

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
            handoffId: payload?.handoffId,
            ...override,
          },
        });
      }
      return Response.json({ ok: false, error: "unexpected" }, { status: 500 });
    });

    const complete = await SELF.fetch("https://mcp.pocketcircle.app/authorize/complete", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ approvalToken: "approval-token" }),
    });
    expect(complete.status).toBe(400);
    expect(await complete.json()).toMatchObject({ error: "handoff_grant_mismatch" });
  });
});
