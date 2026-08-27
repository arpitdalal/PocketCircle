import { describe, expect, it } from "vitest";
import { isMcpScope, mcpScopesInclude, normalizeMcpScopes } from "./mcp.js";

describe("normalizeMcpScopes", () => {
  it("dedupes, drops unknowns, and keeps stable MCP_SCOPES order", () => {
    expect(
      normalizeMcpScopes([
        "pocketcircle:write",
        "offline_access",
        "pocketcircle:read",
        "pocketcircle:write",
      ]),
    ).toEqual(["pocketcircle:read", "pocketcircle:write"]);
  });

  it("returns null when nothing valid remains", () => {
    expect(normalizeMcpScopes([])).toBeNull();
    expect(normalizeMcpScopes(["offline_access", "openid"])).toBeNull();
  });
});

describe("mcpScopesInclude / isMcpScope", () => {
  it("checks membership without implying write⊃read", () => {
    expect(isMcpScope("pocketcircle:read")).toBe(true);
    expect(isMcpScope("pocketcircle:manage")).toBe(false);
    expect(mcpScopesInclude(["pocketcircle:write"], "pocketcircle:write")).toBe(true);
    expect(mcpScopesInclude(["pocketcircle:write"], "pocketcircle:read")).toBe(false);
    expect(mcpScopesInclude(["pocketcircle:read", "pocketcircle:write"], "pocketcircle:read")).toBe(
      true,
    );
  });
});
