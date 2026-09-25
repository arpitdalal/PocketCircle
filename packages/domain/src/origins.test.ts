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
  LOCAL_APP_TWIN_ORIGIN,
  LOOPBACK_HOSTNAMES,
  loopbackTrustedOrigins,
  MCP_HOSTNAME,
  MCP_ORIGIN,
  MCP_RESOURCE_URI,
} from "./origins.js";

describe("canonical origins", () => {
  it("derives every production origin from the apex hostname", () => {
    expect(APEX_ORIGIN).toBe(`https://${APEX_HOSTNAME}`);
    expect(APP_ORIGIN).toBe(`https://${APP_HOSTNAME}`);
    expect(MCP_ORIGIN).toBe(`https://${MCP_HOSTNAME}`);
    expect(MCP_RESOURCE_URI).toBe(`${MCP_ORIGIN}/mcp`);
  });

  it("derives the local app origin and its twin from the local host and port", () => {
    expect(LOCAL_APP_ORIGIN).toBe(`http://${LOCAL_APP_HOSTNAME}:${LOCAL_APP_PORT}`);
    expect(isLoopbackHostname(LOCAL_APP_HOSTNAME)).toBe(true);
    expect(LOCAL_APP_TWIN_ORIGIN).toBe(
      LOCAL_APP_ORIGIN.replace(LOCAL_APP_HOSTNAME, LOOPBACK_TWIN_HOSTNAME),
    );
  });
});

/** The other name for this machine, spelled out so the derivation above is a real check. */
const LOOPBACK_TWIN_HOSTNAME = "localhost";

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
  it("widens a loopback origin to its twin, keeping scheme and port", () => {
    expect(loopbackTrustedOrigins(LOCAL_APP_ORIGIN)).toEqual([
      LOCAL_APP_ORIGIN,
      LOCAL_APP_TWIN_ORIGIN,
    ]);
    expect(loopbackTrustedOrigins(LOCAL_APP_TWIN_ORIGIN)).toEqual([
      LOCAL_APP_TWIN_ORIGIN,
      LOCAL_APP_ORIGIN,
    ]);
  });

  it("trusts a deployed origin only as itself", () => {
    expect(loopbackTrustedOrigins(APP_ORIGIN)).toEqual([APP_ORIGIN]);
    expect(loopbackTrustedOrigins("https://app.example.com")).toEqual(["https://app.example.com"]);
  });

  it("normalizes the origin it is given and throws on an unparseable one", () => {
    expect(loopbackTrustedOrigins(`${LOCAL_APP_TWIN_ORIGIN}/circles?x=1`)).toEqual([
      LOCAL_APP_TWIN_ORIGIN,
      LOCAL_APP_ORIGIN,
    ]);
    expect(() => loopbackTrustedOrigins("not a url")).toThrow();
  });
});
