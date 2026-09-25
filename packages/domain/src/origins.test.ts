import { describe, expect, it } from "vitest";
import {
  APEX_HOSTNAME,
  APEX_ORIGIN,
  APP_HOSTNAME,
  APP_ORIGIN,
  isLoopbackHostname,
  LOCAL_APP_HOSTNAME,
  LOCAL_APP_ORIGIN,
  LOCAL_APP_PORT,
  LOOPBACK_HOSTNAMES,
  loopbackTrustedOrigins,
  MCP_HOSTNAME,
  MCP_ISSUER,
  MCP_ORIGIN,
  MCP_RESOURCE_URI,
} from "./origins.js";

describe("canonical origins", () => {
  it("derives every production origin from the apex hostname", () => {
    expect(APEX_ORIGIN).toBe(`https://${APEX_HOSTNAME}`);
    expect(APP_ORIGIN).toBe(`https://${APP_HOSTNAME}`);
    expect(MCP_ORIGIN).toBe(`https://${MCP_HOSTNAME}`);
  });

  it("derives the MCP OAuth identifiers from the MCP origin", () => {
    expect(MCP_ISSUER).toBe(MCP_ORIGIN);
    expect(MCP_RESOURCE_URI).toBe(`${MCP_ORIGIN}/mcp`);
  });

  it("derives the local app origin from the local host and port", () => {
    expect(LOCAL_APP_ORIGIN).toBe(`http://${LOCAL_APP_HOSTNAME}:${LOCAL_APP_PORT}`);
    expect(isLoopbackHostname(LOCAL_APP_HOSTNAME)).toBe(true);
  });
});

describe("isLoopbackHostname", () => {
  it("covers both loopback names and both IPv6 spellings", () => {
    for (const hostname of LOOPBACK_HOSTNAMES) {
      expect(isLoopbackHostname(hostname)).toBe(true);
    }
    expect(isLoopbackHostname(APEX_HOSTNAME)).toBe(false);
    expect(isLoopbackHostname("127.0.0.2")).toBe(false);
  });
});

describe("loopbackTrustedOrigins", () => {
  it("widens a loopback origin to its 127.0.0.1/localhost twin, keeping scheme and port", () => {
    const [ipOrigin, nameOrigin] = loopbackTrustedOrigins(LOCAL_APP_ORIGIN);
    expect(ipOrigin).toBe(LOCAL_APP_ORIGIN);
    expect(nameOrigin).toBe(LOCAL_APP_ORIGIN.replace(LOCAL_APP_HOSTNAME, "localhost"));
    expect(loopbackTrustedOrigins(nameOrigin ?? "")).toEqual([nameOrigin, ipOrigin]);
  });

  it("trusts a deployed origin only as itself", () => {
    expect(loopbackTrustedOrigins(APP_ORIGIN)).toEqual([APP_ORIGIN]);
    expect(loopbackTrustedOrigins("https://app.example.com")).toEqual(["https://app.example.com"]);
  });

  it("normalizes the origin it is given and throws on an unparseable one", () => {
    const twin = loopbackTrustedOrigins(LOCAL_APP_ORIGIN).at(1) ?? "unused";
    expect(loopbackTrustedOrigins(`${twin}/circles?x=1`)).toEqual(loopbackTrustedOrigins(twin));
    expect(() => loopbackTrustedOrigins("not a url")).toThrow();
  });
});
