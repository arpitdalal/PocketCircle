import { describe, expect, it } from "vitest";
import {
  evaluateClientRegistrationPolicy,
  isAllowedDcrRedirectUri,
  parseAllowedCustomRedirectSchemes,
} from "./client-registration-policy.js";

describe("parseAllowedCustomRedirectSchemes", () => {
  it("parses comma-separated schemes and drops denylist / invalid tokens", () => {
    expect(
      [...parseAllowedCustomRedirectSchemes("cursor, vscode, javascript, ,Bad_Scheme")].sort(),
    ).toEqual(["cursor", "vscode"]);
    expect(parseAllowedCustomRedirectSchemes(undefined).size).toBe(0);
    expect(parseAllowedCustomRedirectSchemes("cursor:").has("cursor")).toBe(true);
  });
});

describe("isAllowedDcrRedirectUri", () => {
  it("allows https and loopback http without a custom allowlist", () => {
    expect(isAllowedDcrRedirectUri("https://www.cursor.com/agents/mcp/oauth/callback")).toBe(true);
    expect(isAllowedDcrRedirectUri("http://localhost:8787/callback")).toBe(true);
    expect(isAllowedDcrRedirectUri("http://127.0.0.1:3000/cb")).toBe(true);
    expect(isAllowedDcrRedirectUri("http://[::1]/callback")).toBe(true);
  });

  it("allows configured custom schemes only", () => {
    const allowed = parseAllowedCustomRedirectSchemes("cursor,vscode");
    expect(isAllowedDcrRedirectUri("cursor://anysphere.cursor-mcp/oauth/callback", allowed)).toBe(
      true,
    );
    expect(isAllowedDcrRedirectUri("vscode://vscode.github-authentication/callback", allowed)).toBe(
      true,
    );
    expect(isAllowedDcrRedirectUri("cursor://anysphere.cursor-mcp/oauth/callback")).toBe(false);
    expect(isAllowedDcrRedirectUri("claude://callback", allowed)).toBe(false);
  });

  it("rejects dangerous schemes and non-loopback http", () => {
    const allowed = parseAllowedCustomRedirectSchemes("cursor,javascript");
    expect(isAllowedDcrRedirectUri("javascript:alert(1)", allowed)).toBe(false);
    expect(isAllowedDcrRedirectUri("data:text/html,hi", allowed)).toBe(false);
    expect(isAllowedDcrRedirectUri("http://evil.example/callback")).toBe(false);
    expect(isAllowedDcrRedirectUri("http://192.168.1.1/callback")).toBe(false);
    expect(isAllowedDcrRedirectUri("not-a-url")).toBe(false);
    expect(isAllowedDcrRedirectUri("cursor:", allowed)).toBe(false);
  });
});

describe("evaluateClientRegistrationPolicy", () => {
  it("allows Cursor-like redirect sets when cursor is allowlisted", () => {
    expect(
      evaluateClientRegistrationPolicy(
        {
          redirect_uris: [
            "cursor://anysphere.cursor-mcp/oauth/callback",
            "http://localhost:8787/callback",
            "https://www.cursor.com/agents/mcp/oauth/callback",
          ],
        },
        { allowedCustomSchemes: parseAllowedCustomRedirectSchemes("cursor") },
      ),
    ).toBeUndefined();
  });

  it("rejects custom schemes when the allowlist is empty", () => {
    expect(
      evaluateClientRegistrationPolicy({
        redirect_uris: ["cursor://anysphere.cursor-mcp/oauth/callback"],
      }),
    ).toMatchObject({ code: "invalid_client_metadata", status: 400 });
  });

  it("rejects missing, unsafe, or oversized redirect_uris", () => {
    expect(evaluateClientRegistrationPolicy({})).toMatchObject({
      code: "invalid_client_metadata",
      status: 400,
    });
    expect(
      evaluateClientRegistrationPolicy({ redirect_uris: ["http://evil.example/cb"] }),
    ).toMatchObject({ code: "invalid_client_metadata", status: 400 });
    expect(
      evaluateClientRegistrationPolicy({
        redirect_uris: Array.from({ length: 21 }, (_, i) => `https://client.example/cb/${i}`),
      }),
    ).toMatchObject({ code: "invalid_client_metadata", status: 400 });
  });
});
