import { describe, expect, it } from "vitest";
import { publicWorkerOrigin, requestOrigin, requestWithPublicOrigin } from "./reachable.js";

describe("requestOrigin", () => {
  it("uses the request URL origin by default", () => {
    const request = new Request("https://mcp.pocketcircle.app/mcp");
    expect(requestOrigin(request)).toBe("https://mcp.pocketcircle.app");
  });

  it("prefers a loopback Host over a custom-domain-rewritten URL", () => {
    // wrangler local remaps request.url to the custom_domain route while the
    // client still dialed 127.0.0.1:8787 — Cursor requires those to match.
    const request = new Request(
      "http://mcp.pocketcircle.app/.well-known/oauth-protected-resource",
      {
        headers: { Host: "127.0.0.1:8787" },
      },
    );
    expect(requestOrigin(request)).toBe("http://127.0.0.1:8787");
  });

  it("ignores a non-loopback Host that disagrees with the URL", () => {
    const request = new Request("https://mcp.pocketcircle.app/mcp", {
      headers: { Host: "evil.example" },
    });
    expect(requestOrigin(request)).toBe("https://mcp.pocketcircle.app");
  });
});

describe("requestWithPublicOrigin", () => {
  it("rewrites the request URL when Host is loopback", () => {
    const request = new Request("http://mcp.pocketcircle.app/oauth/register", {
      method: "POST",
      headers: { Host: "127.0.0.1:8787", "content-type": "application/json" },
      body: "{}",
    });
    const rewritten = requestWithPublicOrigin(request);
    expect(rewritten.url).toBe("http://127.0.0.1:8787/oauth/register");
    expect(rewritten.method).toBe("POST");
    expect(rewritten.headers.get("content-type")).toBe("application/json");
  });

  it("returns the same request when origins already match", () => {
    const request = new Request("http://127.0.0.1:8787/mcp", {
      headers: { Host: "127.0.0.1:8787" },
    });
    expect(requestWithPublicOrigin(request)).toBe(request);
  });

  it("honors an explicit public origin override (MCP_ISSUER)", () => {
    const request = new Request("http://mcp.pocketcircle.app/mcp", {
      headers: { Host: "mcp.pocketcircle.app" },
    });
    const rewritten = requestWithPublicOrigin(request, "http://127.0.0.1:8787");
    expect(rewritten.url).toBe("http://127.0.0.1:8787/mcp");
  });
});

describe("publicWorkerOrigin", () => {
  it("prefers MCP_ISSUER when wrangler remapped Host", () => {
    const request = new Request("http://mcp.pocketcircle.app/mcp", {
      headers: { Host: "mcp.pocketcircle.app" },
    });
    const env = { MCP_ISSUER: "http://127.0.0.1:8787" };
    expect(publicWorkerOrigin(env, request)).toBe("http://127.0.0.1:8787");
  });
});
