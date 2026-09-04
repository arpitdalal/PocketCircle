import { describe, expect, it } from "vitest";
import {
  evaluateClientRegistrationPolicy,
  isAllowedDcrRedirectUri,
} from "./client-registration-policy.js";

describe("isAllowedDcrRedirectUri", () => {
  it("allows https and loopback http", () => {
    expect(isAllowedDcrRedirectUri("https://www.cursor.com/agents/mcp/oauth/callback")).toBe(true);
    expect(isAllowedDcrRedirectUri("http://localhost:8787/callback")).toBe(true);
    expect(isAllowedDcrRedirectUri("http://127.0.0.1:3000/cb")).toBe(true);
    expect(isAllowedDcrRedirectUri("http://[::1]/callback")).toBe(true);
  });

  it("rejects dangerous schemes and non-loopback http", () => {
    expect(isAllowedDcrRedirectUri("javascript:alert(1)")).toBe(false);
    expect(isAllowedDcrRedirectUri("data:text/html,hi")).toBe(false);
    expect(isAllowedDcrRedirectUri("http://evil.example/callback")).toBe(false);
    expect(isAllowedDcrRedirectUri("http://192.168.1.1/callback")).toBe(false);
    expect(isAllowedDcrRedirectUri("not-a-url")).toBe(false);
  });
});

describe("evaluateClientRegistrationPolicy", () => {
  it("allows Cursor-like redirect sets", () => {
    expect(
      evaluateClientRegistrationPolicy({
        redirect_uris: [
          "http://localhost:8787/callback",
          "https://www.cursor.com/agents/mcp/oauth/callback",
        ],
      }),
    ).toBeUndefined();
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
