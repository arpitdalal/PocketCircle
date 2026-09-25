import { MCP_HOSTNAME, MCP_ORIGIN } from "@pocketcircle/domain";
import { describe, expect, it } from "vitest";
import { publicWorkerOrigin, requestOrigin, requestWithPublicOrigin } from "./reachable.js";

/**
 * What local `wrangler` does to a request: the URL comes back rewritten to the
 * `custom_domain` route while the client still dialed the loopback Worker.
 */
const REMAPPED_URL = `http://${MCP_HOSTNAME}`;
const DIALED_ORIGIN = "http://127.0.0.1:8787";

describe("requestOrigin", () => {
  it("uses the request URL origin by default", () => {
    const request = new Request(`${MCP_ORIGIN}/mcp`);
    expect(requestOrigin(request)).toBe(MCP_ORIGIN);
  });

  it("prefers a loopback Host over a custom-domain-rewritten URL", () => {
    const request = new Request(`${REMAPPED_URL}/.well-known/oauth-protected-resource`, {
      headers: { Host: "127.0.0.1:8787" },
    });
    expect(requestOrigin(request)).toBe(DIALED_ORIGIN);
  });

  it("ignores a non-loopback Host that disagrees with the URL", () => {
    const request = new Request(`${MCP_ORIGIN}/mcp`, {
      headers: { Host: "evil.example" },
    });
    expect(requestOrigin(request)).toBe(MCP_ORIGIN);
  });
});

describe("requestWithPublicOrigin", () => {
  it("rewrites the request URL when Host is loopback", () => {
    const request = new Request(`${REMAPPED_URL}/oauth/register`, {
      method: "POST",
      headers: { Host: "127.0.0.1:8787", "content-type": "application/json" },
      body: "{}",
    });
    const rewritten = requestWithPublicOrigin(request);
    expect(rewritten.url).toBe(`${DIALED_ORIGIN}/oauth/register`);
    expect(rewritten.method).toBe("POST");
    expect(rewritten.headers.get("content-type")).toBe("application/json");
  });

  it("returns the same request when origins already match", () => {
    const request = new Request(`${DIALED_ORIGIN}/mcp`, {
      headers: { Host: "127.0.0.1:8787" },
    });
    expect(requestWithPublicOrigin(request)).toBe(request);
  });

  it("honors an explicit public origin override (MCP_ISSUER)", () => {
    const request = new Request(`${REMAPPED_URL}/mcp`, {
      headers: { Host: MCP_HOSTNAME },
    });
    const rewritten = requestWithPublicOrigin(request, DIALED_ORIGIN);
    expect(rewritten.url).toBe(`${DIALED_ORIGIN}/mcp`);
  });
});

describe("publicWorkerOrigin", () => {
  it("prefers MCP_ISSUER when wrangler remapped Host", () => {
    const request = new Request(`${REMAPPED_URL}/mcp`, {
      headers: { Host: MCP_HOSTNAME },
    });
    const env = { MCP_ISSUER: DIALED_ORIGIN };
    expect(publicWorkerOrigin(env, request)).toBe(DIALED_ORIGIN);
  });
});
