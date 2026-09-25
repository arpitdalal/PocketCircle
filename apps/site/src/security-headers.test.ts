import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { siteSecurityHeaders } from "./security-headers.js";

/** The policy file both Workers derive their headers from. */
const productHeaders = readFileSync(
  join(import.meta.dirname, "../../web-app/public/_headers"),
  "utf8",
);

const siteHeaders = siteSecurityHeaders(productHeaders);

describe("the Site's security headers", () => {
  it("carry the product's global rule, header for header", () => {
    expect(siteHeaders).toContain(productHeaders.slice(0, productHeaders.indexOf("\n\n")));
  });

  it("do not carry the product's rules for files the Site does not have", () => {
    // `/push-sw.js` is a product asset. A rule for it would match nothing here.
    expect(siteHeaders).not.toContain("push-sw");
  });

  it("keep the staging hostname out of search results", () => {
    // The Site lives on `workers.dev` until the apex cutover; the apex must not
    // inherit this. `deploy.yml` asserts it on the deployed origin.
    expect(siteHeaders).toContain("X-Robots-Tag: noindex");
  });

  it("fail loudly rather than publish a Site with no headers", () => {
    expect(() => siteSecurityHeaders("/assets/*\n  Cache-Control: public\n")).toThrow("no /* rule");
  });
});
