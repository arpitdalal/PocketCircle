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

  it("do not keep the apex out of search results", () => {
    // The Site carried `X-Robots-Tag: noindex` for its `workers.dev` staging
    // hostname and the cutover deleted it (#411). The apex is the indexable
    // marketing origin now, and a `noindex` there is a Google branding failure:
    // nothing else in the build or the deploy check would see it, because the
    // document is complete and correct and only its indexability changed.
    expect(siteHeaders).not.toContain("X-Robots-Tag");
    expect(siteHeaders).not.toMatch(/noindex/i);
  });

  it("publish no header of the Site's own, so the product's policy is the whole policy", () => {
    // One rule, the product's. A Site-only rule added later has to be justified
    // against this rather than appended, which is the point of deriving the file.
    expect(siteHeaders.trim().split(/\n\s*\n/)).toHaveLength(1);
  });

  it("fail loudly rather than publish a Site with no headers", () => {
    expect(() => siteSecurityHeaders("/assets/*\n  Cache-Control: public\n")).toThrow("no /* rule");
  });
});
